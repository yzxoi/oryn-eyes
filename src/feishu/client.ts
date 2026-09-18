import * as Lark from "@larksuiteoapi/node-sdk";
import { z } from "zod";
import path from "node:path";
import { ImageInput } from "../contracts";
import { validateImage } from "../images";
import { command, abortable } from "../process";
import { log } from "../log";
import { Message, type Resource } from "./message";
import type { FeishuPort } from "./bridge";
import type { FeishuSettings } from "./config";

Lark.defaultHttpInstance.defaults.timeout = 20_000;

// SDK errors may contain authenticated Axios requests; keep only severity in logs.
export const sdkLogger = { error: () => log("feishu_sdk_error"), warn: () => log("feishu_sdk_warning"), info: () => {}, debug: () => {}, trace: () => {} };
export function sdkOptions(settings: FeishuSettings) {
  return { appId: settings.appId, appSecret: settings.appSecret, domain: settings.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu, logger: sdkLogger, loggerLevel: Lark.LoggerLevel.warn };
}
const Envelope = z.object({ code: z.number(), bot: z.object({ open_id: z.string() }).optional() });
export class FeishuClient implements FeishuPort {
  readonly client: Lark.Client;
  constructor(settings: FeishuSettings) { this.client = new Lark.Client(sdkOptions(settings)); }
  async identity() {
    const response = Envelope.parse(await this.client.request<unknown>({ url: "/open-apis/bot/v3/info", method: "GET", timeout: 20_000 }));
    if (response.code !== 0 || !response.bot) throw Object.assign(new Error("Bot identity API failed"), { code: response.code });
    return response.bot.open_id;
  }
  async reply(message: Message, text: string, uuid: string) {
    const response = await this.client.im.message.reply({ path: { message_id: message.message_id }, data: { content: JSON.stringify({ text }), msg_type: "text", uuid, reply_in_thread: Boolean(message.thread_id) } });
    if (response.code !== 0) throw Object.assign(new Error("Feishu reply failed"), { code: response.code });
  }
  async react(messageId: string, emoji: "GLANCE" | "DONE") {
    const response = await this.client.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } });
    const reactionId = response.data?.reaction_id;
    if (response.code !== 0 || !reactionId) throw Object.assign(new Error("Feishu reaction failed"), { code: response.code });
    return reactionId;
  }
  async unreact(messageId: string, reactionId: string) {
    const response = await this.client.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
    if (response.code !== 0) throw Object.assign(new Error("Feishu reaction removal failed"), { code: response.code });
  }
  async quote(id: string) {
    const response = await this.client.im.message.get({ path: { message_id: id } });
    if (response.code !== 0) throw Object.assign(new Error("Feishu quote failed"), { code: response.code });
    const item = response.data?.items?.find(m => m.message_id === id);
    if (!item || item.deleted || !item.body?.content) return undefined;
    return Message.parse({ ...item, chat_type: "group", message_type: item.msg_type, content: item.body.content, mentions: [] });
  }
  async image(resource: Resource, id: string, signal: AbortSignal) {
    const response = await this.client.im.messageResource.get({ path: { message_id: resource.messageId, file_key: resource.key }, params: { type: "image" } });
    const stream = response.getReadableStream();
    const stop = () => stream.destroy(new Error("Image download stopped"));
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 20_000);
    try {
      const reading = (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 8_000_000) throw new Error("Screenshot exceeds 8 MB");
          chunks.push(bytes);
        }
        return Buffer.concat(chunks);
      })();
      const bytes = await abortable(reading, signal);
      const output = await command([process.env.ORYN_PYTHON || "python3", path.resolve(import.meta.dir, "../../script/normalize-image.py")], { stdin: bytes, timeoutMs: 20_000, signal });
      const image = ImageInput.parse({ ...JSON.parse(output), id, context: "飞书当前消息、明确引用或同一用户近期截图" });
      validateImage(image); return image;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); stream.destroy(); }
  }
}
