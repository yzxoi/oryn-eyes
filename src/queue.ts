export type Status = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Job = { id: string; key: string; conversation: string; sender: string; status: Status; stage: string; created: number; started?: number; updated: number; reply?: string; issueUrl?: string; controller: AbortController };

export class Queue {
  private jobs = new Map<string, Job>();
  private keys = new Map<string, string>();
  private pending: { job: Job; run: (job: Job) => Promise<void> }[] = [];
  private active = new Set<string>();
  private actors = new Set<string>();
  private waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private concurrency: number, private limit: number, private ttl = 30 * 60_000, private waitBudget = 30 * 60_000) {}
  get(id: string) { this.expire(); return this.jobs.get(id); }
  stats() { this.expire(); return { active: this.active.size, queued: this.pending.length, retained: this.jobs.size }; }
  submit(key: string, conversation: string, sender: string, run: (job: Job) => Promise<void>) {
    this.expire();
    const existing = this.jobs.get(this.keys.get(key) || "");
    if (existing) return { job: existing, duplicate: true };
    if (this.pending.length + this.active.size >= this.limit) throw new Error("Queue is full");
    const now = Date.now();
    const job: Job = { id: crypto.randomUUID(), key, conversation, sender, status: "queued", stage: "等待处理", created: now, updated: now, controller: new AbortController() };
    this.jobs.set(job.id, job); this.keys.set(key, job.id); this.pending.push({ job, run });
    const timer = setTimeout(() => {
      this.waitTimers.delete(job.id);
      if (job.status !== "queued") return;
      job.status = "failed"; job.stage = "排队超时"; job.updated = Date.now();
      job.reply = "⏱️ 排队等待达到时限，本次尚未开始分析，请稍后重试。";
      job.controller.abort(new Error("Queue wait budget exhausted"));
      this.pending = this.pending.filter(entry => entry.job !== job);
      this.pump();
    }, this.waitBudget);
    timer.unref(); this.waitTimers.set(job.id, timer); this.pump();
    return { job, duplicate: false };
  }
  private pump() {
    while (this.active.size < this.concurrency) {
      const index = this.pending.findIndex(({ job }) => job.status === "cancelled" || !this.actors.has(JSON.stringify([job.conversation, job.sender])));
      if (index < 0) return;
      const entry = this.pending.splice(index, 1)[0];
      if (!entry) return;
      const { job, run } = entry;
      clearTimeout(this.waitTimers.get(job.id)); this.waitTimers.delete(job.id);
      if (job.status === "cancelled") continue;
      const actor = JSON.stringify([job.conversation, job.sender]);
      job.status = "running"; job.started = Date.now(); this.active.add(job.id); this.actors.add(actor);
      void run(job).catch(() => { if (job.status !== "cancelled") { job.status = "failed"; job.reply = "⚠️ 本次处理失败，请稍后重试。"; } }).finally(() => { job.updated = Date.now(); this.active.delete(job.id); this.actors.delete(actor); this.pump(); });
    }
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || !["queued", "running"].includes(job.status)) return false;
    clearTimeout(this.waitTimers.get(job.id)); this.waitTimers.delete(job.id);
    this.pending = this.pending.filter(entry => entry.job !== job);
    job.status = "cancelled"; job.updated = Date.now(); job.reply = "⏹️ 已停止本次处理。"; job.controller.abort(); return true;
  }
  close() { for (const id of this.jobs.keys()) this.cancel(id); }
  private expire() {
    for (const [id, job] of this.jobs) if (!["queued", "running"].includes(job.status) && Date.now() - job.updated > this.ttl) { this.jobs.delete(id); this.keys.delete(job.key); }
  }
}
