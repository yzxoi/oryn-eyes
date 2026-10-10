import { expect, test } from "bun:test";
import { Queue } from "../src/queue";

test("duplicate deliveries share a job; replies are non-destructive reads", async () => {
  const queue = new Queue(1, 3); let count = 0;
  const run = async () => { count++; };
  const a = queue.submit("key", "group", "user", run);
  const b = queue.submit("key", "group", "user", run);
  expect(a.job.id).toBe(b.job.id); expect(b.duplicate).toBe(true);
  expect(queue.get(a.job.id)).toBe(queue.get(a.job.id));
  await Bun.sleep(1); expect(count).toBe(1);
});

test("a cancelled queued request never starts", async () => {
  const queue = new Queue(1, 4); let unblock!: () => void; let ran = false;
  queue.submit("a", "g", "u", () => new Promise<void>(r => { unblock = r; }));
  const b = queue.submit("b", "g", "v", async () => { ran = true; });
  expect(queue.cancel(b.job.id)).toBe(true); unblock(); await Bun.sleep(5);
  expect(ran).toBe(false); expect(b.job.status).toBe("cancelled");
});

test("same-sender turns are serialized while other senders can proceed", async () => {
  const queue = new Queue(2, 5); let release!: () => void; const order: string[] = [];
  queue.submit("a", "g", "u", () => new Promise<void>(r => { release = r; order.push("first"); }));
  queue.submit("b", "g", "u", async () => { order.push("followup"); });
  queue.submit("c", "g", "v", async () => { order.push("other"); });
  await Bun.sleep(2); expect(order).toEqual(["first", "other"]);
  release(); await Bun.sleep(2); expect(order).toEqual(["first", "other", "followup"]);
});

test("queue wait expires without running and releases capacity", async () => {
  const queue = new Queue(1, 2, 60_000, 25);
  let release!: () => void, ran = false;
  queue.submit("first", "g", "u", () => new Promise<void>(r => { release = r; }));
  const waiting = queue.submit("waiting", "g", "v", async () => { ran = true; }).job;
  await Bun.sleep(60);
  expect(waiting.status).toBe("failed"); expect(waiting.stage).toBe("排队超时");
  expect(waiting.started).toBeUndefined(); expect(ran).toBe(false); expect(queue.stats().queued).toBe(0);
  expect(() => queue.submit("replacement", "g", "v", async () => {})).not.toThrow();
  queue.close(); release(); await Bun.sleep(1);
});

test("cancelling a queued job clears its wait deadline", async () => {
  const queue = new Queue(1, 2, 60_000, 20);
  let release!: () => void;
  queue.submit("first", "g", "u", () => new Promise<void>(r => { release = r; }));
  const job = queue.submit("waiting", "g", "v", async () => { throw new Error("Must not execute"); }).job;
  queue.cancel(job.id); await Bun.sleep(40);
  expect(job.status).toBe("cancelled"); expect(queue.stats().queued).toBe(0);
  release(); await Bun.sleep(1); queue.close();
});
