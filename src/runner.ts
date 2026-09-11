import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseAnalysis as parseReport, type Analysis as Report, type ImageInput } from "./contracts";
import type { Settings } from "./config";
import { executionEnv } from "./process";
import { parseProgress } from "./progress";
import {
  Failure,
  HarnessFailure,
  failureDiagnostic,
  redactDiagnostic,
} from "./failure";

export async function runHarness(
  settings: Settings,
  workspace: string,
  prompt: string,
  images: ImageInput[],
  gateway: string,
  signal?: AbortSignal,
): Promise<Report> {
  const job = { model: `oryn/${settings.model}`, timeoutSeconds: settings.budget };
  const startedAt = Date.now();
  if (!settings.apiKey) throw new Error("ORYN_API_KEY is required");
  const root = path.resolve(import.meta.dir, "..");
  const receipt = await Bun.file(path.join(root, ".runtime/receipt.json"))
    .json()
    .catch(() => {
      throw new Error("Run bun run core:install first");
    });
  const pin = await Bun.file(path.join(root, "config/core.json")).json();
  if (
    receipt.commit !== pin.commit ||
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch
  )
    throw new Error("Core build does not match the pin/platform; reinstall");
  const home = await mkdtemp(path.join(settings.tempRoot, "worker-"));
  try {
    const request = path.join(home, "request.json"),
      result = path.join(home, "result.json");
    await writeFile(
      request,
      JSON.stringify({ job, workspace, prompt, resultPath: result, images, gateway }),
      { mode: 0o600 },
    );
    const child = Bun.spawn(
      [process.execPath, path.join(root, ".runtime/worker.js"), request],
      {
        cwd: home,
        env: {
          ...executionEnv(home),
          ORYN_API_KEY: settings.apiKey,
          ORYN_BASE_URL: settings.baseURL,
          ORYN_VARIANT: "max",
          ORYN_REQUEST_TIMEOUT_SECONDS:
            undefined,
        },
        stdout: "ignore",
        stderr: "pipe",
        detached: process.platform !== "win32",
      },
    );
    console.error(
      JSON.stringify({
        event: "harness_started",
        mode: "support",
        timeoutSeconds: job.timeoutSeconds,
        variant: "max",
      }),
    );
    let termination: "cancelled" | "job_timeout" | undefined;
    const killGroup = (kind: "SIGTERM" | "SIGKILL") => {
      try {
        if (process.platform === "win32") child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch {
        /* The owned process may already have exited. */
      }
    };
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      termination ??= signal?.aborted ? "cancelled" : "job_timeout";
      killGroup("SIGTERM");
      force ??= setTimeout(() => killGroup("SIGKILL"), 15_000);
    };
    const timer = setTimeout(stop, job.timeoutSeconds * 1000 + 5000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let tail = "";
    const drain = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        const text = decoder.decode(chunk, { stream: true });
        tail = (tail + text).slice(-8192);
        const lines = (pending + text).split("\n");
        pending = lines.pop()!.slice(-8192);
        for (const line of lines) {
          const progress = parseProgress(line);
          if (progress) console.error(JSON.stringify(progress));
        }
      }
    })();
    try {
      const code = await child.exited;
      killGroup("SIGKILL");
      await drain;
      const redaction = {
        secrets: [settings.apiKey],
        paths: [home, workspace],
      };
      if (termination || code) {
        const stored = Failure.safeParse(
          await Bun.file(result + ".failure.json")
            .json()
            .catch(() => undefined),
        );
        if (termination) {
          const reason = failureDiagnostic(
            termination,
            "host",
            signal?.reason ?? new Error("Task budget exhausted"),
            redaction,
            { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) },
          );
          throw new HarnessFailure(
            Failure.parse(
              redactDiagnostic(
                { ...(stored.success ? stored.data : {}), ...reason },
                redaction,
              ),
            ),
          );
        }
        if (stored.success)
          throw new HarnessFailure(
            Failure.parse(redactDiagnostic(stored.data, redaction)),
          );
        throw new HarnessFailure(
          failureDiagnostic(
            "worker_exit",
            "worker",
            new Error(`Harness exited ${code}: ${tail}`),
            redaction,
          ),
        );
      }
      const output = z
        .object({
          text: z.string(),
          toolCalls: z.number().int().nonnegative(),
          formatCorrections: z.number().int().min(0).max(2),
        })
        .parse(await Bun.file(result).json());
      console.error(
        JSON.stringify({
          event: "harness_completed",
          mode: "support",
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          toolCalls: output.toolCalls,
          formatCorrections: output.formatCorrections,
          variant: "max",
        }),
      );
      return parseReport(output.text);
    } finally {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      signal?.removeEventListener("abort", stop);
      killGroup("SIGKILL");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
