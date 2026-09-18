import { expect, test } from "bun:test";
import { FeishuBridge, type FeishuPort, type EyesPort, type BridgeOptions } from "../src/feishu/bridge";
import { Message, content } from "../src/feishu/message";
import { feishuSettings } from "../src/feishu/config";
import type { Incoming } from "../src/contracts";
import { EyesHTTP } from "../src/feishu/eyes";

function event(id = "om_test", text = "@_user_1 你好", sender = "ou_user", extra: Record<string, unknown> = {}) {
  return { sender: { sender_type: "user", sender_id: { open_id: sender } }, message: { message_id: id, chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Eyes" }], ...extra } };
}
function fixture(overrides: Partial<FeishuPort> = {}, eyesOverrides: Partial<EyesPort> = {}, pause?: (signal: AbortSignal) => Promise<void>) {
  const replies: { id: string; text: string; uuid: string }[] = [], submitted: Incoming[] = [], cancelled: string[] = [];
  const reactions: { id: string; emoji: string }[] = [], removed: string[] = [];
  const feishu: FeishuPort = {
    react: async (id, emoji) => { reactions.push({ id, emoji }); return `r_${reactions.length}`; },
    unreact: async (_id, reactionId) => { removed.push(reactionId); },
    reply: async (m, text, uuid) => { replies.push({ id: m.message_id, text, uuid }); },
    quote: async () => undefined,
    image: async (_r, id) => ({ id, data: "fixture", mime: "image/png", context: "fixture" }),
    ...overrides };
  const eyes: EyesPort = { submit: async m => { submitted.push(m); return "job"; }, status: async () => ({ status: "completed", reply: "结论" }), cancel: async id => { cancelled.push(id); }, ...eyesOverrides };
  const options: BridgeOptions = { appId: "cli_fixture", botId: "ou_bot", budgetMs: 10_000, limit: 20, allowedChats: [], allowPrivate: true };
  const bridge = new FeishuBridge(options, feishu, eyes, pause ?? (async signal => { signal.throwIfAborted(); }));
  return { bridge, replies, submitted, cancelled, reactions, removed, options };
}

test("Feishu acknowledges events synchronously, deduplicates and switches to the done reaction with one final reply", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let polls = 0;
  const f = fixture({}, { status: async () => { await blocked; return ++polls < 3 ? { status: "running" } : { status: "completed", reply: "结论" }; } });
  expect(f.bridge.receive(event())).toBeUndefined();
  f.bridge.receive(event());
  expect(f.reactions.map(r => r.emoji)).toEqual(["GLANCE"]);
  expect(f.replies).toHaveLength(0);
  release(); await f.bridge.idle();
  expect(f.submitted).toHaveLength(1);
  expect(f.submitted[0]!.text).toBe("你好");
  expect(f.submitted[0]!.conversation).toStartWith("feishu:cli_fixture:");
  expect(f.replies).toHaveLength(1);
  expect(f.replies[0]!.text).toBe("结论");
  expect(f.reactions.map(r => r.emoji)).toEqual(["GLANCE", "DONE"]);
  expect(f.removed).toEqual(["r_1"]);
  expect(f.replies[0]!.uuid).not.toBe("");
});

test("private messages trigger; other bots, unrelated mentions and disallowed chats do not", async () => {
  const f = fixture(); f.options.allowedChats.push("oc_allowed");
  f.bridge.receive(event());
  const bot = event("bot"); bot.sender.sender_type = "app"; f.bridge.receive(bot);
  f.bridge.receive(event("other", "other", "ou_user", { chat_id: "oc_allowed", mentions: [{ key: "x", id: { open_id: "ou_other" }, name: "Other" }] }));
  f.bridge.receive(event("dm", "私聊", "ou_user", { chat_type: "p2p", mentions: [] }));
  await f.bridge.idle(); expect(f.submitted.map(m => m.text)).toEqual(["私聊"]);
});

test("post text, links and image keys are normalized without fetching arbitrary URLs", () => {
  const message = Message.parse(event().message);
  message.message_type = "post";
  message.content = JSON.stringify({ zh_cn: { title: "报错", content: [[{ tag: "at", user_id: "ou_bot" }, { tag: "text", text: "无法登录" }, { tag: "a", text: "页面", href: "https://example.com" }, { tag: "img", image_key: "img_fixture" }]] } });
  expect(content(message, "ou_bot")).toEqual({ text: "报错\n无法登录页面 https://example.com", images: [{ messageId: "om_test", key: "img_fixture" }] });
});

test("images, same-sender context and explicit quotes are included; other sender context is excluded", async () => {
  const downloaded: string[] = [];
  const f = fixture({
    quote: async () => Message.parse(event("parent", "明确引用", "other", { message_type: "post", content: JSON.stringify({ content: [[{ tag: "text", text: "引用" }, { tag: "img", image_key: "quoted" }]] }) }).message),
    image: async (r, id) => { downloaded.push(r.key); return { id, mime: "image/png", data: "fixture", context: "fixture" }; },
  });
  f.bridge.receive(event("old", "之前的问题", "ou_user", { mentions: [] }));
  f.bridge.receive(event("unrelated", "别人的消息", "ou_other", { mentions: [] }));
  f.bridge.receive(event("current", "", "ou_user", { message_type: "image", content: JSON.stringify({ image_key: "current" }), parent_id: "parent" }));
  await f.bridge.idle();
  expect(downloaded).toEqual(["current", "quoted"]);
  expect(f.submitted[0]!.images).toHaveLength(2);
  expect(f.submitted[0]!.images.map(i => i.context)).toEqual(["飞书当前消息截图", "飞书明确引用的截图"]);
  expect(f.submitted[0]!.history.map(m => m.text)).toEqual(["之前的问题", "引用"]);
});

test("cross-chat quotes are not read into a task; unreadable image-only messages close with a single reply", async () => {
  const f = fixture({ quote: async () => Message.parse(event("parent", "secret", "other", { chat_id: "other_chat" }).message), image: async () => { throw new Error("unavailable"); } });
  f.bridge.receive(event("image", "", "ou_user", { message_type: "image", content: JSON.stringify({ image_key: "img" }), parent_id: "parent" }));
  await f.bridge.idle(); expect(f.submitted).toHaveLength(0); expect(f.replies).toHaveLength(1);
  expect(f.replies[0]!.text).not.toContain("secret");
});

test("stop cancels only the sender's tasks and closes each with its own reaction switch", async () => {
  let started!: () => void; const admitted = new Promise<void>(r => { started = r; });
  const f = fixture({}, { submit: async () => { started(); return "job"; } }, signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  }));
  f.bridge.receive(event()); await admitted; await Promise.resolve();
  f.bridge.receive(event("stop_other", "stop", "another"));
  expect(f.cancelled).toHaveLength(0);
  f.bridge.receive(event("stop", "stop")); await f.bridge.idle();
  expect(f.cancelled).toEqual(["job"]);
  expect(f.replies.filter(r => r.id === "om_test")).toHaveLength(1);
  expect(f.replies.at(-1)!.text).toContain("已停止");
  expect(f.reactions.filter(r => r.id === "om_test").map(r => r.emoji)).toEqual(["GLANCE", "DONE"]);
  expect(f.removed).toEqual(["r_1"]);
});

