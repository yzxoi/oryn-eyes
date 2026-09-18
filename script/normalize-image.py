import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astrbot_plugin_oryn_eyes.bridge import normalize_image

if __name__ == "__main__":
    print(json.dumps(normalize_image(sys.stdin.buffer.read(8_000_001), "image", "screenshot")))
