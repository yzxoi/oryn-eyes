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
