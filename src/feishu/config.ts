import { z } from "zod";

export const FeishuSettings = z.object({
  appId: z.string().min(1), appSecret: z.string().min(1), bridgeToken: z.string().min(24),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  eyesURL: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  }, "Use HTTPS or a loopback HTTP Oryn URL").default("http://127.0.0.1:18080"),
  budgetMs: z.number().int().min(30_000).max(3_000_000).default(900_000),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  allowedChats: z.array(z.string()).default([]), allowPrivate: z.boolean().default(true),
});
export type FeishuSettings = z.infer<typeof FeishuSettings>;
export function feishuSettings(env = process.env) {
  return FeishuSettings.parse({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, bridgeToken: env.ORYN_BRIDGE_TOKEN,
    domain: env.FEISHU_DOMAIN, eyesURL: env.ORYN_EYES_URL,
    budgetMs: env.ORYN_EYES_BUDGET_SECONDS === undefined ? undefined : Number(env.ORYN_EYES_BUDGET_SECONDS) * 1000,
    limit: env.FEISHU_MAX_PENDING, allowedChats: env.FEISHU_ALLOWED_CHAT_IDS?.split(",").map(x => x.trim()).filter(Boolean), allowPrivate: env.FEISHU_ALLOW_PRIVATE !== "false" });
}
