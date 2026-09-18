import { expect, spyOn, test } from "bun:test";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Readable } from "node:stream";
import { FeishuClient, sdkLogger } from "../src/feishu/client";
import { FeishuSettings } from "../src/feishu/config";
import { Message } from "../src/feishu/message";
import { command } from "../src/process";

test("official Feishu dispatcher acknowledges without waiting for background work", async () => {
  let handled = false;
  const dispatcher = new Lark.EventDispatcher({ logger: sdkLogger }).register({ "im.message.receive_v1": () => { handled = true; } });
  await dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1", event_id: "event" }, event: { sender: { sender_type: "user" }, message: { message_id: "om_fixture" } } });
  expect(handled).toBe(true);
});

test("official SDK identity, reply and authenticated resource download pass through the adapter", async () => {
  const client = new FeishuClient(FeishuSettings.parse({ appId: "cli_wire_fixture", appSecret: "fixture-secret", bridgeToken: "fixture-bridge-token-long-enough" }));
  const encoded = await command([process.env.ORYN_PYTHON || "python3", "-c", 'import io,base64; from PIL import Image; b=io.BytesIO(); im=Image.new("RGB",(32,32),"blue"); im.save(b,format="PNG"); print(base64.b64encode(b.getvalue()).decode())']);
  const requests: { url?: string; params?: unknown; data?: unknown; headers?: unknown }[] = [];
  const token = spyOn(client.client.httpInstance, "post").mockResolvedValue({ code: 0, tenant_access_token: "fixture-token", expire: 7200 });
  const request = spyOn(client.client.httpInstance, "request").mockImplementation((async options => {
    requests.push(options);
    if (options.url?.includes("tenant_access_token")) return { code: 0, tenant_access_token: "fixture-token", expire: 7200 };
    if (options.url?.endsWith("/bot/v3/info")) return { code: 0, bot: { open_id: "ou_bot" } };
    if (options.url?.endsWith("/reactions")) return { code: 0, data: { reaction_id: "r_fixture" } };
    if (options.url?.includes("/reactions/")) return { code: 0, data: { reaction_id: "r_fixture" } };
    if (options.url?.includes("/resources/")) return { data: Readable.from([Buffer.from(encoded, "base64")]), headers: { "content-type": "image/png" } };
    return { code: 0, data: { message_id: "om_reply" } };
  }) as typeof client.client.httpInstance.request);
  try {
    expect(await client.identity()).toBe("ou_bot");
    const message = Message.parse({ message_id: "om_fixture", chat_id: "oc_fixture", chat_type: "group", message_type: "text", content: '{"text":"hello"}', thread_id: "omt_fixture" });
    await client.reply(message, "👁️ 收到", "stable-reply-id");
    const image = await client.image({ messageId: message.message_id, key: "img_fixture" }, "image_1", new AbortController().signal);
    expect(image.id).toBe("image_1"); expect(image.mime).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const reply = requests.find(r => r.url?.endsWith("/reply"));
    expect(reply?.data).toMatchObject({ uuid: "stable-reply-id", reply_in_thread: true, msg_type: "text" });
    const resource = requests.find(r => r.url?.includes("/resources/"));
    expect(resource?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_fixture/resources/img_fixture");
    expect(resource?.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
    expect(await client.react("om_fixture", "DONE")).toBe("r_fixture");
    await client.unreact("om_fixture", "r_fixture");
    const reaction = requests.find(r => r.url?.endsWith("/reactions"));
    expect(reaction?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_fixture/reactions");
    expect(reaction?.data).toMatchObject({ reaction_type: { emoji_type: "DONE" } });
    const removal = requests.find(r => r.url?.includes("/reactions/"));
    expect(removal?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_fixture/reactions/r_fixture");
  } finally { request.mockRestore(); token.mockRestore(); }
});
