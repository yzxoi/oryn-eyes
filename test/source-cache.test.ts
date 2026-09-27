import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { command, executionEnv } from '../src/process';
import { sourceSnapshot } from '../src/source-cache';
import { cleanupWorkspaces } from '../src/workspace';

test('cached source refreshes exact commits, survives restart and separates snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eyes-cache-test-'));
  const origin = path.join(root, 'origin'), cacheRoot = path.join(root, 'cache');
  const env = { ...executionEnv(root), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  const git = (...args: string[]) => command(['git', '-C', origin, ...args], { env });
  try {
    await mkdir(origin); await git('init');
    await Bun.write(path.join(origin, 'evidence.txt'), 'first');
    await git('add', '.'); await git('commit', '-m', 'first');
    const first = await git('rev-parse', 'HEAD');
    const options = { cacheRoot, repository: 'owner/repo', remote: origin, sha: first, token: 'fixture-secret' };
    const a = path.join(root, 'a.tar'), b = path.join(root, 'b.tar');
    await Promise.all([sourceSnapshot({ ...options, archive: a }), sourceSnapshot({ ...options, archive: b })]);
    expect(await Bun.file(a).bytes()).toEqual(await Bun.file(b).bytes());
    expect(await Bun.file(path.join(cacheRoot, 'owner/repo.git/config')).text()).not.toContain('fixture-secret');
    await Bun.write(path.join(origin, 'evidence.txt'), 'second'); await git('commit', '-am', 'second');
    const second = await git('rev-parse', 'HEAD');
    await sourceSnapshot({ ...options, sha: second, archive: b });
    expect(await command(['tar', '-xOf', a, 'source/evidence.txt'])).toBe('first');
    expect(await command(['tar', '-xOf', b, 'source/evidence.txt'])).toBe('second');
    // A new process must use the persistent cache without contacting an unavailable origin.
    const module = path.resolve(import.meta.dir, '../src/source-cache.ts');
    await command([process.execPath, '-e', `import {sourceSnapshot} from ${JSON.stringify(module)}; await sourceSnapshot(${JSON.stringify({ ...options, remote: '/nonexistent', sha: second, archive: b })});`]);
    const controller = new AbortController(); controller.abort(new Error('cancel source'));
    await expect(sourceSnapshot({ ...options, archive: b, signal: controller.signal })).rejects.toThrow('cancel source');
    await sourceSnapshot({ ...options, archive: b });
    expect(await command(['tar', '-xOf', b, 'source/evidence.txt'])).toBe('first');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup releases only stale owned temporary directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eyes-cleanup-test-'));
  try {
    for (const name of ['task-old', 'worker-old', 'task-new', 'source-cache']) await mkdir(path.join(root, name));
    const old = new Date(Date.now() - 3 * 3600_000);
    for (const name of ['task-old', 'worker-old', 'source-cache']) await utimes(path.join(root, name), old, old);
    await cleanupWorkspaces(root);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).sort()).toEqual(['source-cache', 'task-new']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
