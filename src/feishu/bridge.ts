import { z } from "zod";
import { createHash } from "node:crypto";
import type { ImageInput, Incoming } from "../contracts";
import { abortable } from "../process";
import { log } from "../log";
import { content, Event, type Content, type Message, type Resource } from "./message";

export interface FeishuPort {
  react(messageId: string, emoji: "GLANCE" | "DONE"): Promise<string>;
  unreact(messageId: string, reactionId: string): Promise<void>;
  reply(message: Message, text: string, uuid: string): Promise<void>;
  quote(id: string): Promise<Message | undefined>;
  image(resource: Resource, id: string, signal: AbortSignal): Promise<ImageInput>;
}
export interface EyesPort {
  submit(message: Incoming, signal: AbortSignal): Promise<string>;
  status(id: string, signal: AbortSignal): Promise<{ status: string; reply?: string }>;
  cancel(id: string, actor: { conversation: string; sender: string }): Promise<void>;
}
export type BridgeOptions = { appId: string; botId: string; budgetMs: number; limit: number; allowedChats: string[]; allowPrivate: boolean };
type Task = { message: Message; actor: string; sender: string; conversation: string; ref: string; controller: AbortController; ack?: string; job?: string; done?: Promise<void> };
type Recent = { time: number; value: Content };
const ErrorCode = z.object({ code: z.union([z.number(), z.string().regex(/^[A-Z_0-9-]{1,50}$/)]).optional() });

