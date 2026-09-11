import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "astrbot_plugin_oryn_eyes/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def test_history_is_scoped_to_user_and_expires(self):
        recent = bridge.Recent(ttl=30)
        with patch.object(bridge.time, "time", return_value=100):
            recent.add("g", "a", "my issue", ["image"])
            recent.add("g", "b", "unrelated", [])
            self.assertEqual([e["text"] for e in recent.context("g", "a")], ["my issue"])
        with patch.object(bridge.time, "time", return_value=131):
            self.assertEqual(recent.context("g", "a"), [])

    def test_downloads_only_qq_https_cdn_images(self):
        self.assertTrue(bridge.trusted_image_url("https://multimedia.nt.qq.com/download?x=1"))
        for url in ["file:///etc/passwd", "http://127.0.0.1/private", "https://qq.com.evil.example/x", "https://qq.com:123/x", "https://a@qq.com/x"]:
            self.assertFalse(bridge.trusted_image_url(url))


if __name__ == "__main__":
    unittest.main()
