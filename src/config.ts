import path from "node:path";
import { z } from "zod";

export const Settings = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  githubToken: z.string().min(1),
  archiveMirror: z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; }, "Archive mirror must be an HTTPS prefix without credentials, query, or fragment").optional(),
  apiKey: z.string().min(1),
  bridgeToken: z.string().min(24),
  baseURL: z.string().url().default("https://open.bigmodel.cn/api/coding/paas/v4"),
  model: z.string().default("glm-5.3-flash"),
  port: z.coerce.number().int().min(0).max(65535).default(18080),
  budget: z.coerce.number().int().min(30).max(3000).default(1800),
  queueBudget: z.coerce.number().int().min(1).max(7200).default(1800),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
  queueLimit: z.coerce.number().int().min(1).max(100).default(20),
  tempRoot: z.string().default("/tmp/oryn-eyes"),
  sourceCacheRoot: z.string().min(1).optional(),
  sourceFetchTimeout: z.coerce.number().int().min(10).max(600).default(120),
  publish: z.boolean().default(true),
});
export type Settings = z.infer<typeof Settings>;
export const projectRoot = path.resolve(import.meta.dir, "..");
export function settingsFromEnv(): Settings {
  return Settings.parse({
    repository: process.env.ORYN_REPOSITORY || "YourTongji/YourTJ-Hub",
    githubToken: process.env.GITHUB_TOKEN,
    archiveMirror: process.env.ORYN_GITHUB_ARCHIVE_MIRROR || undefined,
    apiKey: process.env.ORYN_API_KEY,
    bridgeToken: process.env.ORYN_BRIDGE_TOKEN,
    baseURL: process.env.ORYN_BASE_URL,
    model: process.env.ORYN_MODEL,
    port: process.env.ORYN_PORT,
    budget: process.env.ORYN_BUDGET_SECONDS,
    queueBudget: process.env.ORYN_QUEUE_BUDGET_SECONDS,
    concurrency: process.env.ORYN_CONCURRENCY,
    queueLimit: process.env.ORYN_QUEUE_LIMIT,
    tempRoot: process.env.ORYN_TEMP_ROOT,
    sourceCacheRoot: process.env.ORYN_SOURCE_CACHE_ROOT || undefined,
    sourceFetchTimeout: process.env.ORYN_SOURCE_FETCH_TIMEOUT_SECONDS,
    publish: process.env.ORYN_PUBLISH !== "false",
  });
}
