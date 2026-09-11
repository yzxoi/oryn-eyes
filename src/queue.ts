export type Status = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Job = { id: string; key: string; conversation: string; sender: string; status: Status; stage: string; created: number; updated: number; reply?: string; issueUrl?: string; controller: AbortController };

export class Queue {
  private jobs = new Map<string, Job>();
  private keys = new Map<string, string>();
  private pending: { job: Job; run: (job: Job) => Promise<void> }[] = [];
  private active = new Set<string>();
  constructor(private concurrency: number, private limit: number, private ttl = 30 * 60_000) {}
  get(id: string) { this.expire(); return this.jobs.get(id); }
  stats() { this.expire(); return { active: this.active.size, queued: this.pending.length, retained: this.jobs.size }; }
  submit(key: string, conversation: string, sender: string, run: (job: Job) => Promise<void>) {
    this.expire();
    const existing = this.jobs.get(this.keys.get(key) || "");
    if (existing) return { job: existing, duplicate: true };
    if (this.pending.length + this.active.size >= this.limit) throw new Error("Queue is full");
    const now = Date.now();
    const job: Job = { id: crypto.randomUUID(), key, conversation, sender, status: "queued", stage: "等待处理", created: now, updated: now, controller: new AbortController() };
    this.jobs.set(job.id, job); this.keys.set(key, job.id); this.pending.push({ job, run }); this.pump();
    return { job, duplicate: false };
  }
  private pump() {
    while (this.active.size < this.concurrency) {
      const entry = this.pending.shift();
      if (!entry) return;
      const { job, run } = entry;
      if (job.status === "cancelled") continue;
      job.status = "running"; this.active.add(job.id);
      void run(job).catch(() => { if (job.status !== "cancelled") { job.status = "failed"; job.reply = "⚠️ 本次处理失败，请稍后重试。"; } }).finally(() => { job.updated = Date.now(); this.active.delete(job.id); this.pump(); });
    }
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || !["queued", "running"].includes(job.status)) return false;
    job.status = "cancelled"; job.updated = Date.now(); job.reply = "⏹️ 已停止本次处理。"; job.controller.abort(); return true;
  }
  close() { for (const id of this.jobs.keys()) this.cancel(id); }
  private expire() {
    for (const [id, job] of this.jobs) if (!["queued", "running"].includes(job.status) && Date.now() - job.updated > this.ttl) { this.jobs.delete(id); this.keys.delete(job.key); }
  }
}
