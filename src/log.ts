export function log(event: string, metadata: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...metadata }));
}
export function safeError(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  return message.replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+)/g, "[redacted]").slice(0, 1600);
}