test("submission failures close with a single reply; backend timeout and redirects never leak credentials", async () => {
  const f = fixture({}, { submit: async () => { throw new Error("fixture private credential"); } });
  f.bridge.receive(event()); await f.bridge.idle();
  expect(f.replies).toHaveLength(1); expect(f.replies[0]!.text).not.toContain("private credential");
  const requests: RequestInit[] = [];
  const transport = (async (_url: unknown, options: RequestInit) => { requests.push(options); return Response.json({ id: "job" }); }) as typeof fetch;
  const http = new EyesHTTP("http://127.0.0.1:18080", "secret", transport);
  await http.submit({ messageId: "1", conversation: "c", sender: "s", text: "hello", images: [], history: [] }, new AbortController().signal);
  expect(requests[0]!.redirect).toBe("error"); expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
});

test("a failed acknowledgement reaction falls back to appending the log reference to the final reply", async () => {
  const f = fixture({ react: async () => { throw new Error("reaction rejected"); } });
  f.bridge.receive(event()); await f.bridge.idle();
  expect(f.replies).toHaveLength(1);
  expect(f.replies[0]!.text).toMatch(/^结论\n\n日志编号：[a-f0-9]{12}$/);
  expect(f.removed).toHaveLength(0);
});

test("remote Oryn transport requires HTTPS and Feishu configuration requires credentials", () => {
  expect(() => feishuSettings({})).toThrow();
  const env = { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "fixture", ORYN_BRIDGE_TOKEN: "fixture-token-long-enough" };
  expect(feishuSettings(env).domain).toBe("feishu");
  expect(() => feishuSettings({ ...env, ORYN_EYES_URL: "http://remote.example" })).toThrow();
  expect(feishuSettings({ ...env, FEISHU_DOMAIN: "lark", FEISHU_ALLOW_PRIVATE: "false" }).allowPrivate).toBe(false);
});

test("stop during admission retains the returned job ID and cancels it", async () => {
  let release!: (id: string) => void;
  let started!: () => void; const admission = new Promise<void>(r => { started = r; });
  const f = fixture({}, { submit: async () => { started(); return new Promise<string>(r => { release = r; }); } });
  f.bridge.receive(event()); await admission;
  f.bridge.receive(event("stop_admission", "stop")); release("late_job"); await f.bridge.idle();
  expect(f.cancelled).toEqual(["late_job"]);
  expect(f.replies).toHaveLength(1); expect(f.replies[0]!.text).toContain("已停止");
});

test("deadline cancels the backend and failed final delivery is not blindly resent", async () => {
  const f = fixture({}, {}, signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  f.options.budgetMs = 15;
  f.bridge.receive(event()); await f.bridge.idle();
  expect(f.cancelled).toEqual(["job"]); expect(f.replies[0]!.text).toContain("超时");
  let sends = 0;
  const bad = fixture({ reply: async () => { sends++; throw new Error("Ambiguous delivery"); } });
  bad.bridge.receive(event()); await bad.bridge.idle(); expect(sends).toBe(1);
});

test("context expires and stop during quote preparation does not submit a model task", async () => {
  const { spyOn } = await import("bun:test");
  let now = 1_000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = fixture(); f.bridge.receive(event("past", "old context", "ou_user", { mentions: [] }));
    now += 1800_001; f.bridge.receive(event()); await f.bridge.idle(); expect(f.submitted[0]!.history).toEqual([]);
  } finally { clock.mockRestore(); }
  let quoted!: () => void; const started = new Promise<void>(r => { quoted = r; });
  const f = fixture({ quote: async () => { quoted(); return new Promise(() => {}); } });
  f.bridge.receive(event("current", "现在", "ou_user", { parent_id: "parent" })); await started;
  f.bridge.receive(event("stop_prepare", "stop")); await f.bridge.idle();
  expect(f.submitted).toHaveLength(0); expect(f.replies[0]!.text).toContain("已停止");
});
