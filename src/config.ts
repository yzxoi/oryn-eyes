import path from "node:path";
import { z } from "zod";

export const Settings = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  githubToken: z.string().min(1),
  apiKey: z.string().min(1),
  bridgeToken: z.string().min(24),
  baseURL: z.string().url().default("https://open.bigmodel.cn/api/coding/paas/v4"),
  model: z.string().default("glm-5.3-flash"),
  port: z.coerce.number().int().min(0).max(65535).default(18080),
  budget: z.coerce.number().int().min(30).max(3000).default(900),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
  queueLimit: z.coerce.number().int().min(1).max(100).default(20),
  tempRoot: z.string().default("/tmp/oryn-eyes"),
  publish: z.boolean().default(true),
});
export type Settings = z.infer<typeof Settings>;
export const projectRoot = path.resolve(import.meta.dir, "..");
export function settingsFromEnv(): Settings {
  return Settings.parse({
    repository: process.env.ORYN_REPOSITORY || "YourTongji/YourTJ-Hub",
    githubToken: process.env.GITHUB_TOKEN,
    apiKey: process.env.ORYN_API_KEY,
    bridgeToken: process.env.ORYN_BRIDGE_TOKEN,
    baseURL: process.env.ORYN_BASE_URL,
    model: process.env.ORYN_MODEL,
    port: process.env.ORYN_PORT,
    budget: process.env.ORYN_BUDGET_SECONDS,
    concurrency: process.env.ORYN_CONCURRENCY,
    queueLimit: process.env.ORYN_QUEUE_LIMIT,
    tempRoot: process.env.ORYN_TEMP_ROOT,
    publish: process.env.ORYN_PUBLISH !== "false",
  });
}
