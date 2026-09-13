"""Find source-neutral near-duplicate shapes from sealed multiview evidence.

This worker deliberately receives only content identities and render channels. It
never receives archive names, vendor directories, filenames, labels, or semantic
hypotheses. The perceptual signature is a conservative leakage-control signal,
not catalog authority and not a semantic embedding.
"""

import argparse
import hashlib
import io
import json
import os
import platform
from pathlib import Path

from PIL import Image, __version__ as PILLOW_VERSION


ALGORITHM_ID = "multiview_shape_dhash_ahash_8x8"
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_ITEMS = 100_000
MAX_RELATIONS = 1_000_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    return parser.parse_args()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def require_regular(path, workspace_root):
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("near-duplicate evidence paths must be absolute")
    resolved = candidate.resolve(strict=True)
    root = Path(workspace_root).resolve(strict=True)
    if resolved != candidate or resolved != root and root not in resolved.parents:
        raise ValueError("near-duplicate evidence path escapes the workspace or follows a symlink")
    status = candidate.lstat()
    if not candidate.is_file() or candidate.is_symlink() or status.st_size > MAX_IMAGE_BYTES:
        raise ValueError("near-duplicate evidence must be a bounded regular non-symlink file")
    return candidate


def verified_image(path, expected_hash, workspace_root):
    source = require_regular(path, workspace_root)
    payload = source.read_bytes()
    if not payload.startswith(PNG_SIGNATURE):
        raise ValueError("near-duplicate evidence is not PNG")
    if sha256_bytes(payload) != expected_hash:
        raise ValueError("near-duplicate render evidence hash changed")
    image = Image.open(io.BytesIO(payload))
    image.load()
    if image.width < 8 or image.height < 8 or image.width > 4096 or image.height > 4096:
        raise ValueError("near-duplicate render dimensions are outside the admitted range")
    return image


def append_bits(signature, value, width):
    return (signature << width) | value


def average_hash(image):
    pixels = list(image.convert("L").resize((8, 8), Image.Resampling.LANCZOS).getdata())
    average = sum(pixels) / len(pixels)
    value = 0
    for pixel in pixels:
        value = (value << 1) | int(pixel >= average)
    return value, 64


def difference_hash(image):
    pixels = list(image.convert("L").resize((9, 8), Image.Resampling.LANCZOS).getdata())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | int(pixels[y * 9 + x] >= pixels[y * 9 + x + 1])
    return value, 64


def rgb_difference_hash(image):
    resized = image.convert("RGB").resize((9, 8), Image.Resampling.LANCZOS)
    channels = resized.split()
    signature = 0
    bits = 0
    for channel in channels:
        value, width = difference_hash(channel)
        signature = append_bits(signature, value, width)
        bits += width
    return signature, bits


def descriptor(item, workspace_root):
    signature = 0
    bit_count = 0
    inputs = []
    views = item.get("views")
    if not isinstance(views, list) or len(views) != 12:
        raise ValueError("near-duplicate descriptors require twelve canonical views")
    for view in views:
        silhouette = verified_image(
            view.get("silhouettePath"), view.get("silhouetteHash"), workspace_root
        )
        depth = verified_image(
            view.get("normalizedDepthPath"), view.get("normalizedDepthHash"), workspace_root
        )
        normal = verified_image(
            view.get("surfaceNormalPath"), view.get("surfaceNormalHash"), workspace_root
        )
        inputs.extend(
            [
                view.get("silhouetteHash"),
                view.get("normalizedDepthHash"),
                view.get("surfaceNormalHash"),
            ]
        )
        for value, width in (
            average_hash(silhouette),
            difference_hash(silhouette),
            difference_hash(depth),
            rgb_difference_hash(normal),
        ):
            signature = append_bits(signature, value, width)
            bit_count += width
    material = {
        "algorithmId": ALGORITHM_ID,
        "sourceContentHash": item.get("sourceContentHash"),
        "renderHashes": inputs,
        "signatureHex": format(signature, f"0{(bit_count + 3) // 4}x"),
        "bitCount": bit_count,
    }
    return {
        "sourceContentHash": item.get("sourceContentHash"),
        "descriptorHash": sha256_bytes(canonical_json(material).encode("utf8")),
        "signature": signature,
        "bitCount": bit_count,
    }


