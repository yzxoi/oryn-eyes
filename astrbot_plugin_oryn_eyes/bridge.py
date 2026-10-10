from __future__ import annotations

import base64
import io
import json
import time
import urllib.request
import urllib.parse
from collections import OrderedDict


def response_wait_budget(accepted: dict, fallback: int) -> float:
    value = accepted.get("timeoutSeconds", fallback)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= 10200:
        return fallback
    return value


def trusted_image_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    trusted_host = host == "multimedia.nt.qq.com.cn" or any(
        host == domain or host.endswith("." + domain) for domain in ("qq.com", "qpic.cn", "gtimg.cn")
    )
    return parsed.scheme == "https" and not parsed.username and parsed.port in (None, 443) and trusted_host


class ImageRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not trusted_image_url(newurl):
            raise ValueError("Image redirect left the QQ CDN")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_image(url: str, image_id: str, context: str) -> dict:
    if not trusted_image_url(url):
        raise ValueError("Unsupported image source")
    opener = urllib.request.build_opener(ImageRedirect())
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "Oryn-Eyes/1"}), timeout=20) as response:
        data = response.read(8_000_001)
    return normalize_image(data, image_id, context)


def normalize_image(data: bytes, image_id: str, context: str) -> dict:
    from PIL import Image, ImageOps

    if len(data) > 8_000_000:
        raise ValueError("Screenshot exceeds 8 MB")
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 25_000_000:
            raise ValueError("Screenshot dimensions exceed limit")
        image.seek(0)
        normalized = ImageOps.exif_transpose(image).convert("RGB")
        normalized.thumbnail((2048, 2048))
        normalized.info.clear()
        output = io.BytesIO()
        normalized.save(output, format="PNG")
        mime = "image/png"
        if output.tell() > 4_000_000:
            output = io.BytesIO()
            normalized.save(output, format="JPEG", quality=88)
            mime = "image/jpeg"
        if output.tell() > 4_000_000:
            raise ValueError("Normalized screenshot exceeds 4 MB")
    return {"id": image_id, "mime": mime, "data": base64.b64encode(output.getvalue()).decode(), "context": context}


class Recent:
    def __init__(self, ttl: int = 1800, maximum: int = 200):
        self.ttl, self.maximum = ttl, maximum
        self.entries: OrderedDict[str, list[dict]] = OrderedDict()

    def add(self, conversation: str, sender: str, text: str, images: list[str], role: str = "user"):
        now = time.time()
        self._expire(now)
        entries = self.entries.setdefault(conversation, [])
        entries.append({"sender": sender, "text": text[:6000], "images": images[:6], "time": now, "role": role})
        self.entries[conversation] = entries[-30:]
        self.entries.move_to_end(conversation)
        while len(self.entries) > self.maximum:
            self.entries.popitem(last=False)

    def context(self, conversation: str, sender: str) -> list[dict]:
        self._expire(time.time())
        return [e for e in self.entries.get(conversation, []) if e["sender"] == sender][-6:]

    def _expire(self, now: float):
        for key in list(self.entries):
            self.entries[key] = [e for e in self.entries[key] if now - e["time"] < self.ttl]
            if not self.entries[key]:
                del self.entries[key]


def api(base: str, token: str, route: str, payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        base.rstrip("/") + route,
        data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())
