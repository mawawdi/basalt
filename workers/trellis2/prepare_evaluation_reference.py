#!/usr/bin/env python3
"""Materialize one exact masked RGBA reference for a bounded TRELLIS evaluation.

This utility performs no model call. It applies the retained segmentation mask
as straight alpha, crops the nonzero mask with bounded padding, and centers the
result on a transparent square canvas without changing its aspect ratio.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any

from PIL import Image, __version__ as pillow_version


MAXIMUM_INPUT_BYTES = 32 * 1024 * 1024
OUTPUT_EDGE = 512
CONTENT_EDGE = 448
PADDING_PIXELS = 12


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_regular(path_value: str, label: str) -> tuple[Path, bytes]:
    path = Path(path_value)
    resolved = path.resolve(strict=True)
    require(resolved == path.absolute(), f"{label} path must be canonical")
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(0 < metadata.st_size <= MAXIMUM_INPUT_BYTES, f"{label} exceeds its byte bound")
    return resolved, resolved.read_bytes()


def write_absent(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--output-root", required=True)
    arguments = parser.parse_args()

    source_path, source_bytes = read_regular(arguments.source, "source image")
    mask_path, mask_bytes = read_regular(arguments.mask, "segmentation mask")
    rights_path, rights_bytes = read_regular(arguments.rights, "rights statement")
    rights_text = rights_bytes.decode("utf-8").strip()
    require(rights_text != "", "rights statement must be nonempty UTF-8")

    output_root = Path(arguments.output_root)
    require(output_root.is_absolute(), "output root must be absolute")
    require(output_root.parent.is_dir(), "output root parent must already exist")
    output_root.mkdir(mode=0o700)

    with Image.open(source_path) as source_file:
        source = source_file.convert("RGB")
    with Image.open(mask_path) as mask_file:
        mask = mask_file.convert("L")
    require(source.size == mask.size, "source and mask dimensions differ")
    require(source.size == (512, 512), "this evaluation reference requires exact 512x512 inputs")

    nonzero_bbox = mask.getbbox()
    require(nonzero_bbox is not None, "segmentation mask contains no selected pixels")
    left, top, right, bottom = nonzero_bbox
    crop_box = (
        max(0, left - PADDING_PIXELS),
        max(0, top - PADDING_PIXELS),
        min(source.width, right + PADDING_PIXELS),
        min(source.height, bottom + PADDING_PIXELS),
    )
    cropped_source = source.crop(crop_box)
    cropped_mask = mask.crop(crop_box)
    scale = min(CONTENT_EDGE / cropped_source.width, CONTENT_EDGE / cropped_source.height)
    resized_size = (
        max(1, round(cropped_source.width * scale)),
        max(1, round(cropped_source.height * scale)),
    )
    resized_source = cropped_source.resize(resized_size, Image.Resampling.LANCZOS)
    resized_mask = cropped_mask.resize(resized_size, Image.Resampling.LANCZOS)
    rgba = resized_source.convert("RGBA")
    rgba.putalpha(resized_mask)
    canvas = Image.new("RGBA", (OUTPUT_EDGE, OUTPUT_EDGE), (0, 0, 0, 0))
    offset = ((OUTPUT_EDGE - resized_size[0]) // 2, (OUTPUT_EDGE - resized_size[1]) // 2)
    canvas.alpha_composite(rgba, dest=offset)

    reference_path = output_root / "reference.png"
    canvas.save(reference_path, format="PNG", optimize=False, compress_level=9)
    reference_bytes = reference_path.read_bytes()
    alpha = canvas.getchannel("A")
    alpha_values = list(alpha.getdata())
    alpha_statistics = {
        "opaquePixels": sum(value == 255 for value in alpha_values),
        "translucentPixels": sum(0 < value < 255 for value in alpha_values),
        "transparentPixels": sum(value == 0 for value in alpha_values),
    }
    require(alpha_statistics["opaquePixels"] > 0, "prepared reference contains no opaque pixels")
    require(alpha_statistics["transparentPixels"] > 0, "prepared reference lacks transparency")

    write_absent(output_root / "rights.txt", rights_bytes)
    material = {
        "kind": "Trellis2EvaluationReferencePreparation",
        "abi": "basalt-trellis2-evaluation-reference-preparation@1",
        "source": {
            "path": str(source_path),
            "sha256": sha256_bytes(source_bytes),
            "bytes": len(source_bytes),
        },
        "mask": {
            "path": str(mask_path),
            "sha256": sha256_bytes(mask_bytes),
            "bytes": len(mask_bytes),
            "nonzeroBoundingBoxExclusive": [left, top, right, bottom],
        },
        "rights": {
            "path": str(rights_path),
            "sha256": sha256_bytes(rights_bytes),
            "bytes": len(rights_bytes),
            "statement": rights_text,
            "usage": "evaluation_only",
        },
        "operation": {
            "cropBoxExclusive": list(crop_box),
            "paddingPixels": PADDING_PIXELS,
            "resampling": "pillow_lanczos",
            "resizedSize": list(resized_size),
            "canvasSize": [OUTPUT_EDGE, OUTPUT_EDGE],
            "canvasOffset": list(offset),
            "alphaSource": "retained_sam3_mask",
            "pillowVersion": pillow_version,
        },
        "output": {
            "path": str(reference_path),
            "sha256": sha256_bytes(reference_bytes),
            "bytes": len(reference_bytes),
            "width": OUTPUT_EDGE,
            "height": OUTPUT_EDGE,
            "bitDepth": 8,
            "colorType": "rgba",
            "channelCount": 4,
            "alphaMode": "straight",
            "alphaStatistics": alpha_statistics,
        },
    }
    report = {**material, "hash": sha256_bytes(canonical_bytes(material))}
    write_absent(output_root / "preparation.json", canonical_bytes(report) + b"\n")
    print(str(output_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
