import importlib.util
import base64
import io
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
        self.assertTrue(bridge.trusted_image_url("https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=fixture"))
        for url in ["file:///etc/passwd", "http://127.0.0.1/private", "https://qq.com.evil.example/x", "https://qq.com:123/x", "https://a@qq.com/x", "http://multimedia.nt.qq.com.cn/x", "https://multimedia.nt.qq.com.cn.evil.example/x", "https://evil.multimedia.nt.qq.com.cn/x", "https://other.qq.com.cn/x"]:
            self.assertFalse(bridge.trusted_image_url(url))

    def test_screenshot_normalization_removes_metadata_and_bounds_dimensions(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is installed by CI and the AstrBot plugin environment")
        original = Image.new("RGB", (2400, 100), "red")
        exif = original.getexif()
        exif[0x010E] = "private-fixture-metadata"
        encoded = io.BytesIO()
        original.save(encoded, format="JPEG", exif=exif)
        class Opener:
            def open(self, *args, **kwargs): return io.BytesIO(encoded.getvalue())
        with patch.object(bridge.urllib.request, "build_opener", return_value=Opener()):
            result = bridge.download_image("https://gchat.qpic.cn/test.jpg", "test", "fixture")
        data = base64.b64decode(result["data"])
        self.assertNotIn(b"private-fixture-metadata", data)
        with Image.open(io.BytesIO(data)) as image:
            self.assertLessEqual(max(image.size), 2048)
            self.assertFalse(image.getexif())


if __name__ == "__main__":
    unittest.main()