def analyze(job):
    items = job.get("items")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ValueError("near-duplicate item inventory is invalid")
    threshold = job.get("similarityThreshold")
    numerator = threshold.get("numerator") if isinstance(threshold, dict) else None
    denominator = threshold.get("denominator") if isinstance(threshold, dict) else None
    if (
        not isinstance(numerator, int)
        or not isinstance(denominator, int)
        or numerator <= 0
        or numerator >= denominator
    ):
        raise ValueError("near-duplicate similarity threshold is invalid")
    ordered = sorted(items, key=lambda item: item.get("sourceContentHash", ""))
    sources = [item.get("sourceContentHash") for item in ordered]
    if any(not isinstance(value, str) or len(value) != 64 for value in sources):
        raise ValueError("near-duplicate source identity is invalid")
    if len(set(sources)) != len(sources):
        raise ValueError("near-duplicate source identities must be unique")

    descriptors = [descriptor(item, job.get("workspaceRoot")) for item in ordered]
    bit_counts = {entry["bitCount"] for entry in descriptors}
    if len(bit_counts) > 1:
        raise ValueError("near-duplicate shape descriptors have different dimensions")
    total_bits = next(iter(bit_counts), 0)
    relations = []
    compared = 0
    for left_index, left in enumerate(descriptors):
        for right in descriptors[left_index + 1 :]:
            compared += 1
            distance = (left["signature"] ^ right["signature"]).bit_count()
            if distance * denominator > total_bits * (denominator - numerator):
                continue
            relations.append(
                {
                    "leftSourceContentHash": left["sourceContentHash"],
                    "rightSourceContentHash": right["sourceContentHash"],
                    "leftDescriptorHash": left["descriptorHash"],
                    "rightDescriptorHash": right["descriptorHash"],
                    "distanceBits": distance,
                    "totalBits": total_bits,
                }
            )
            if len(relations) > MAX_RELATIONS:
                raise ValueError("near-duplicate relation budget exceeded")
    descriptor_material = [
        {
            "sourceContentHash": entry["sourceContentHash"],
            "descriptorHash": entry["descriptorHash"],
            "bitCount": entry["bitCount"],
        }
        for entry in descriptors
    ]
    return {
        "kind": "CatalogNearDuplicateWorkerOutput",
        "algorithmId": ALGORITHM_ID,
        "runtime": {
            "python": platform.python_version(),
            "pillow": PILLOW_VERSION,
        },
        "descriptorSetHash": sha256_bytes(canonical_json(descriptor_material).encode("utf8")),
        "searchedSourceContentHashes": sources,
        "comparedPairCount": compared,
        "relations": relations,
        "diagnostics": [],
    }


def write_atomic(path, value):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() and (destination.is_symlink() or not destination.is_file()):
        raise ValueError("near-duplicate output must be a regular non-symlink file")
    temporary = destination.parent / f".{destination.name}.{os.getpid()}.tmp"
    with temporary.open("x", encoding="utf8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        handle.write("\n")
    os.replace(temporary, destination)


def main():
    options = arguments()
    job_path = Path(options.job)
    if not job_path.is_file() or job_path.is_symlink():
        raise ValueError("near-duplicate job must be a regular non-symlink file")
    with job_path.open(encoding="utf8") as handle:
        job = json.load(handle)
    result = analyze(job)
    write_atomic(job.get("outputPath"), result)
    print(
        canonical_json(
            {
                "searched": len(result["searchedSourceContentHashes"]),
                "comparedPairs": result["comparedPairCount"],
                "relations": len(result["relations"]),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
