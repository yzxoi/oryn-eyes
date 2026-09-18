import path from "node:path";
import type { IssueDraft } from "./contracts";

function publicText(value: string) {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/@(?!\[)/g, "＠");
}
export async function groundReplyLinks(reply: string, context: { workspace: string; repository: string; sha: string; branch: string }) {
  const prefix = `https://github.com/${context.repository}/blob/`;
  const urls = [...new Set(reply.match(/https:\/\/github\.com\/[^\s)\]}>，。；]+/g) ?? [])];
  for (const link of urls) {
    if (!link.startsWith(prefix)) continue;
    const url = new URL(link);
    const suffix = url.pathname.slice(new URL(prefix).pathname.length);
    const ref = suffix.startsWith(context.branch + "/") ? context.branch : suffix.split("/")[0]!;
    if (ref !== context.branch && !(/^[a-f0-9]{7,40}$/.test(ref) && context.sha.startsWith(ref))) continue;
    let relative = "";
    try { relative = decodeURIComponent(suffix.slice(ref.length + 1)); } catch { /* Invalid paths are omitted. */ }
    const full = path.resolve(context.workspace, relative);
    const valid = Boolean(relative) && full.startsWith(path.resolve(context.workspace) + path.sep) && await Bun.file(full).exists();
    if (!valid) {
      reply = reply.replaceAll(`](${link})`, "]（源码链接未通过校验）").replaceAll(link, "（源码链接未通过校验，已省略）");
      continue;
    }
    const normalized = `${prefix}${context.sha}/${relative.split("/").map(encodeURIComponent).join("/")}${url.hash}`;
    reply = reply.replaceAll(link, normalized);
  }
  return reply;
}
export async function validateFacts(issue: IssueDraft, workspace: string) {
  for (const fact of issue.facts) {
    const full = path.resolve(workspace, fact.path);
    if (!full.startsWith(path.resolve(workspace) + path.sep) || path.isAbsolute(fact.path)) throw new Error("Fact path must stay inside repository");
    const file = Bun.file(full);
    if (!(await file.exists()) || file.size > 2_000_000) throw new Error(`Fact source unavailable: ${fact.path}`);
    const lines = (await file.text()).split("\n");
    const excerpt = lines.slice(fact.line - 1, fact.line - 1 + fact.quote.split("\n").length).join("\n");
    if (!excerpt.includes(fact.quote)) throw new Error(`Fact quote does not match ${fact.path}:${fact.line}`);
  }
}
export function renderIssue(issue: IssueDraft, context: { repository: string; sha: string; key: string; images: { id: string; url: string }[]; searches: number }) {
  const text = publicText;
  const lines = [`<!-- oryn-eyes:${context.key} -->`, "## 🗣️ 用户反馈", "", text(issue.description), "", "## 🔁 复现与环境", "", `- 环境：${text(issue.environment)}`, "", ...(issue.steps.length ? issue.steps.map((s, i) => `${i + 1}. ${text(s)}`) : ["用户尚未提供完整复现步骤。"]), "", "**预期行为**", "", text(issue.expected), "", "**实际行为**", "", text(issue.actual), "", "## 🔎 已核实的事实", "", "以下为指定源码版本的静态检查结果；不代表已运行复现或确认线上根因。", ""];
  if (!issue.facts.length) lines.push("目前没有足够的源码证据可列为已核实事实；本条记录保留用户描述供后续核查。");
  for (const fact of issue.facts) {
    const file = fact.path.split("/").map(encodeURIComponent).join("/");
    lines.push(`- ${text(fact.claim)}（[${fact.path}:${fact.line}](https://github.com/${context.repository}/blob/${context.sha}/${file}#L${fact.line})）`);
  }
  if (issue.hypotheses.length) lines.push("", "## 🧭 可能涉及的模块", "", "以下是待验证的推测：", "", ...issue.hypotheses.map(h => `- **${text(h.module)}**：${text(h.reason)}`));
  if (issue.unknowns.length) lines.push("", "## ❓ 待补充信息", "", ...issue.unknowns.map(s => `- ${text(s)}`));
  if (issue.nextSteps.length) lines.push("", "## 🛠️ 建议下一步", "", ...issue.nextSteps.map(s => `- [ ] ${text(s)}`));
  lines.push("", "## 🔗 去重与相关记录", "", `已执行 ${context.searches} 次 GitHub 检索。检索用于辅助去重，不保证覆盖全部历史记录。`);
  if (issue.relatedIssues.length) lines.push("", ...issue.relatedIssues.map(n => `- https://github.com/${context.repository}/issues/${n}`));
  if (context.images.length) lines.push("", "## 🖼️ 用户提供的截图", "", ...context.images.map((i, n) => `![反馈截图 ${n + 1}](${i.url})`));
  lines.push("", "---", "由 👁️ Oryn Eyes 从用户反馈整理。用户描述、源码证据和待验证推测已分别列出；请以复现与维护者核查为准。");
  const body = lines.join("\n");
  if (body.length > 60000) throw new Error("Issue body exceeds publication limit");
  return body;
}
