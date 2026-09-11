import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IssueDraft } from "../src/contracts";
import { renderIssue, validateFacts } from "../src/render";
import { GitHub } from "../src/github";

test("fact citations require a matching source quote and cannot escape workspace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eyes-facts-"));
  try {
    await Bun.write(path.join(dir, "a.ts"), "const value = 1;\n");
    const draft = IssueDraft.parse({ kind: "bug", title: "Example issue", description: "A sufficient user description", facts: [{ claim: "value is one", path: "a.ts", line: 1, quote: "const value = 1;" }] });
    await validateFacts(draft, dir);
    await expect(validateFacts({ ...draft, facts: [{ ...draft.facts[0]!, quote: "const value = 2;" }] }, dir)).rejects.toThrow("does not match");
    await expect(validateFacts({ ...draft, facts: [{ ...draft.facts[0]!, path: "../private" }] }, dir)).rejects.toThrow("inside repository");
    const body = renderIssue(draft, { repository: "owner/repo", sha: "a".repeat(40), key: "b".repeat(64), images: [], searches: 2 });
    expect(body).toContain("用户反馈"); expect(body).toContain("不代表已运行复现"); expect(body).toContain("#L1");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ambiguous create failure recovers the existing issue without replaying POST", async () => {
  let writes = 0;
  const result = { number: 7, title: "Example", body: "<!-- oryn-eyes:key -->", state: "open", html_url: "https://github.com/a/b/issues/7" };
  const transport = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new Error("connection lost after commit"); }
    return Response.json(writes ? [result] : []);
  }) as typeof fetch;
  const gh = new GitHub("a/b", "fake", transport);
  expect((await gh.create("Example", result.body, [], "key")).number).toBe(7);
  expect(writes).toBe(1);
});
