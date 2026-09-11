export async function command(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    trim?: boolean;
  } = {},
) {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
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
    if (code)
      throw new Error(`${args[0]} failed (${code}): ${stderr.slice(-4000)}`);
    return options.trim === false ? stdout : stdout.trim();
  } finally {
    clearTimeout(timer);
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
