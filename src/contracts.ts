import { createHash } from "node:crypto";
import { z } from "zod";

export const ImageInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data: z.string().max(6_000_000),
  context: z.string().max(200).default("current message"),
});
export type ImageInput = z.infer<typeof ImageInput>;
export const History = z.object({
  role: z.enum(["user", "assistant", "quoted"]),
  text: z.string().max(6000),
});
export const Incoming = z.object({
  messageId: z.string().min(1).max(200),
  conversation: z.string().min(1).max(300),
  sender: z.string().min(1).max(200),
  text: z.string().max(16000).default(""),
  images: z.array(ImageInput).max(6).default([]),
  history: z.array(History).max(12).default([]),
}).refine((x) => Boolean(x.text.trim() || x.images.length), "A message needs text or an image");
export type Incoming = z.infer<typeof Incoming>;

export const Fact = z.object({
  claim: z.string().min(1).max(1200),
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  quote: z.string().min(1).max(3000),
});
export type Fact = z.infer<typeof Fact>;
export const IssueDraft = z.object({
  kind: z.enum(["bug", "feature", "docs"]),
  title: z.string().min(5).max(160),
  description: z.string().min(10).max(7000),
  environment: z.string().max(2000).default("用户未提供"),
  steps: z.array(z.string().max(1200)).max(15).default([]),
  expected: z.string().max(3000).default("用户未明确说明"),
  actual: z.string().max(3000).default("用户未明确说明"),
  facts: z.array(Fact).max(10).default([]),
  hypotheses: z.array(z.object({ module: z.string().max(300), reason: z.string().max(1500) })).max(8).default([]),
  unknowns: z.array(z.string().max(1000)).max(10).default([]),
  nextSteps: z.array(z.string().max(1000)).max(10).default([]),
  relatedIssues: z.array(z.number().int().positive()).max(8).default([]),
  screenshotIds: z.array(z.string().max(64)).max(6).default([]),
});
export type IssueDraft = z.infer<typeof IssueDraft>;
export const Analysis = z.object({
  action: z.enum(["qa", "needs_info", "known_issue", "create_issue"]),
  reply: z.string().min(1).max(6000),
  existingIssue: z.number().int().positive().optional(),
  issue: IssueDraft.optional(),
}).superRefine((v, ctx) => {
  if (v.action === "create_issue" && !v.issue) ctx.addIssue({ code: "custom", message: "create_issue requires issue" });
  if (v.action === "known_issue" && !v.existingIssue) ctx.addIssue({ code: "custom", message: "known_issue requires existingIssue" });
});
export type Analysis = z.infer<typeof Analysis>;
export function parseAnalysis(text: string): Analysis {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return Analysis.parse(JSON.parse(normalized)); } catch { /* Some providers wrap the final JSON in a prose preamble. */ }
  const candidates: Analysis[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (start < 0) { if (char === "{") { start = i; depth = 1; } continue; }
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) {
      try { candidates.push(Analysis.parse(JSON.parse(normalized.slice(start, i + 1)))); } catch { /* Ignore unrelated JSON objects. */ }
      start = -1;
    }
  }
  if (candidates.length !== 1) throw new Error(`Expected one valid support result, found ${candidates.length}`);
  return candidates[0]!;
}
export function messageKey(message: Incoming, repository: string) {
  return createHash("sha256").update(JSON.stringify([repository, message.conversation, message.messageId])).digest("hex");
}
