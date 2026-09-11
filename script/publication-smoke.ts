import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { GitHub } from "../src/github";
import { IssueDraft } from "../src/contracts";
import { renderIssue } from "../src/render";

if (!process.argv.includes("--live-write")) throw new Error("This probe creates and closes an explicitly labelled verification Issue; pass --live-write intentionally");
const repository = process.env.ORYN_REPOSITORY || "YourTongji/YourTJ-Hub";
if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
const gh = new GitHub(repository, process.env.GITHUB_TOKEN);
const metadata = await gh.metadata();
if (metadata.private) throw new Error("The public-image probe requires a public target repository");
const labels = z.array(z.object({ name: z.string() })).parse(await gh.api(`/repos/${repository}/labels?per_page=100`));
const hold = labels.find(l => /oryn.*hold/i.test(l.name));
if (!hold) throw new Error("An Oryn hold label must exist to keep this verification out of the repair queue");
const sha = await gh.head(metadata.default_branch);
function chunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(96, 0); header.writeUInt32BE(96, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc(96 * 289);
for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) pixels[y * 289 + 1 + x * 3 + 2] = 255;
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
const image = await gh.publishImage({ id: "verification", mime: "image/png", data: png.toString("base64"), context: "generated verification image" }, sha);
let publiclyReadable = false;
for (let attempt = 0; attempt < 3; attempt++) {
  const response = await fetch(image.url, { signal: AbortSignal.timeout(30_000) });
  if (response.ok && Buffer.from(await response.arrayBuffer()).equals(png)) { publiclyReadable = true; break; }
  await Bun.sleep(1000);
}
assert.ok(publiclyReadable, "Screenshot must be readable without credentials and match the original bytes");
const key = crypto.randomUUID().replaceAll("-", "");
const issue = IssueDraft.parse({ kind: "docs", title: "test: Oryn Eyes 链路验收（非产品问题）", description: "这是部署 Oryn Eyes 时执行的自动化验收，不是用户 Bug 或功能需求。用于验证标准正文、公开截图、GitHub 建单与重复投递恢复。验收脚本会立即关闭本条记录。", environment: "自动化验收环境；无真实用户数据", steps: ["上传自动生成的纯色图片", "创建带有暂停标签的验收单", "重复提交同一投递标记，确认复用原 Issue", "关闭验收单"], expected: "图片可匿名读取；重复投递只生成一个 Issue。", actual: "由验收脚本校验后报告结果。", screenshotIds: ["verification"] });
let number: number | undefined;
try {
  const body = renderIssue(issue, { repository, sha, key, images: [image], searches: 0 });
  const created = await gh.create(issue.title, body, [hold.name, "👁️ oryn-eyes"], key); number = created.number;
  const repeated = await gh.create(issue.title, body, [hold.name, "👁️ oryn-eyes"], key);
  assert.equal(repeated.number, created.number);
  console.log(JSON.stringify({ passed: true, issue: created.html_url, publicImage: true, duplicateReused: true, holdLabel: hold.name }));
} finally {
  if (number) {
    await gh.api(`/repos/${repository}/issues/${number}`, "PATCH", { state: "closed", state_reason: "not_planned" });
    console.log(JSON.stringify({ verificationIssueClosed: number }));
  }
}
