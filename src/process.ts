export function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

export async function command(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    trim?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    options.timeoutMs ?? 120_000,
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    options.signal?.throwIfAborted();
    if (code)
      throw new Error(`${args[0]} failed (${code}): ${stderr.slice(-4000)}`);
    return options.trim === false ? stdout : stdout.trim();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function executionEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    SYNERGY_HOME: home,
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    SYNERGY_DISABLE_AUTOUPDATE: "1",
    SYNERGY_DISABLE_FILEWATCHER: "1",
    SYNERGY_DISABLE_CLAUDE_CODE: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    CI: "1",
  };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SYSTEMROOT",
    "COMSPEC",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
