import { expect, test } from "bun:test";
import { GitHub } from "../src/github";
import { command } from "../src/process";

function download() {
  let complete!: (response: Response) => void;
  let upstream: AbortSignal | undefined;
  let calls = 0;
  const transport = (async (_input: unknown, init?: RequestInit) => {
    calls++;
    upstream = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      complete = resolve;
      upstream?.addEventListener("abort", () => reject(upstream?.reason), { once: true });
    });
  }) as typeof fetch;
  return { gh: new GitHub("a/b", "fixture", transport), finish: () => complete(new Response("source bytes")), signal: () => upstream, calls: () => calls };
}

test("one source consumer can cancel without cancelling another consumer", async () => {
  const d = download(), a = new AbortController(), b = new AbortController();
  const first = d.gh.archive("a".repeat(40), a.signal);
  const second = d.gh.archive("a".repeat(40), b.signal);
  a.abort(new Error("caller stopped"));
  await expect(first).rejects.toThrow("caller stopped");
  expect(d.signal()?.aborted).toBe(false);
  d.finish();
  expect(Buffer.from(await second).toString()).toBe("source bytes");
  expect(d.calls()).toBe(1);
});

test("the last source consumer cancels the download and a new request can retry", async () => {
  const d = download(), controller = new AbortController();
  const pending = d.gh.archive("b".repeat(40), controller.signal);
  controller.abort(new Error("task budget exhausted"));
  await expect(pending).rejects.toThrow("task budget exhausted");
  expect(d.signal()?.aborted).toBe(true);
  const retried = d.gh.archive("b".repeat(40));
  d.finish();
  expect(Buffer.from(await retried).toString()).toBe("source bytes");
  expect(d.calls()).toBe(2);
});

test("cancelling a source preparation command terminates it promptly", async () => {
  const controller = new AbortController();
  const pending = command([process.execPath, "-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort(new Error("stop preparation"));
  await expect(pending).rejects.toThrow("stop preparation");
});

test("only verified public repositories use the mirror, without credentials", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return new Response("source");
  }) as typeof fetch;
  const gh = new GitHub("a/b", "private-token", transport, "https://mirror.example/");
  const sha = "c".repeat(40);
  await gh.archive(sha, undefined, true);
  await gh.archive(sha, undefined, false);
  await gh.metadata().catch(() => undefined);
  expect(requests).toEqual([
    { url: `https://mirror.example/https://github.com/a/b/archive/${sha}.tar.gz`, authorization: null },
    { url: `https://api.github.com/repos/a/b/tarball/${sha}`, authorization: "Bearer private-token" },
    { url: "https://api.github.com/repos/a/b", authorization: "Bearer private-token" },
  ]);
});
