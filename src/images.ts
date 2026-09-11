import { createHash } from "node:crypto";
import type { ImageInput } from "./contracts";

export function validateImage(image: ImageInput) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Invalid image encoding");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > 4_000_000 || bytes.length < 12) throw new Error("Image size is outside the allowed range");
  const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!({ "image/png": png, "image/jpeg": jpeg, "image/webp": webp })[image.mime]) throw new Error("Image bytes do not match MIME type");
  return { ...image, bytes, hash: createHash("sha256").update(bytes).digest("hex"), extension: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mime] };
}
