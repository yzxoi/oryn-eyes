import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./log";
import { abortable, command, executionEnv } from "./process";

const locks = new Map<string, Promise<void>>();

/** Host-owned bare object cache. Never exposed as the model's working tree. */
export async function sourceSnapshot(input: {
  cacheRoot: string; repository: string; sha: string; archive: string;
  token?: string; signal?: AbortSignal; timeoutSeconds?: number;
  // Trusted host transport override, used by local integration fixtures only.
  remote?: string;
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository) || input.repository.split('/').some(x => x === '.' || x === '..')) throw new Error('Invalid repository');
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error('Invalid source commit');
  const started = Date.now();
  const root = path.resolve(input.cacheRoot);
  const cache = path.join(root, input.repository + '.git');
  const previous = locks.get(cache) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const current = previous.catch(() => {}).then(() => gate);
  locks.set(cache, current);
  void current.then(() => { if (locks.get(cache) === current) locks.delete(cache); });
  const auth = input.token ? 'Basic ' + Buffer.from('x-access-token:' + input.token).toString('base64') : '';
  const env: Record<string, string> = {
    ...executionEnv(root), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: auth ? '1' : '0',
    ...(auth ? { GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: ' + auth } : {}),
  };
  const options = { env, signal: input.signal, timeoutMs: (input.timeoutSeconds ?? 120) * 1000 };
  const git = (...args: string[]) => command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=20', '--git-dir', cache, ...args], options);
  try {
    await abortable(previous.catch(() => {}), input.signal);
    input.signal?.throwIfAborted();
    await mkdir(path.dirname(cache), { recursive: true, mode: 0o700 });
    if (!(await Bun.file(path.join(cache, 'HEAD')).exists())) await command(['git', 'init', '--bare', cache], options);
    let present = false;
    try { await git('cat-file', '-e', input.sha + '^{commit}'); present = true; }
    catch { input.signal?.throwIfAborted(); }
    if (!present) await git('fetch', '--no-tags', '--depth=1', '--force', input.remote ?? `https://github.com/${input.repository}.git`, '+' + input.sha + ':refs/oryn/snapshot');
    await git('archive', '--format=tar', '--prefix=source/', '--output=' + input.archive, input.sha);
    log('source_cache_ready', { sha: input.sha, cacheHit: present, milliseconds: Date.now() - started });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [input.token, auth]) if (secret) message = message.replaceAll(secret, '[redacted]');
    throw new Error('Source cache preparation failed: ' + message);
  } finally {
    release();
  }
}
