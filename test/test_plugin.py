import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch


class At:
    def __init__(self, qq): self.qq = qq


class Image:
    def __init__(self, url): self.url = url


class Plain:
    def __init__(self, text): self.text = text


class Star:
    def __init__(self, context): pass


class Event:
    unified_msg_origin = "group:test"
    message_str = ""
    stopped = False
    def __init__(self, mentioned=True):
        self.message_obj = types.SimpleNamespace(message_id="1", message=[Image("https://gchat.qpic.cn/test.png")] + ([At("bot")] if mentioned else []))
    def get_self_id(self): return "bot"
    def get_sender_id(self): return "sender"
    def is_private_chat(self): return False
    def stop_event(self): self.stopped = True
    def chain_result(self, parts): return parts


def load_plugin():
    modules = {}
    for name in ["astrbot", "astrbot.api", "astrbot.api.event", "astrbot.api.star", "astrbot.api.message_components"]:
        modules[name] = types.ModuleType(name)
    modules["astrbot.api.event"].filter = types.SimpleNamespace(EventMessageType=types.SimpleNamespace(ALL="all"), event_message_type=lambda _: lambda f: f)
    modules["astrbot.api.event"].AstrMessageEvent = Event
    modules["astrbot.api.star"].Context = object
    modules["astrbot.api.star"].Star = Star
    modules["astrbot.api.message_components"].Plain = Plain
    modules["astrbot.api"].logger = types.SimpleNamespace(info=lambda *a: None, warning=lambda *a: None, error=lambda *a: None)
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location("astrbot_plugin_oryn_eyes.main", Path(__file__).parents[1] / "astrbot_plugin_oryn_eyes/main.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class PluginTest(unittest.IsolatedAsyncioTestCase):
    async def test_astrbot_can_consume_receipt_and_final_reply_before_stop(self):
        module = load_plugin()
        with tempfile.NamedTemporaryFile(mode="w") as token:
            token.write("test-token"); token.flush()
            with patch.dict(os.environ, {"ORYN_EYES_TOKEN_FILE": token.name}): plugin = module.OrynEyesPlugin(None)
        payloads = []
        def api(_base, _token, route, payload=None):
            if route == "/v1/messages": payloads.append(payload); return {"id": "job"}
            return {"status": "completed", "reply": "验收通过"}
        async def call(fn, *args): return fn(*args)
        event = Event()
        replies = []
        with patch.object(module, "api", api), patch.object(module, "download_image", lambda *a: {"id": "image_1", "mime": "image/png", "data": "fixture", "context": "current"}), patch.object(module.asyncio, "to_thread", call), patch.object(module.asyncio, "sleep", AsyncMock()):
            async for result in plugin.on_message(event):
                if event.stopped: break  # Mirrors AstrBot's real scheduler.
                replies.extend(p.text for p in result)
        self.assertEqual(len(replies), 2)
        self.assertIn("收到", replies[0])
        self.assertEqual(replies[1], "验收通过")
        self.assertEqual(len(payloads), 1)
        self.assertEqual(len(payloads[0]["images"]), 1)
        self.assertTrue(event.stopped)

    async def test_unmentioned_group_images_are_context_without_stopping_other_handlers(self):
        module = load_plugin()
        plugin = module.OrynEyesPlugin.__new__(module.OrynEyesPlugin)
        plugin.recent = module.Recent()
        event = Event(mentioned=False)
        results = [result async for result in plugin.on_message(event)]
        self.assertEqual(results, [])
        self.assertFalse(event.stopped)
        self.assertEqual(len(plugin.recent.context("group:test", "sender")[0]["images"]), 1)


if __name__ == "__main__": unittest.main()
