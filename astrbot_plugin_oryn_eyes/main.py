from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api.message_components import Plain
from astrbot.api import logger
from .bridge import Recent, api, download_image


def image_urls(components) -> list[str]:
    urls = []
    for component in components or []:
        kind = component.__class__.__name__
        if kind == "Image":
            value = getattr(component, "url", None) or getattr(component, "file", None)
            if isinstance(value, str) and value.startswith("https://"):
                urls.append(value)
        if kind == "Reply":
            urls.extend(image_urls(getattr(component, "chain", None)))
    return list(dict.fromkeys(urls))


class OrynEyesPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.base = os.getenv("ORYN_EYES_URL", "http://127.0.0.1:18080")
        token_file = Path(os.getenv("ORYN_EYES_TOKEN_FILE", str(Path.home() / ".config/oryn-eyes/bridge.token")))
        self.token = token_file.read_text().strip()
        self.budget = int(os.getenv("ORYN_EYES_BUDGET_SECONDS", "900"))
        self.recent = Recent()
        self.active: dict[tuple[str, str], str] = {}
        self.seen: dict[str, float] = {}
        logger.info("Oryn Eyes bridge loaded: multimodal support, ephemeral context")

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        obj = event.message_obj
        components = getattr(obj, "message", []) or []
        conversation = str(event.unified_msg_origin)
        sender = str(event.get_sender_id())
        message_id = str(getattr(obj, "message_id", ""))
        bot_id = str(event.get_self_id())
        if sender == bot_id:
            return
        text = (event.message_str or "").strip()
        images = image_urls(components)
        at_bot = any(c.__class__.__name__ == "At" and str(getattr(c, "qq", "")) == bot_id for c in components)
        trigger = event.is_private_chat() or at_bot
        previous = self.recent.context(conversation, sender)
        if not trigger:
            if text or images:
                self.recent.add(conversation, sender, text, images)
            return
        event.stop_event()
        text = re.sub(r"<at[^>]*>.*?</at>|<at[^>]*>|\[CQ:at[^\]]*\]", "", text).strip()
        if not text and not images:
            yield event.chain_result([Plain("👁️ 我在。可以描述遇到的问题，或附上截图；我会答疑、查已有记录，必要时直接创建 YourTJ-Hub Issue。")])
            return
        key = (conversation, sender)
        if text.lower() in ("stop", "/stop", "停止", "取消"):
            job_id = self.active.get(key)
            if job_id:
                await asyncio.to_thread(api, self.base, self.token, f"/v1/jobs/{job_id}/cancel", {"conversation": conversation, "sender": sender})
            yield event.chain_result([Plain("⏹️ 已请求停止本次处理。" if job_id else "目前没有你的正在处理的反馈。")])
            return
        dedup = conversation + ":" + message_id
        now = time.time()
        self.seen = {k: v for k, v in self.seen.items() if now - v < 1800}
        if dedup in self.seen:
            return
        self.seen[dedup] = now
        yield event.chain_result([Plain("👁️ 收到，我会结合消息和截图查一下；如果是新问题，会直接记录到 YourTJ-Hub。")])

        history = [{"role": e["role"], "text": e["text"]} for e in previous]
        for component in components:
            if component.__class__.__name__ != "Reply":
                continue
            quoted = getattr(component, "text", None)
            if quoted:
                history.append({"role": "quoted", "text": str(quoted)[:6000]})
            # OneBot Reply may carry only an ID; fetch the quoted message explicitly.
            reply_id = getattr(component, "id", None)
            bot = getattr(event, "bot", None)
            if reply_id and bot and hasattr(bot, "api"):
                try:
                    parent = await asyncio.wait_for(bot.api.call_action("get_msg", message_id=int(reply_id)), timeout=10)
                    parent = parent.get("data", parent)
                    for segment in parent.get("message", []):
                        if not isinstance(segment, dict):
                            continue
                        data = segment.get("data", {})
                        if segment.get("type") == "text":
                            history.append({"role": "quoted", "text": str(data.get("text", ""))[:6000]})
                        if segment.get("type") == "image" and data.get("url"):
                            images.append(data["url"])
                except Exception:
                    logger.warning("Oryn Eyes could not retrieve the quoted message")

        sources = [(url, "当前消息或明确引用的截图") for url in images]
        sources += [(url, "同一用户近期消息中的截图，可能与本次追问相关") for e in previous for url in e["images"]]
        unique_sources = {}
        for url, context in sources:
            unique_sources.setdefault(url, context)
        sources = list(unique_sources.items())[:6]
        attachments = []
        failed_images = 0
        for index, (url, context) in enumerate(sources):
            try:
                attachments.append(await asyncio.to_thread(download_image, url, f"image_{index + 1}", context))
            except Exception:
                failed_images += 1
                logger.warning("Oryn Eyes image unavailable; bytes and URL omitted from logs")
        if failed_images:
            history.append({"role": "quoted", "text": f"有 {failed_images} 张图片无法读取；不能声称已看过这些图片，必要时请用户重发。"})
        if not text and not attachments:
            yield event.chain_result([Plain("🖼️ 我没能读取这张图片，请重新发送，或补充截图里的报错文字。")])
            return
        payload = {"messageId": message_id, "conversation": conversation, "sender": sender, "text": text, "images": attachments, "history": history[-12:]}
        self.recent.add(conversation, sender, text, images)
        job_id = None
        try:
            accepted = await asyncio.to_thread(api, self.base, self.token, "/v1/messages", payload)
            job_id = accepted["id"]
            self.active[key] = job_id
            start = time.monotonic()
            progress_sent = False
            poll_failures = 0
            while time.monotonic() - start < self.budget + 60:
                await asyncio.sleep(2)
                try:
                    state = await asyncio.to_thread(api, self.base, self.token, f"/v1/jobs/{job_id}")
                    poll_failures = 0
                except Exception:
                    poll_failures += 1
                    if poll_failures >= 3:
                        raise
                    continue
                if state["status"] in ("completed", "failed", "cancelled"):
                    reply = state.get("reply") or "⚠️ 本次处理结束，但没有可发送的结果。"
                    self.recent.add(conversation, sender, reply, [], role="assistant")
                    yield event.chain_result([Plain(reply)])
                    return
                if not progress_sent and time.monotonic() - start > 60:
                    progress_sent = True
                    yield event.chain_result([Plain("🔎 还在核对仓库证据：" + state.get("stage", "处理中") + "。可以 @我发送 stop 停止。")])
            await asyncio.to_thread(api, self.base, self.token, f"/v1/jobs/{job_id}/cancel", {"conversation": conversation, "sender": sender})
            yield event.chain_result([Plain("⏱️ 等待超时，已请求停止本次处理；请稍后重试。")])
        except Exception as error:
            logger.error("Oryn Eyes bridge failure: %s", type(error).__name__)
            self.seen.pop(dedup, None)
            yield event.chain_result([Plain("⚠️ 暂时无法取得处理结果。若已创建 Issue，重复投递同一条消息会返回原链接。")])
        finally:
            if job_id and self.active.get(key) == job_id:
                self.active.pop(key, None)

    async def terminate(self):
        self.recent.entries.clear()
        self.seen.clear()
        logger.info("Oryn Eyes bridge stopped; ephemeral context cleared")
