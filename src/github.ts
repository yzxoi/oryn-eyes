import { z } from "zod";
import type { IssueDraft } from "./contracts";
import { validateImage } from "./images";
import type { ImageInput } from "./contracts";

const Issue = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), state: z.string(), html_url: z.string(), pull_request: z.unknown().optional() });
export type GitHubIssue = z.infer<typeof Issue>;
type Publication = { expires: number; pending?: Promise<GitHubIssue>; result?: GitHubIssue; uncertain: boolean };
export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "GitHubError"; }
}
export class GitHub {
  private cachedArchive?: { sha: string; promise: Promise<Uint8Array> };
  private publications = new Map<string, Publication>();
  constructor(readonly repository: string, private token: string, private transport: typeof fetch = fetch) {}

  async api(endpoint: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.transport(`https://api.github.com${endpoint}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "oryn-eyes", "Cache-Control": "no-cache", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${method} ${endpoint.split("?")[0]} returned ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  async metadata() {
    return z.object({ default_branch: z.string(), private: z.boolean() }).parse(await this.api(`/repos/${this.repository}`));
  }
  async head(branch: string) {
    return z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(await this.api(`/repos/${this.repository}/commits/${encodeURIComponent(branch)}`)).sha;
  }
  async search(text: string, kind: "issue" | "pr" = "issue") {
    const query = text.replace(/[^\p{L}\p{N}\s_.-]/gu, " ").replace(/\b(?:OR|AND|NOT)\b/g, " ").trim().slice(0, 180);
    if (!query) throw new Error("Search needs at least one keyword");
    const result = z.object({ total_count: z.number(), incomplete_results: z.boolean(), items: z.array(Issue) }).parse(await this.api(`/search/issues?q=${encodeURIComponent(`repo:${this.repository} is:${kind} ${query}`)}&per_page=30&sort=updated`));
    return { ...result, items: result.items.filter(x => x.html_url.startsWith(`https://github.com/${this.repository}/`)).map(x => ({ ...x, body: x.body?.slice(0, 6000) })) };
  }
  async issue(number: number) { return Issue.parse(await this.api(`/repos/${this.repository}/issues/${number}`)); }
  async issueContext(number: number) {
    const [issue, comments] = await Promise.all([this.issue(number), this.api(`/repos/${this.repository}/issues/${number}/comments?per_page=30`)]);
    return { ...issue, body: issue.body?.slice(0, 12000), comments: z.array(z.object({ body: z.string(), html_url: z.string() })).parse(comments).map(c => ({ ...c, body: c.body.slice(0, 3000) })) };
  }
  async recent() {
    return z.array(Issue).parse(await this.api(`/repos/${this.repository}/issues?state=all&sort=created&direction=desc&per_page=100`));
  }
  async findPublished(key: string) {
    const marker = `<!-- oryn-eyes:${key} -->`;
    return (await this.recent()).find(i => !i.pull_request && i.body?.includes(marker));
  }
  async create(title: string, body: string, labels: string[], key: string) {
    for (const [id, value] of this.publications) if (value.expires < Date.now()) this.publications.delete(id);
    const previous = this.publications.get(key);
    if (previous?.result) return previous.result;
    if (previous?.pending) return previous.pending;
    if (previous?.uncertain) {
      const recovered = await this.findPublished(key);
      if (recovered) { previous.result = recovered; return recovered; }
      throw new Error("Previous GitHub write outcome is uncertain; refusing to create a second Issue");
    }
    const entry: Publication = { expires: Date.now() + 30 * 60_000, uncertain: false };
    this.publications.set(key, entry);
    const pending = this.createOnce(title, body, labels, key, entry);
    entry.pending = pending;
    try { const result = await pending; entry.result = result; return result; }
    finally { entry.pending = undefined; if (!entry.result && !entry.uncertain) this.publications.delete(key); }
  }

  private async createOnce(title: string, body: string, labels: string[], key: string, entry: Publication) {
    const existing = await this.findPublished(key);
    if (existing) return existing;
    try {
      return Issue.parse(await this.api(`/repos/${this.repository}/issues`, "POST", { title, body, labels }));
    } catch (error) {
      // A failed HTTP response can follow a successful write; never blindly replay it.
      entry.uncertain = !(error instanceof GitHubError && error.status >= 400 && error.status < 500);
      const recovered = await this.findPublished(key).catch(() => undefined);
      if (recovered) return recovered;
      throw error;
    }
  }
  async ensureLabels() {
    const definitions = [
      { name: "👁️ oryn-eyes", color: "6554C0", description: "Feedback collected from QQ by Oryn Eyes" },
      { name: "🐛 bug", color: "D73A4A", description: "Reported defect requiring investigation" },
      { name: "✨ enhancement", color: "A2EEEF", description: "Feature or experience improvement" },
      { name: "📚 documentation", color: "0075CA", description: "Documentation or usage clarity" },
    ];
    const current = z.array(z.object({ name: z.string() })).parse(await this.api(`/repos/${this.repository}/labels?per_page=100`));
    for (const label of definitions) if (!current.some(x => x.name === label.name)) await this.api(`/repos/${this.repository}/labels`, "POST", label);
  }
  labels(kind: IssueDraft["kind"]) { return ["👁️ oryn-eyes", { bug: "🐛 bug", feature: "✨ enhancement", docs: "📚 documentation" }[kind]]; }

  async publishImage(image: ImageInput, baseSha: string) {
    const checked = validateImage(image);
    const branch = "oryn-eyes-assets";
    try { await this.api(`/repos/${this.repository}/git/ref/heads/${branch}`); }
    catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      try { await this.api(`/repos/${this.repository}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: baseSha }); }
      catch (created) { if (!(created instanceof GitHubError) || created.status !== 422) throw created; }
    }
    const file = `.oryn-eyes/assets/${checked.hash}.${checked.extension}`;
    const endpoint = `/repos/${this.repository}/contents/${file}`;
    try {
      await this.api(`${endpoint}?ref=${branch}`);
      return { id: image.id, url: `https://raw.githubusercontent.com/${this.repository}/${branch}/${file}` };
    } catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
    const result = z.object({ commit: z.object({ sha: z.string() }) }).parse(await this.api(endpoint, "PUT", {
      message: "chore: attach support screenshot", branch, content: checked.bytes.toString("base64"),
    }));
    return { id: image.id, url: `https://raw.githubusercontent.com/${this.repository}/${result.commit.sha}/${file}` };
  }

  async archive(sha: string): Promise<Uint8Array> {
    if (this.cachedArchive?.sha === sha) return this.cachedArchive.promise;
    const entry = { sha, promise: this.downloadArchive(sha) };
    this.cachedArchive = entry;
    const timer = setTimeout(() => { if (this.cachedArchive === entry) this.cachedArchive = undefined; }, 5 * 60_000);
    timer.unref();
    try { return await entry.promise; }
    catch (error) { if (this.cachedArchive === entry) this.cachedArchive = undefined; throw error; }
  }

  private async downloadArchive(sha: string): Promise<Uint8Array> {
    const response = await this.transport(`https://api.github.com/repos/${this.repository}/tarball/${sha}`, {
      headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "oryn-eyes" }, signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`Repository download failed (${response.status})`);
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 100_000_000) throw new Error("Repository archive exceeds 100 MB");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
