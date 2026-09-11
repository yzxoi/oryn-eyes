import { expect, test } from "bun:test";
import { Incoming, Analysis, parseAnalysis, messageKey } from "../src/contracts";
import { validateImage } from "../src/images";

test("accept image-only feedback and reject an empty message", () => {
  const base = { messageId: "1", conversation: "group:1", sender: "u" };
  expect(Incoming.safeParse(base).success).toBe(false);
  expect(Incoming.safeParse({ ...base, images: [{ id: "screen", mime: "image/png", data: "aGVsbG8=" }] }).success).toBe(true);
});

test("deduplication isolates accounts and conversations", () => {
  const a = Incoming.parse({ messageId: "1", conversation: "g1", sender: "u", text: "hi" });
  expect(messageKey(a, "a/b")).not.toBe(messageKey({ ...a, conversation: "g2" }, "a/b"));
  expect(messageKey(a, "a/b")).toHaveLength(64);
});

test("a create result must contain an issue; QA needs no issue fields", () => {
  expect(Analysis.safeParse({ action: "create_issue", reply: "ok" }).success).toBe(false);
  expect(parseAnalysis('```json\n{"action":"qa","reply":"hello"}\n```').reply).toBe("hello");
});

test("reject MIME spoofing and malformed image bytes", () => {
  expect(() => validateImage({ id: "x", context: "test", mime: "image/png", data: Buffer.from("not a png").toString("base64") })).toThrow();
});
