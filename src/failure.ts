import { z } from "zod";
import { Progress } from "./progress";

const ErrorInfo = z
  .object({
    name: z.string().max(200).optional(),
    message: z.string().max(2000).optional(),
    code: z.union([z.string().max(200), z.number()]).optional(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean().optional(),
  })
  .strict();
export const Failure = z
  .object({
    version: z.literal(1),
    kind: z.enum([
      "job_timeout",
      "cancelled",
      "core_failed",
      "report_format",
      "worker_exit",
      "execution_error",
    ]),
    stage: z.enum(["setup", "core", "report", "worker", "host"]),
    error: ErrorInfo,
    causes: z.array(ErrorInfo).max(4).optional(),
    progress: Progress.optional(),
    collectionErrors: z.array(ErrorInfo).max(2).optional(),
    elapsedSeconds: z.number().nonnegative().optional(),
    formatAttempt: z.number().int().min(0).max(2).optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    limits: z
      .object({
        taskSeconds: z.number(),
        requestSeconds: z.number(),
        invokeSeconds: z.number(),
      })
      .strict()
      .optional(),
    core: z
      .object({
        status: z.string().max(80).optional(),
        recording: z.string().max(80).optional(),
        errors: z.array(ErrorInfo).max(12),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Failure = z.infer<typeof Failure>;
type Redaction = { secrets?: string[]; paths?: string[] };

function clean(text: string, options: Redaction = {}) {
  for (const secret of options.secrets ?? [])
    if (secret) text = text.replaceAll(secret, "[redacted]");
  for (const path of options.paths ?? [])
    if (path) text = text.replaceAll(path, "[temporary-path]");
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|authorization|secret)\s*[=:]\s*[^\s,;"']+/gi,
      "$1=[redacted]",
    )
    .replace(
      /(?:\/(?:Users|home|tmp|private|opt|var)\/|[A-Z]:\\)[^\s"'<>]+/g,
      "[temporary-path]",
    )
    .slice(0, 2000);
}

export function redactDiagnostic(
  value: unknown,
  options: Redaction = {},
): unknown {
  if (typeof value === "string") return clean(value, options);
  if (Array.isArray(value))
    return value.slice(0, 12).map((x) => redactDiagnostic(x, options));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDiagnostic(v, options)]),
    );
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function errors(
  value: unknown,
  depth = 0,
  options: Redaction = {},
): z.infer<typeof ErrorInfo>[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [{ message: clean(value, options) }];
  const source = record(value);
  const result = ErrorInfo.parse({
    ...(typeof source.name === "string"
      ? { name: clean(source.name, options).slice(0, 200) }
      : {}),
    ...(typeof source.message === "string"
      ? { message: clean(source.message, options) }
      : {}),
    ...(typeof source.code === "string" || typeof source.code === "number"
      ? {
          code:
            typeof source.code === "string"
              ? clean(source.code, options).slice(0, 200)
              : source.code,
        }
      : {}),
    ...(typeof source.statusCode === "number"
      ? { statusCode: source.statusCode }
      : {}),
    ...(typeof source.isRetryable === "boolean"
      ? { isRetryable: source.isRetryable }
      : {}),
  });
  return [
    result,
    ...errors(source.data, depth + 1, options),
    ...errors(source.cause, depth + 1, options),
  ].filter((x) => Object.keys(x).length);
}
export function coreFailureEvidence(
  run: unknown,
  messages: unknown,
  result?: unknown,
  options: Redaction = {},
) {
  const state = record(run);
  const found = (Array.isArray(messages) ? messages : []).flatMap((m) =>
    errors(record(record(m).info).error, 0, options),
  );
  const snapshots = record(result).snapshots;
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const key of ["attempts", "processes", "tools"]) {
      const list = record(snapshot)[key];
      for (const item of Array.isArray(list) ? list : [])
        found.push(...errors(record(item).error, 0, options));
    }
  }
  return {
    ...(typeof state.status === "string"
      ? { status: state.status.slice(0, 80) }
      : {}),
    ...(typeof state.recording === "string"
      ? { recording: state.recording.slice(0, 80) }
      : {}),
    errors: found.slice(-12),
  };
}
export function failureDiagnostic(
  kind: Failure["kind"],
  stage: Failure["stage"],
  error: unknown,
  options: Redaction = {},
  details: Partial<Omit<Failure, "version" | "kind" | "stage" | "error">> = {},
): Failure {
  const evidence = errors(error, 0, options);
  const info = evidence[0] ?? {
    message: "Execution failed without error details",
  };
  return Failure.parse(
    redactDiagnostic(
      {
        version: 1,
        kind,
        stage,
        error: info,
        causes: evidence.slice(1, 5),
        ...details,
      },
      options,
    ),
  );
}
export class HarnessFailure extends Error {
  constructor(readonly diagnostic: Failure) {
    super(
      `${diagnostic.kind}: ${diagnostic.error.message ?? diagnostic.error.name ?? "Harness failed"}`,
    );
    this.name = "HarnessFailure";
  }
}

export async function writeFailureArtifact(
  output: string,
  diagnostic?: Failure,
  exitCode?: number,
) {
  const { mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  await mkdir(output, { recursive: true });
  const file = path.join(output, "failure.json");
  const previous = await Bun.file(file)
    .json()
    .catch(() => undefined);
  const evidence = diagnostic ?? Failure.safeParse(previous?.diagnostic).data;
  await Bun.write(
    file,
    JSON.stringify(
      {
        status: "failed",
        ...(evidence ? { diagnostic: Failure.parse(evidence) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        recovery:
          "Inspect the failure diagnostic and rerun after resolving the cause. Source and command authority will be rechecked.",
      },
      null,
      2,
    ),
  );
}