export class FeishuBridge {
  private seen = new Map<string, number>();
  private recent = new Map<string, Recent[]>();
  private tasks = new Map<string, Task>();
  private closed = false;
  constructor(private options: BridgeOptions, private feishu: FeishuPort, private eyes: EyesPort, private pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 2000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  })) {}

  // The official SDK requires event acknowledgement within three seconds.
  receive(input: unknown): void {
    if (this.closed) return;
    const parsed = Event.safeParse(input);
    if (!parsed.success) { log("feishu_event_ignored", { reason: "invalid_shape" }); return; }
    const { sender, message } = parsed.data;
    const openId = sender.sender_id?.open_id;
    if (sender.sender_type !== "user" || !openId || openId === this.options.botId) return;
    if (message.chat_type === "p2p" ? !this.options.allowPrivate : this.options.allowedChats.length && !this.options.allowedChats.includes(message.chat_id)) return;
    const now = Date.now();
    for (const [id, time] of this.seen) if (now - time > 1800_000 && !this.tasks.has(id)) this.seen.delete(id);
    if (this.seen.has(message.message_id)) return;
    if (this.seen.size >= 5000) { log("feishu_event_ignored", { reason: "dedup_capacity" }); return; }
    this.seen.set(message.message_id, now);
    const conversation = `feishu:${this.options.appId}:${message.chat_id}:${message.thread_id ?? "main"}`;
    const actorSender = `feishu:${openId}`;
    const actor = JSON.stringify([conversation, actorSender]);
    const task: Task = { message, actor, conversation, sender: actorSender, ref: crypto.randomUUID().replaceAll("-", "").slice(0, 12), controller: new AbortController() };
    let value: Content;
    try { value = content(message, this.options.botId); }
    catch { value = { text: "", images: [] }; }
    if (message.chat_type === "group" && !message.mentions.some(m => m.id.open_id === this.options.botId)) {
      this.remember(actor, value); return;
    }
    if (/^(?:\/?stop|停止|取消)$/i.test(value.text)) {
      const matches = [...this.tasks.values()].filter(t => t.actor === actor);
      for (const target of matches) target.controller.abort(new Error("User stopped"));
      if (!matches.length) void this.send(task, "目前没有你的正在处理的反馈。", "control").catch(() => log("feishu_reply_failed", { ref: task.ref, phase: "control" }));
      return;
    }
    if (this.tasks.size >= this.options.limit) {
      void this.send(task, `⚠️ 服务繁忙，请稍后重试。\n\n日志编号：${task.ref}`, "final").catch(() => log("feishu_reply_failed", { ref: task.ref, phase: "busy" }));
      return;
    }
    this.tasks.set(message.message_id, task);
    task.done = this.run(task, value).finally(() => this.tasks.delete(message.message_id));
  }

  private send(task: Task, text: string, phase: string) {
    const uuid = createHash("sha256").update(`${this.options.appId}:${task.message.message_id}:${phase}`).digest("hex").slice(0, 32);
    return this.feishu.reply(task.message, text, uuid);
  }
  private history(actor: string) {
    const now = Date.now();
    for (const [key, entries] of this.recent) {
      const fresh = entries.filter(e => now - e.time < 1800_000);
      if (fresh.length) this.recent.set(key, fresh); else this.recent.delete(key);
    }
    return this.recent.get(actor) ?? [];
  }
  private remember(actor: string, value: Content) {
    const entries = this.history(actor);
    if (!value.text && !value.images.length) return;
    this.recent.delete(actor);
    this.recent.set(actor, [...entries, { time: Date.now(), value: { ...value, text: value.text.slice(0, 6000) } }].slice(-6));
    while (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
  }
  private async run(task: Task, value: Content) {
    const signal = task.controller.signal;
    const timer = setTimeout(() => task.controller.abort(new Error("Task budget exhausted")), this.options.budgetMs);
    let reply = "", outcome = "failed";
    try {
      log("feishu_received", { ref: task.ref });
      task.ack = await this.feishu.react(task.message.message_id, "GLANCE").catch(error => {
        log("feishu_reaction_failed", { ref: task.ref, emoji: "GLANCE", code: ErrorCode.safeParse(error).data?.code });
        return undefined;
      });
      signal.throwIfAborted();
      const recent = this.history(task.actor);
      const history: Incoming["history"] = recent.map(e => ({ role: "user", text: e.value.text }));
      const resources = value.images.map(resource => ({ resource, context: "飞书当前消息截图" }));
      if (task.message.parent_id) {
        try {
          const quote = await abortable(this.feishu.quote(task.message.parent_id), signal);
          signal.throwIfAborted();
          if (!quote || quote.chat_id !== task.message.chat_id) throw new Error("Quote outside conversation");
          const quoted = content(quote, this.options.botId);
          history.push({ role: "quoted", text: quoted.text.slice(0, 6000) }); resources.push(...quoted.images.map(resource => ({ resource, context: "飞书明确引用的截图" })));
        } catch { history.push({ role: "quoted", text: "引用消息无法读取，不得声称已看过引用内容。" }); }
      }
      resources.push(...recent.flatMap(e => e.value.images.map(resource => ({ resource, context: "同一用户近期消息中的截图，可能与本次追问相关" }))));
      const unique = [...new Map(resources.map(r => [`${r.resource.messageId}:${r.resource.key}`, r])).values()].slice(0, 6);
      const images: ImageInput[] = [];
      let size = 0;
      for (const { resource, context } of unique) {
        signal.throwIfAborted();
        try {
          const image = await this.feishu.image(resource, `image_${images.length + 1}`, signal);
          size += Buffer.from(image.data, "base64").byteLength;
          if (size > 20_000_000) throw new Error("Image total limit");
          images.push({ ...image, context });
        } catch { history.push({ role: "quoted", text: "有截图无法读取，不得猜测图片内容，必要时请用户重发。" }); log("feishu_image_unavailable", { ref: task.ref }); }
      }
      signal.throwIfAborted();
      this.remember(task.actor, value);
      if (!value.text && !images.length) {
        reply = "请描述问题，或发送可读取的文字、图片或富文本消息。"; outcome = "needs_info";
      } else {
        task.job = await this.eyes.submit({ messageId: `feishu:${task.message.message_id}`, conversation: task.conversation, sender: task.sender, text: value.text, images, history: history.slice(-12) }, signal);
        log("feishu_accepted", { ref: task.ref, job: task.job });
        let failures = 0;
        while (true) {
          await this.pause(signal);
          let state: Awaited<ReturnType<EyesPort["status"]>>;
          try { state = await this.eyes.status(task.job, signal); failures = 0; }
          catch (error) { if (signal.aborted || ++failures >= 3) throw error; continue; }
          if (["completed", "failed", "cancelled"].includes(state.status)) {
            reply = state.reply || "本次处理结束，但没有可发送的结果。"; outcome = state.status; break;
          }
        }
      }
    } catch (error) {
      log("feishu_task_failed", { ref: task.ref, job: task.job, type: error instanceof Error ? error.name : "Unknown", code: ErrorCode.safeParse(error).data?.code });
      if (signal.aborted) {
        outcome = signal.reason instanceof Error && signal.reason.message === "User stopped" ? "cancelled" : "timeout";
        reply = outcome === "cancelled" ? "⏹️ 已停止本次处理。" : "⏱️ 处理超时，已请求停止。";
      } else reply = "⚠️ 暂时无法取得处理结果，请稍后重试。";
      if (task.job) await this.eyes.cancel(task.job, task).catch(() => log("feishu_cancel_failed", { ref: task.ref, job: task.job }));
    } finally { clearTimeout(timer); }
    await this.switchDone(task);
    try { await this.send(task, task.ack ? reply : `${reply}\n\n日志编号：${task.ref}`, "final"); }
    catch (error) { outcome = "reply_failed"; log("feishu_reply_failed", { ref: task.ref, job: task.job, code: ErrorCode.safeParse(error).data?.code }); }
    log("feishu_finished", { ref: task.ref, job: task.job, outcome });
  }
  private async switchDone(task: Task) {
    if (!task.ack) return;
    const done = await this.feishu.react(task.message.message_id, "DONE").catch(error => {
      log("feishu_reaction_failed", { ref: task.ref, emoji: "DONE", code: ErrorCode.safeParse(error).data?.code });
      return undefined;
    });
    if (!done) return;
    await this.feishu.unreact(task.message.message_id, task.ack).catch(error => log("feishu_reaction_failed", { ref: task.ref, emoji: "GLANCE", code: ErrorCode.safeParse(error).data?.code }));
  }
  async idle() { await Promise.all([...this.tasks.values()].map(t => t.done)); }
  async close() {
    this.closed = true;
    for (const task of this.tasks.values()) task.controller.abort(new Error("Service stopped"));
    await this.idle(); this.recent.clear(); this.seen.clear();
  }
}
