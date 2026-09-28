import { timingSafeEqual } from "node:crypto";
import { Incoming, messageKey, type Analysis } from "./contracts";
import { settingsFromEnv, type Settings } from "./config";
import { GitHub } from "./github";
import { validateImage } from "./images";
import { log, safeError } from "./log";
import { Queue, type Job } from "./queue";
import { prepareWorkspace, cleanupWorkspaces } from "./workspace";
import { readGateway } from "./gateway";
import { modelDefinition } from "./model";
import { supportPrompt } from "./prompt";
import { runHarness } from "./runner";
import { renderIssue, validateFacts, groundReplyLinks } from "./render";

export function authorized(request: Request, secret: string) {
  const a = Buffer.from(request.headers.get("authorization") || ""), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startService(settings: Settings, options: { analyze?: typeof runHarness; github?: GitHub; prepare?: typeof prepareWorkspace } = {}) {
  const github = options.github ?? new GitHub(settings.repository, settings.githubToken, fetch, settings.archiveMirror);
  const analyze = options.analyze ?? runHarness;
  const prepare = options.prepare ?? ((github: GitHub, tempRoot: string, signal?: AbortSignal) => prepareWorkspace(github, tempRoot, signal, settings.sourceCacheRoot ? { root: settings.sourceCacheRoot, token: settings.githubToken, timeoutSeconds: settings.sourceFetchTimeout } : undefined));
  const queue = new Queue(settings.concurrency, settings.queueLimit, 30 * 60_000, settings.queueBudget * 1000);
  const histories = new Map<string, { updated: number; entries: Incoming["history"] }>();
  let publication: Promise<unknown> = Promise.resolve();
  let ready = false;
  const secrets = [settings.apiKey, settings.githubToken, settings.bridgeToken];

  function stage(job: Job, value: string) { job.stage = value; job.updated = Date.now(); log("job_stage", { job: job.id, stage: value }); }
  function publicReply(reply: string, message: Incoming) {
    for (const value of [...secrets, message.sender, message.conversation]) if (value.length >= 5) reply = reply.replaceAll(value, "[已脱敏]");
    return reply;
  }
  function remember(message: Incoming, reply: string) {
    const now = Date.now();
    for (const [key, value] of histories) if (now - value.updated > 30 * 60_000) histories.delete(key);
    const key = JSON.stringify([message.conversation, message.sender]);
    const previous = histories.get(key)?.entries ?? [];
    histories.set(key, { updated: now, entries: [...previous, { role: "user" as const, text: message.text.slice(0, 6000) }, { role: "assistant" as const, text: reply.slice(0, 6000) }].slice(-8) });
    if (histories.size > 200) histories.delete(histories.keys().next().value!);
  }
  async function processMessage(job: Job, original: Incoming) {
    let work: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
    let gateway: ReturnType<typeof readGateway> | undefined;
    const started = job.started ?? Date.now();
    const deadline = started + settings.budget * 1000;
    log("job_budget", { job: job.id, queueSeconds: Math.round((started - job.created) / 1000), taskSeconds: settings.budget });
    const timer = setTimeout(() => job.controller.abort(new Error("Task budget exhausted")), Math.max(1, deadline - Date.now()));
    const check = () => { if (Date.now() >= deadline) job.controller.abort(new Error("Task budget exhausted")); job.controller.signal.throwIfAborted(); };
    try {
      check();
      stage(job, "检索与准备源码");
      const prior = await github.findPublished(job.key);
      if (prior) {
        job.reply = `🔗 这条反馈已经记录：${prior.html_url}`; job.issueUrl = prior.html_url; job.status = "completed"; return;
      }
      const previous = histories.get(JSON.stringify([original.conversation, original.sender]));
      const history = previous && Date.now() - previous.updated < 30 * 60_000 ? previous.entries : [];
      const message = { ...original, history: [...history, ...original.history].slice(-12) };
      check(); work = await prepare(github, settings.tempRoot, job.controller.signal); check();
      gateway = readGateway(github);
      stage(job, "分析消息、截图与仓库证据");
      const budget = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
      const result = await analyze({ ...settings, budget }, work.workspace, supportPrompt(message, { repository: settings.repository, sha: work.sha, branch: work.branch, gateway: gateway.url }), message.images, gateway.url, job.controller.signal);
      check();
      result.reply = await groundReplyLinks(result.reply, { workspace: work.workspace, repository: settings.repository, sha: work.sha, branch: work.branch });
      if (["known_issue", "create_issue"].includes(result.action) && gateway.searches === 0) throw new Error("No successful GitHub search evidence was collected");
      if (result.action === "known_issue") {
        const existing = await github.issue(result.existingIssue!); check();
        const reply = publicReply(result.reply, original);
        job.reply = reply.includes(existing.html_url) ? reply : `${reply}\n🔗 ${existing.html_url}`; job.issueUrl = existing.html_url;
      } else if (result.action === "create_issue") {
        const issue = result.issue!;
        await validateFacts(issue, work.workspace);
        if (issue.screenshotIds.some(id => !message.images.some(i => i.id === id))) throw new Error("Analysis referenced an unknown screenshot");
        if (!settings.publish) {
          job.reply = `🧪 验证模式：分析完成，未发布 Issue。\n${publicReply(result.reply, original)}`;
          log("publication_preview", { job: job.id, facts: issue.facts.length, screenshots: issue.screenshotIds.length, searches: gateway.searches });
        } else {
          stage(job, "发布反馈到 GitHub");
          const sha = work.sha, searches = gateway.searches;
          const publish = publication.then(async () => {
            check();
            const existing = await github.findPublished(job.key); check();
            if (existing) return existing;
            const images: { id: string; url: string }[] = [];
            for (const image of message.images.filter(i => issue.screenshotIds.includes(i.id))) {
              check(); images.push(await github.publishImage(image, sha));
            }
            check();
            const body = publicReply(renderIssue(issue, { repository: settings.repository, sha, key: job.key, images, searches }), original);
            const title = publicReply(issue.title, original).replaceAll("@", "＠");
            return github.create(title, body, github.labels(issue.kind), job.key);
          });
          publication = publish.catch(() => {});
          const created = await publish;
          job.issueUrl = created.html_url;
          job.reply = `✅ 已记录：${created.title}\n${created.html_url}`;
          log("issue_published", { job: job.id, number: created.number, screenshots: issue.screenshotIds.length, facts: issue.facts.length });
        }
      } else job.reply = publicReply(result.reply, original);
      job.status = "completed"; job.stage = "处理完成";
      remember(original, job.reply);
      log("job_completed", { job: job.id, action: result.action, seconds: Math.round((Date.now() - job.created) / 1000), images: original.images.length, searches: gateway.searches });
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.reply = job.controller.signal.aborted ? "⏱️ 本次分析达到时间预算，未完成的反馈不会被当作成功。请补充更具体的复现信息后重试。" : `⚠️ 本次处理未完成，请稍后重试。诊断编号：${job.id.slice(0, 8)}`;
      }
      const diagnostic = error && typeof error === "object" && "diagnostic" in error ? error.diagnostic : undefined;
      log("job_failed", { job: job.id, stage: job.stage, error: safeError(error, secrets), ...(diagnostic ? { diagnostic } : {}) });
    } finally { clearTimeout(timer); gateway?.close(); await work?.dispose(); job.updated = Date.now(); }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: settings.port, maxRequestBodySize: 26_000_000, idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ status: ready ? "ok" : "starting", service: "oryn-eyes", repository: settings.repository, model: settings.model, ...queue.stats() }, { status: ready ? 200 : 503 });
      if (!authorized(request, settings.bridgeToken)) return new Response("Unauthorized", { status: 401 });
      if (!ready) return new Response("Starting", { status: 503 });
      if (url.pathname === "/v1/messages" && request.method === "POST") {
        try {
          const message = Incoming.parse(await request.json());
          if (new Set(message.images.map(i => i.id)).size !== message.images.length) throw new Error("Image IDs must be unique");
          let bytes = 0; for (const image of message.images) bytes += validateImage(image).bytes.length;
          if (bytes > 20_000_000) throw new Error("Image total exceeds 20 MB");
          const { job, duplicate } = queue.submit(messageKey(message, settings.repository), message.conversation, message.sender, job => processMessage(job, message));
          return Response.json({ id: job.id, status: job.status, duplicate, timeoutSeconds: settings.queueBudget + settings.budget }, { status: 202 });
        } catch (error) {
          const busy = error instanceof Error && error.message === "Queue is full";
          return Response.json({ error: busy ? "服务繁忙，请稍后重试" : "Invalid message or image payload" }, { status: busy ? 429 : 400 });
        }
      }
      const match = url.pathname.match(/^\/v1\/jobs\/([\w-]+)(\/cancel)?$/);
      if (match) {
        const job = queue.get(match[1]!);
        if (!job) return new Response("Job expired or unavailable", { status: 404 });
        if (match[2] && request.method === "POST") {
          const actor = await request.json().catch(() => ({})) as { conversation?: string; sender?: string };
          if (actor.conversation !== job.conversation || actor.sender !== job.sender) return new Response("Forbidden", { status: 403 });
          return Response.json({ cancelled: queue.cancel(job.id) });
        }
        if (!match[2] && request.method === "GET") return Response.json({ id: job.id, status: job.status, stage: job.stage, reply: job.reply, issueUrl: job.issueUrl });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  try {
    await cleanupWorkspaces(settings.tempRoot);
    if (settings.publish) await github.ensureLabels();
    ready = true;
    const definition = modelDefinition(settings.model, "max");
    log("service_ready", { repository: settings.repository, model: settings.model, context: definition.limit.context, reasoningEffort: "max", multimodal: definition.modalities?.input.includes("image") ?? false, publish: settings.publish, port: server.port });
  } catch (error) { server.stop(true); throw error; }
  const cleanupTimer = setInterval(() => {
    void cleanupWorkspaces(settings.tempRoot).catch(error => log("workspace_cleanup_failed", { error: safeError(error, secrets) }));
  }, 15 * 60_000);
  cleanupTimer.unref();
  return { server, queue, close: () => { clearInterval(cleanupTimer); queue.close(); server.stop(true); } };
}

if (import.meta.main) {
  const app = await startService(settingsFromEnv());
  const stop = () => { app.close(); setTimeout(() => process.exit(0), 20_000); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
