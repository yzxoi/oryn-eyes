import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { runHarness } from "../src/runner";
import { Settings } from "../src/config";
import { Incoming } from "../src/contracts";
import { modelDefinition } from "../src/model";

const live = process.argv.includes("--live");
const invalidScreenshot = process.argv.includes("--invalid-screenshot");
if (live && invalidScreenshot) throw new Error("Invalid screenshot fixture is local-only");
let invalidScreenshotIssued = false, screenshotCorrectionSeen = false;
const key = process.env.ORYN_API_KEY;
if (live && !key) throw new Error("ORYN_API_KEY is required for the live probe");
const modelID = process.env.ORYN_MODEL || "glm-5.3-flash";
const definition = modelDefinition(modelID, "max");
const variant = definition.variants!.max as { reasoningEffort?: string; thinking?: { type: "enabled" }; chat_template_kwargs?: { enable_thinking: boolean } };
const temp = await mkdtemp(path.join(tmpdir(), "eyes-smoke-"));
const workspace = path.join(temp, "workspace"); await mkdir(workspace);
const sentinel = "SOURCE_" + crypto.randomUUID();
const webSentinel = "SEARCH_" + crypto.randomUUID();
const color = Math.random() < 0.5 ? "red" : "blue";
await Bun.write(path.join(workspace, "evidence.txt"), sentinel);
function chunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(128, 0); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc(128 * 385);
for (let row = 0; row < 128; row++) for (let col = 0; col < 128; col++) pixels[row * 385 + 1 + col * 3 + (color === "red" ? 0 : 2)] = 255;
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
let requests = 0, imageRequests = 0, sourceSeen = false, webSeen = false, reasoningSeen = false, searches = 0;
const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { searches++; return Response.json({ result: webSentinel }); } });
const gatewayURL = `http://127.0.0.1:${gateway.port}/evidence`;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
  const body = await request.json() as { model: string; reasoning_effort?: string; thinking?: { type: string }; chat_template_kwargs?: { enable_thinking: boolean }; messages: { role: string; content: unknown; reasoning_content?: string; tool_call_id?: string }[] };
  assert.equal(body.model, modelID);
  if (variant.reasoningEffort) assert.equal(body.reasoning_effort, variant.reasoningEffort);
  if (variant.thinking) assert.deepEqual(body.thinking, variant.thinking);
  if (variant.chat_template_kwargs) assert.deepEqual(body.chat_template_kwargs, variant.chat_template_kwargs);
  requests++;
  screenshotCorrectionSeen ||= JSON.stringify(body.messages).includes("screenshotIds referenced an unavailable image");
  for (const message of body.messages) {
    if (message.role === "tool") { sourceSeen ||= JSON.stringify(message.content).includes(sentinel); webSeen ||= JSON.stringify(message.content).includes(webSentinel); }
    reasoningSeen ||= message.role === "assistant" && Boolean(message.reasoning_content);
    if (Array.isArray(message.content) && message.content.some(p => p.type === "image_url" && p.image_url?.url === `data:image/png;base64,${png.toString("base64")}`)) imageRequests++;
  }
  if (live) {
    const upstream = (process.env.ORYN_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4").replace(/\/+$/, "");
    const response = await fetch(`${upstream}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: request.signal, redirect: "error" });
    if (!response.ok) return Response.json({ error: { message: `Provider returned HTTP ${response.status}` } }, { status: response.status });
    return new Response(response.body, { headers: { "Content-Type": "text/event-stream" } });
  }
  const done = sourceSeen && webSeen;
  const injectInvalidScreenshot = done && invalidScreenshot && !invalidScreenshotIssued;
  invalidScreenshotIssued ||= injectInvalidScreenshot;
  const delta = done ? { role: "assistant", content: JSON.stringify(injectInvalidScreenshot ? {
    action: "create_issue", reply: "fixture result", issue: { kind: "bug", title: "bug: fixture issue", description: "Synthetic screenshot reference validation fixture.", screenshotIds: ["invented_screenshot"] },
  } : { action: "qa", reply: `${sentinel} ${webSentinel} ${color}` }) } : {
    role: "assistant", reasoning_content: "Inspect the evidence before answering.", tool_calls: [{ index: 0, id: sourceSeen ? "search" : "source", type: "function", function: { name: sourceSeen ? "webfetch" : "read", arguments: JSON.stringify(sourceSeen ? { url: gatewayURL + "/search", format: "text" } : { filePath: "evidence.txt" }) } }],
  };
  const event = (d: unknown, finish: string | null) => ({ id: "eyes-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: d, finish_reason: finish }] });
  return new Response(`data: ${JSON.stringify(event(delta, null))}\n\ndata: ${JSON.stringify(event({}, done ? "stop" : "tool_calls"))}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
} });
try {
  const settings = Settings.parse({ repository: "yzxoi/oryn-eyes", githubToken: "unused", apiKey: "local-probe", bridgeToken: "fixture-bridge-token-long-enough", baseURL: `http://127.0.0.1:${proxy.port}/v1`, model: modelID, budget: live ? 900 : 90, tempRoot: temp, publish: false });
  const images = Incoming.parse({ messageId: "fixture", conversation: "fixture", sender: "fixture", images: [{ id: "screen", mime: "image/png", data: png.toString("base64"), context: "visual verification" }] }).images;
  const result = await runHarness(settings, workspace, `Read evidence.txt with read and fetch ${gatewayURL}/search with webfetch. Describe the dominant color of the attached image using its English color name. Return action=qa and reply containing the EXACT text evidence token, EXACT search result token, and image color. Do not invent any token.`, images, gatewayURL);
  assert.equal(result.action, "qa"); assert.ok(result.reply.includes(sentinel)); assert.ok(result.reply.includes(webSentinel)); assert.ok(result.reply.toLowerCase().includes(color));
  assert.ok(imageRequests > 0, "Core must send actual image bytes"); assert.ok(sourceSeen); assert.ok(webSeen); assert.ok(searches > 0); assert.ok(reasoningSeen, "Tool continuation must retain reasoning_content");
  if (invalidScreenshot) { assert.ok(invalidScreenshotIssued); assert.ok(screenshotCorrectionSeen, "Invalid screenshot IDs must reach the bounded correction prompt"); }
  console.log(JSON.stringify({ passed: true, live, model: modelID, requests, imageRequests, sourceSeen, webSeen, reasoningSeen, imageUnderstood: true, contextConfigured: definition.limit.context, reasoningEffort: "max" }));
} finally { proxy.stop(true); gateway.stop(true); await rm(temp, { recursive: true, force: true }); }
