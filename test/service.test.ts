import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "../src/config";
import { startService } from "../src/server";
import { GitHub } from "../src/github";

test("authenticated message -> evidence search -> one automatic issue; status polling is repeatable", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "eyes-service-"));
  const created: { number: number; title: string; body: string; state: string; html_url: string }[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/labels")) return Response.json([]);
    if (url.includes("/search/issues")) return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    if (init?.method === "POST" && url.endsWith("/issues")) {
      const body = JSON.parse(String(init.body));
      const result = { number: 7, title: body.title, body: body.body, state: "open", html_url: "https://github.com/owner/repo/issues/7" };
      created.push(result); return Response.json(result);
    }
    if (url.includes("/issues?")) return Response.json(created);
    throw new Error("Unexpected GitHub operation");
  }) as typeof fetch;
  const settings = Settings.parse({ repository: "owner/repo", githubToken: "private-github-token", apiKey: "private-model-key", bridgeToken: "a-bridge-token-longer-than-24", port: 0, tempRoot: temp });
  const app = await startService(settings, {
    github: new GitHub(settings.repository, settings.githubToken, transport),
    prepare: async () => {
      const directory = await mkdtemp(path.join(temp, "task-")); const workspace = path.join(directory, "source"); await mkdir(workspace);
      await Bun.write(path.join(workspace, "test.ts"), "const flag = false;\n");
      return { directory, workspace, sha: "a".repeat(40), branch: "main", private: false, dispose: () => rm(directory, { recursive: true, force: true }) };
    },
    analyze: async (_settings, _workspace, _prompt, _images, gateway) => {
      await fetch(gateway + "/search?q=example");
      return { action: "create_issue", reply: "已分析", issue: { kind: "bug", title: "bug: test issue", description: "用户描述功能未正确工作，待进一步验证。", environment: "未知", steps: [], actual: "用户称功能异常", expected: "功能正常", facts: [{ claim: "flag 初始值为 false", path: "test.ts", line: 1, quote: "const flag = false;" }], hypotheses: [], unknowns: [], nextSteps: [], relatedIssues: [], screenshotIds: [] } };
    },
  });
  const base = `http://127.0.0.1:${app.server.port}`;
  const headers = { Authorization: `Bearer ${settings.bridgeToken}`, "Content-Type": "application/json" };
  try {
    expect((await fetch(base + "/v1/messages", { method: "POST" })).status).toBe(401);
    const payload = { messageId: "m1", conversation: "group", sender: "user", text: "反馈问题" };
    const response = await fetch(base + "/v1/messages", { method: "POST", headers, body: JSON.stringify(payload) });
    expect(response.status).toBe(202);
    const accepted = await response.json() as { id: string };
    let status: { status: string; reply?: string } = { status: "running" };
    for (let i = 0; i < 100; i++) {
      status = await (await fetch(base + "/v1/jobs/" + accepted.id, { headers })).json() as typeof status;
      if (status.status === "completed" || status.status === "failed") break;
      await Bun.sleep(5);
    }
    expect(status.status).toBe("completed"); expect(status.reply).toContain("/issues/7"); expect(created).toHaveLength(1);
    expect(created[0]!.body).toContain("用户反馈"); expect(created[0]!.body).toContain("已核实的事实");
    const again = await (await fetch(base + "/v1/messages", { method: "POST", headers, body: JSON.stringify(payload) })).json() as { id: string; duplicate: boolean };
    expect(again.id).toBe(accepted.id); expect(again.duplicate).toBe(true); expect(created).toHaveLength(1);
    expect((await fetch(base + "/v1/jobs/" + accepted.id, { headers })).status).toBe(200);
  } finally { app.close(); await rm(temp, { recursive: true, force: true }); }
});
