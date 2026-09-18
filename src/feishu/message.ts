import { z } from "zod";

const ID = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const Message = z.object({
  message_id: ID, chat_id: ID, chat_type: z.enum(["p2p", "group"]),
  message_type: z.string(), content: z.string().max(100_000),
  parent_id: ID.optional(), root_id: ID.optional(), thread_id: ID.optional(),
  mentions: z.array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }), name: z.string() })).default([]),
});
export type Message = z.infer<typeof Message>;
export const Event = z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: ID.optional() }).optional() }),
  message: Message,
});
export type Resource = { messageId: string; key: string };
export type Content = { text: string; images: Resource[] };
const Post = z.object({ title: z.string().optional(), content: z.array(z.array(z.object({ tag: z.string(), text: z.string().optional(), href: z.string().optional(), image_key: z.string().optional(), user_id: z.string().optional() }))) });

export function content(message: Message, botId: string): Content {
  const body: unknown = JSON.parse(message.content);
  const images: Resource[] = [];
  let text = "";
  if (message.message_type === "text") text = z.object({ text: z.string() }).parse(body).text;
  else if (message.message_type === "image") images.push({ messageId: message.message_id, key: z.object({ image_key: ID }).parse(body).image_key });
  else if (message.message_type === "post") {
    const local = z.record(z.string(), z.unknown()).parse(body);
    const post = Post.parse(local.content ? local : local.zh_cn ?? local.en_us ?? Object.values(local)[0]);
    text = [post.title ?? "", ...post.content.map(row => row.map(part => {
      if (part.tag === "img" && part.image_key) images.push({ messageId: message.message_id, key: ID.parse(part.image_key) });
      if (part.tag === "at") return part.user_id === botId ? "" : "@用户";
      if (part.tag === "a") return `${part.text ?? ""} ${part.href ?? ""}`;
      return part.text ?? "";
    }).join(""))].join("\n");
  }
  for (const mention of message.mentions) text = text.replaceAll(mention.key, mention.id.open_id === botId ? "" : `@${mention.name}`);
  return { text: text.trim().slice(0, 16000), images: images.slice(0, 6) };
}
