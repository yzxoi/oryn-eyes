import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWorkspace } from "../src/workspace";
import { GitHub } from "../src/github";
import { command } from "../src/process";

for (const privateRepo of [false, true]) test(`broken Git cache falls back to the resolved SHA (private=${privateRepo})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eyes-fallback-"));
  const tasks = path.join(root, "tasks"), brokenCache = path.join(root, "not-a-directory");
  const sha = "d".repeat(40), requests: { url: string; auth: string | null }[] = [];
  try {
    await Bun.write(brokenCache, "blocked");
    await mkdir(path.join(root, "source"));
    await Bun.write(path.join(root, "source", "evidence.txt"), "exact commit fixture");
    const tar = path.join(root, "source.tar");
    await command(["tar", "-cf", tar, "-C", root, "source"]);
    const bytes = await Bun.file(tar).bytes();
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "dev", private: privateRepo });
      if (url.endsWith("/commits/dev")) return Response.json({ sha });
      requests.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return new Response(bytes);
    }) as typeof fetch;
    const gh = new GitHub("owner/repo", "fixture-token", transport, "https://mirror.example");
    const work = await prepareWorkspace(gh, tasks, undefined, { root: brokenCache, token: "fixture-token", timeoutSeconds: 1 });
    expect(work.sha).toBe(sha);
    expect(await Bun.file(path.join(work.workspace, "evidence.txt")).text()).toBe("exact commit fixture");
    expect(requests).toEqual([privateRepo
      ? { url: `https://api.github.com/repos/owner/repo/tarball/${sha}`, auth: "Bearer fixture-token" }
      : { url: `https://mirror.example/https://github.com/owner/repo/archive/${sha}.tar.gz`, auth: null }]);
    await work.dispose(); expect(await readdir(tasks)).toEqual([]);
    const controller = new AbortController(); controller.abort(new Error("user stopped"));
    await expect(prepareWorkspace(gh, tasks, controller.signal, { root: brokenCache, token: "fixture-token", timeoutSeconds: 1 })).rejects.toThrow("user stopped");
    expect(requests).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive fallback remains bounded and removes the failed task directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eyes-fallback-timeout-")), tasks = path.join(root, "tasks");
  let aborted = false;
  try {
    const brokenCache = path.join(root, "not-a-directory"); await Bun.write(brokenCache, "blocked");
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "dev", private: false });
      if (url.endsWith("/commits/dev")) return Response.json({ sha: "e".repeat(40) });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      });
    }) as typeof fetch;
    await expect(prepareWorkspace(new GitHub("owner/repo", "fixture", transport), tasks, undefined, { root: brokenCache, token: "fixture", timeoutSeconds: 0.03 })).rejects.toThrow();
    expect(aborted).toBe(true); expect(await readdir(tasks)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
