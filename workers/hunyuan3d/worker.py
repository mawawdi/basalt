#!/usr/bin/env python3
"""Fail-closed protocol boundary for Hunyuan3D 2.1 research trials.

This file deliberately contains no inference entry point. ``--local-probe`` is
dependency-free and cannot contact Modal, download weights, import Hunyuan, or
allocate a GPU. A future execution implementation must replace these exact
bytes and produce a new worker identity before any retained trial may run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from typing import Any


WORKER_ABI = "basalt-hunyuan3d21-research-worker-contract@1"
SOURCE_COMMIT = "82920d643c0dc2f7bfd7255f45f62d386edfe60c"
MODEL_REVISION = "0b94677654c57bb9a6b6845cd7b704ccf551d327"


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
        "kind": "Hunyuan3d21ResearchWorkerContract",
        "abi": WORKER_ABI,
        "status": "incomplete",
        "code": "research_inference_implementation_absent",
        "sourceCommit": SOURCE_COMMIT,
        "modelRevision": MODEL_REVISION,
        "usageScope": "research_only",
        "productionUseAllowed": False,
        "registryAdmissionAllowed": False,
        "profile": {
            "conditioning": "single_rights_bound_rgba",
            "shape": {
                "inferenceSteps": 50,
                "guidanceScale": 5,
                "octreeResolution": 384,
            },
            "paint": {"maximumViews": 6, "viewResolution": 512},
        },
        "backgroundRemoval": "excluded",
        "nativeExporter": "excluded",
        "runtimeDownloads": "denied",
        "runtimeEgress": "denied",
        "trustRemoteCode": False,
        "output": "basalt-mesh-attribute-tensor-bundle@2",
        "modelWillRun": False,
        "remoteInvocationOccurred": False,
    }
    return {**material, "hash": content_hash(material)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Basalt Hunyuan3D 2.1 research worker")
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("inference is absent until an exact research worker is qualified")
    print(canonical_bytes(contract()).decode("utf-8"))
