#!/usr/bin/env python3
"""Fail-closed Modal boundary for the unregistered Pixal3D route.

The dependency-free ``--local-probe`` path exits before importing Modal and
never opens a remote app. The remote function is deliberately a qualification
scaffold: it binds the immutable image/volume layout and isolation controls but
cannot run inference until the worker implementation and exact evidence graph
replace its explicit incomplete result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from typing import Any


APP_NAME = "basalt-pixal3d-qualification"
RUNTIME_CONTRACT = "basalt-pixal3d-modal-runtime-contract"
SOURCE_COMMIT = "f7cf38429b0bd264f1995f0f8743a88b1c728b94"
WEIGHTS_REVISION = "b0cb2e1b794cab9aa0ac38a95d794a4d9337437f"
DINOV3_REVISION = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)
IMAGE_ID_ENV = "BASALT_PIXAL3D_MODAL_IMAGE_ID"
LOCAL_GATE_ENV = "BASALT_PIXAL3D_PAID_RUN_AUTHORIZATION"
MODAL_GATE_SECRET_NAME = "basalt-pixal3d-execution-gate"
EXECUTION_LITERAL = "RUN_ONE_QUALIFIED_BASALT_PIXAL3D_ASSET"
MODEL_VOLUME_NAME = "basalt-pixal3d-model"
DINOV3_VOLUME_NAME = "basalt-dinov3-model"
MODEL_ROOT = "/mnt/pixal3d-model"
DINOV3_ROOT = "/mnt/pixal3d-dinov3"
GPU_KIND = "A100-80GB"
MAX_CONTAINERS = 1
SCALEDOWN_WINDOW_SECONDS = 60
FUNCTION_TIMEOUT_SECONDS = 180
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MODAL_IMAGE_ID = re.compile(r"^im-[A-Za-z0-9]+$")


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


def local_contract() -> dict[str, Any]:
    material = {
        "kind": "Pixal3dModalRuntimeContract",
        "contract": RUNTIME_CONTRACT,
        "status": "incomplete",
        "code": "production_inference_not_qualified",
        "modelWillRun": False,
        "remoteInvocationOccurred": False,
        "appName": APP_NAME,
        "sourceCommit": SOURCE_COMMIT,
        "weightsRevision": WEIGHTS_REVISION,
        "dinoV3Revision": DINOV3_REVISION,
        "baseImage": BASE_IMAGE,
        "immutableImageIdConfigured": MODAL_IMAGE_ID.fullmatch(
            os.environ.get(IMAGE_ID_ENV, "")
        )
        is not None,
        "volumes": [
            {"name": MODEL_VOLUME_NAME, "mount": MODEL_ROOT, "readOnly": True},
            {"name": DINOV3_VOLUME_NAME, "mount": DINOV3_ROOT, "readOnly": True},
        ],
        "execution": {
            "gpu": GPU_KIND,
            "maxContainers": MAX_CONTAINERS,
            "minContainers": 0,
            "retries": 0,
            "scaledownWindowSeconds": SCALEDOWN_WINDOW_SECONDS,
            "timeoutSeconds": FUNCTION_TIMEOUT_SECONDS,
            "runtimeEgress": "denied",
            "modalResourceAccess": "denied",
            "runtimeDownloads": "denied",
            "trustRemoteCode": False,
            "singleUseContainer": True,
        },
        "pipeline": {
            "conditioning": "single_rights_bound_rgba",
            "resolution": 1536,
            "attentionBackend": "sdpa",
            "camera": "caller_supplied_calibration",
            "backgroundRemoval": "excluded",
            "officialRenderer": "excluded",
            "officialExporter": "excluded",
            "output": "basalt-mesh-attribute-tensor-bundle",
        },
        "authorization": {
            "requiredExecutionLiteral": EXECUTION_LITERAL,
            "modalSecretName": MODAL_GATE_SECRET_NAME,
            "localGateEnvironmentName": LOCAL_GATE_ENV,
            "secretValueRetainedInRepository": False,
        },
    }
    return {**material, "hash": content_hash(material)}


def run_local_probe() -> int:
    print(canonical_bytes(local_contract()).decode("utf-8"))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Basalt Pixal3D Modal boundary")
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("only --local-probe is available before Pixal3D qualification")
    raise SystemExit(run_local_probe())


import modal  # noqa: E402  # Imported only by Modal, never by --local-probe.


def require_modal_image_id() -> str:
    image_id = os.environ.get(IMAGE_ID_ENV, "")
    if MODAL_IMAGE_ID.fullmatch(image_id) is None:
        raise ValueError(f"{IMAGE_ID_ENV} must name a previously built immutable Modal Image")
    return image_id


RUNTIME_IMAGE = modal.Image.from_id(require_modal_image_id())
MODEL_VOLUME = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
DINOV3_VOLUME = modal.Volume.from_name(DINOV3_VOLUME_NAME, create_if_missing=False)
EXECUTION_GATE = modal.Secret.from_name(MODAL_GATE_SECRET_NAME, required_keys=[LOCAL_GATE_ENV])
app = modal.App(APP_NAME, include_source=False)


@app.function(
    serialized=True,
    image=RUNTIME_IMAGE,
    gpu=GPU_KIND,
    cpu=(4.0, 8.0),
    memory=(32 * 1024, 64 * 1024),
    ephemeral_disk=4 * 1024,
    volumes={
        MODEL_ROOT: MODEL_VOLUME.with_mount_options(read_only=True),
        DINOV3_ROOT: DINOV3_VOLUME.with_mount_options(read_only=True),
    },
    secrets=[EXECUTION_GATE],
    min_containers=0,
    max_containers=MAX_CONTAINERS,
    buffer_containers=0,
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    retries=0,
    timeout=FUNCTION_TIMEOUT_SECONDS,
    startup_timeout=120,
    block_network=True,
    restrict_modal_access=True,
    single_use_containers=True,
    include_source=False,
)
def execute_qualified_asset(
    request_bytes: bytes,
    reference_bytes: bytes,
    execution_flag: str,
    execution_gate_commitment: str,
) -> dict[str, Any]:
    """Reject until exact source/import/SBOM/rights probes have qualified the image."""
    import hashlib
    import hmac
    import os

    if execution_flag != "RUN_ONE_QUALIFIED_BASALT_PIXAL3D_ASSET":
        raise ValueError("execution literal is absent or invalid")
    retained_gate = os.environ.get("BASALT_PIXAL3D_PAID_RUN_AUTHORIZATION", "")
    if len(retained_gate) < 32:
        raise ValueError("Modal execution-gate Secret is absent")
    if not hmac.compare_digest(
        execution_gate_commitment,
        hashlib.sha256(retained_gate.encode("utf-8")).hexdigest(),
    ):
        raise ValueError("local and Modal execution-gate commitments differ")
    if not request_bytes or not reference_bytes:
        raise ValueError("request and reference bytes are required")
    raise RuntimeError(
        "Pixal3D production inference is deliberately blocked until the retained SBOM, "
        "import trace, commercial terms, worker probe, and Studio evidence are eligible"
    )
