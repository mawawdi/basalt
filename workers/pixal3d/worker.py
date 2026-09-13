#!/usr/bin/env python3
"""Dependency-free protocol probe for the future Pixal3D inference worker.

There is intentionally no execution mode in this revision. Adding inference
requires a new worker hash and a qualification generated from its exact bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from typing import Any


WORKER_CONTRACT = "basalt-pixal3d-worker-contract"
SOURCE_COMMIT = "f7cf38429b0bd264f1995f0f8743a88b1c728b94"
WEIGHTS_REVISION = "b0cb2e1b794cab9aa0ac38a95d794a4d9337437f"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def contract() -> dict[str, Any]:
    material = {
        "kind": "Pixal3dWorkerContract",
        "contract": WORKER_CONTRACT,
        "status": "incomplete",
        "code": "inference_implementation_absent",
        "sourceCommit": SOURCE_COMMIT,
        "weightsRevision": WEIGHTS_REVISION,
        "profile": {
            "conditioning": "single_rights_bound_rgba",
            "resolution": 1536,
            "attentionBackend": "sdpa",
            "camera": "caller_supplied_calibration",
        },
        "forbiddenRuntimeModules": ["RMBG", "nvdiffrast", "nvdiffrec"],
        "backgroundRemoval": "excluded",
        "officialRenderer": "excluded",
        "officialExporter": "excluded",
        "runtimeDownloads": "denied",
        "runtimeEgress": "denied",
        "trustRemoteCode": False,
        "output": "basalt-mesh-attribute-tensor-bundle",
        "modelWillRun": False,
    }
    return {**material, "hash": content_hash(material)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Basalt Pixal3D worker protocol")
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("inference execution is absent until the worker is qualified")
    print(canonical_bytes(contract()).decode("utf-8"))
