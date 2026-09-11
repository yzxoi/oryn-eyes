import { z } from "zod";

const count = z.number().int().min(0).max(1_000_000_000);
export const Progress = z
  .object({
    event: z.literal("harness_progress"),
    elapsedSeconds: count,
    formatAttempt: z.number().int().min(0).max(2),
    assistantMessages: count,
    completedAssistantMessages: count,
    failedAssistantMessages: count,
    assistantTextCharacters: count,
    compactions: count,
    retryAttempt: count,
    waitingBackground: z.number().int().min(0).max(1),
    toolCalls: count,
    activeTools: count,
    completedTools: count,
    failedTools: count,
    reasoningCharacters: count,
  })
  .strict();
const Messages = z.array(
  z.object({
    info: z.object({
      role: z.string(),
      finish: z.string().optional(),
      error: z.unknown().optional(),
    }),
    parts: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        state: z.object({ status: z.string() }).optional(),
      }),
    ),
  }),
);

export function summarizeProgress(
  value: unknown,
  elapsedSeconds: number,
  formatAttempt: number,
  runtime?: unknown,
) {
  const state = z
    .object({
      status: z.object({ type: z.string(), attempt: count.optional() }),
      executionPhase: z.string().optional(),
    })
    .optional()
    .parse(runtime);
  const messages = Messages.parse(value);
  const assistants = messages.filter(
    (message) => message.info.role === "assistant",
  );
  const parts = assistants.flatMap((message) => message.parts);
  const tools = parts.filter((part) => part.type === "tool");
  return Progress.parse({
    event: "harness_progress",
    elapsedSeconds,
    formatAttempt,
    retryAttempt:
      state?.status.type === "retry" ? (state.status.attempt ?? 0) : 0,
    waitingBackground: state?.executionPhase === "waiting_background" ? 1 : 0,
    assistantMessages: assistants.length,
    compactions: messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "compaction").length,
    completedAssistantMessages: assistants.filter(
      (message) => message.info.finish,
    ).length,
    failedAssistantMessages: assistants.filter(
      (message) => message.info.error != null,
    ).length,
    assistantTextCharacters: parts
      .filter((part) => part.type === "text")
      .reduce((total, part) => total + (part.text?.length ?? 0), 0),
    toolCalls: tools.length,
    activeTools: tools.filter((part) =>
      ["pending", "running"].includes(part.state?.status ?? ""),
    ).length,
    completedTools: tools.filter((part) => part.state?.status === "completed")
      .length,
    failedTools: tools.filter((part) => part.state?.status === "error").length,
    reasoningCharacters: parts
      .filter((part) => part.type === "reasoning")
      .reduce((total, part) => total + (part.text?.length ?? 0), 0),
  });
}

export function parseProgress(line: string) {
  if (line.length > 2000) return;
  try {
    const result = Progress.safeParse(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}
