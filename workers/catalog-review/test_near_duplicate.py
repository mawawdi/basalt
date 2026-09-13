import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("near_duplicate.py")
SPEC = importlib.util.spec_from_file_location("basalt_near_duplicate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class NearDuplicateWorkerTest(unittest.TestCase):
    def test_identical_multiview_shapes_are_joined_without_source_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first = self.item(root, "1" * 64, False)
            second = self.item(root, "2" * 64, False)
            third = self.item(root, "3" * 64, True)
            result = MODULE.analyze(
                {
                    "workspaceRoot": str(root),
                    "similarityThreshold": {"numerator": 97, "denominator": 100},
                    "items": [third, first, second],
                }
            )
            self.assertEqual(result["searchedSourceContentHashes"], ["1" * 64, "2" * 64, "3" * 64])
            self.assertEqual(result["comparedPairCount"], 3)
            self.assertEqual(len(result["relations"]), 1)
            relation = result["relations"][0]
            self.assertEqual(relation["leftSourceContentHash"], "1" * 64)
            self.assertEqual(relation["rightSourceContentHash"], "2" * 64)
            self.assertNotIn("origin", str(result).lower())

    def item(self, root, source_hash, inverted):
        views = []
        asset_root = root / source_hash
        asset_root.mkdir()
        for index in range(12):
            paths = {}
            for channel in ("silhouette", "depth", "normal"):
                path = asset_root / f"{index:02d}-{channel}.png"
                image = Image.new("RGB", (32, 32), "black" if inverted else "white")
                for offset in range(8, 24):
                    image.putpixel(
                        (offset, (offset + index) % 24 + 4),
                        (255, 255, 255) if inverted else (0, 0, 0),
                    )
                image.save(path)
                payload = path.read_bytes()
                paths[channel] = (str(path), hashlib.sha256(payload).hexdigest())
            views.append(
                {
                    "viewId": f"view_{index:02d}",
                    "silhouettePath": paths["silhouette"][0],
                    "silhouetteHash": paths["silhouette"][1],
                    "normalizedDepthPath": paths["depth"][0],
                    "normalizedDepthHash": paths["depth"][1],
                    "surfaceNormalPath": paths["normal"][0],
                    "surfaceNormalHash": paths["normal"][1],
                }
            )
        return {"sourceContentHash": source_hash, "views": views}


if __name__ == "__main__":
    unittest.main()
