#!/usr/bin/env python3
"""Build and probe the isolated SAM 3 prompted-segmentation Modal image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any


APP_NAME = "basalt-sam3-reference-segmentation-runtime-image"
EXECUTION_LITERAL = "BUILD_AND_PROBE_BASALT_SAM3_REFERENCE_IMAGE_RUNTIME"
BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)
GPU_KIND = "A100-80GB"
SAM3_SOURCE_COMMIT = "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
SAM3_MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
SAM3_SOURCE_VOLUME_NAME = f"basalt-sam3-source-{SAM3_SOURCE_COMMIT[:16]}"
SAM3_MODEL_VOLUME_NAME = f"basalt-sam3-model-{SAM3_MODEL_REVISION[:16]}"
SAM3_SOURCE_ROOT = "/mnt/basalt-neural-input/sam3-source"
SAM3_MODEL_ROOT = "/mnt/basalt-neural-input/sam3-model"
RUNTIME_MANIFEST_SOURCE = Path(__file__).resolve().with_name("runtime_manifest.py")
WORKER_SOURCE = Path(__file__).resolve().with_name("worker.py")


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


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def local_contract() -> dict[str, Any]:
    material = {
        "kind": "Sam3ReferenceImageRuntimeBuildContract",
        "abi": "basalt-sam3-reference-image-runtime-build-contract@1",
        "status": "incomplete",
        "code": "runtime_image_not_built_or_probed",
        "baseImage": BASE_IMAGE,
        "gpu": GPU_KIND,
        "remoteInvocationOccurred": False,
        "gpuAllocated": False,
        "modelWillRun": False,
        "runtime": {
            "producerId": "sam3",
            "sourceCommit": SAM3_SOURCE_COMMIT,
            "modelRevision": SAM3_MODEL_REVISION,
            "sourceVolume": SAM3_SOURCE_VOLUME_NAME,
            "modelVolume": SAM3_MODEL_VOLUME_NAME,
        },
    }
    return {**material, "hash": content_hash(material)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("direct execution supports only --local-probe; use `modal run` to build")
    print(canonical_bytes(local_contract()).decode("utf-8"))
    raise SystemExit(0)


import modal  # type: ignore[import-not-found]  # noqa: E402
from modal._vendor import cloudpickle  # type: ignore[import-not-found]  # noqa: E402
import sys  # noqa: E402


def exact_clone(repository: str, destination: str, commit: str) -> list[str]:
    return [
        f"git clone --quiet --filter=blob:none --no-checkout {repository} {destination}",
        f"git -C {destination} fetch --quiet --depth 1 origin {commit}",
        f"git -C {destination} checkout --quiet --detach {commit}",
        f'test "$(git -C {destination} rev-parse HEAD)" = {commit}',
    ]


COMMON_PACKAGES = [
    "certifi==2026.7.22",
    "charset-normalizer==3.5.1",
    "filelock==3.18.0",
    "fsspec==2026.7.0",
    "huggingface-hub==0.35.3",
    "idna==3.19",
    "Jinja2==3.1.6",
    "MarkupSafe==3.0.3",
    "numpy==1.26.4",
    "packaging==24.2",
    "Pillow==11.1.0",
    "PyYAML==6.0.3",
    "regex==2026.9.10",
    "requests==2.34.2",
    "safetensors==0.5.3",
    "setuptools==75.8.2",
    "tqdm==4.67.1",
    "typing-extensions==4.16.0",
    "urllib3==2.7.0",
]


SAM3_BUILD_COMMANDS = exact_clone(
    "https://github.com/facebookresearch/sam3.git",
    "/opt/basalt/sam3-source",
    SAM3_SOURCE_COMMIT,
)
SAM3_RUNTIME_IMAGE = (
    modal.Image.from_registry(BASE_IMAGE, add_python="3.10")
    .apt_install("ca-certificates", "git")
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(*COMMON_PACKAGES)
    .pip_install(
        "einops==0.8.2",
        "ftfy==6.1.1",
        "iopath==0.1.10",
        "portalocker==3.2.0",
        "psutil==7.0.0",
        "pycocotools==2.0.10",
        "timm==1.0.17",
        "wcwidth==0.2.13",
    )
    .run_commands(*SAM3_BUILD_COMMANDS)
    .run_commands(
        "python -m pip install --no-deps --no-build-isolation /opt/basalt/sam3-source",
    )
    .add_local_file(WORKER_SOURCE, "/opt/basalt/reference-image-worker.py", copy=True)
    .add_local_file(RUNTIME_MANIFEST_SOURCE, "/opt/basalt/runtime_manifest.py", copy=True)
    .run_commands(
        "chmod 0555 /opt/basalt/reference-image-worker.py",
        "python /opt/basalt/runtime_manifest.py sam3 --write /opt/basalt/sam3-runtime-manifest.json",
    )
    .env(
        {
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_OFFLINE": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "TRANSFORMERS_OFFLINE": "1",
        }
    )
)

SAM3_SOURCE_VOLUME = modal.Volume.from_name(SAM3_SOURCE_VOLUME_NAME, create_if_missing=False)
SAM3_MODEL_VOLUME = modal.Volume.from_name(SAM3_MODEL_VOLUME_NAME, create_if_missing=False)
app = modal.App(APP_NAME, include_source=False)
cloudpickle.register_pickle_by_value(sys.modules[__name__])


def _probe_sam3_runtime(execution_literal: str) -> dict[str, object]:
    import hashlib
    import importlib
    import json
    import os
    import sys
    from pathlib import Path

    def canonical(value: object) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    def digest(value: object) -> str:
        return hashlib.sha256(canonical(value)).hexdigest()

    def decode(path: Path) -> dict[str, object]:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or raw.rstrip(b"\n") != canonical(value):
            raise ValueError(f"{path} is not canonical JSON")
        material = {key: entry for key, entry in value.items() if key != "hash"}
        if digest(material) != value.get("hash"):
            raise ValueError(f"{path} identity differs")
        return value

    if execution_literal != "BUILD_AND_PROBE_BASALT_SAM3_REFERENCE_IMAGE_RUNTIME":
        raise ValueError("SAM 3 runtime probe execution literal is absent")
    source_root = Path("/mnt/basalt-neural-input/sam3-source")
    model_root = Path("/mnt/basalt-neural-input/sam3-model")
    manifest = decode(Path("/opt/basalt/sam3-runtime-manifest.json"))
    source_seal = decode(source_root / "snapshot/.basalt-evidence/snapshot-seal.json")
    model_seal = decode(model_root / "snapshot/.basalt-evidence/snapshot-seal.json")
    source_artifact = source_seal.get("artifact")
    model_artifact = model_seal.get("artifact")
    if (
        not isinstance(source_artifact, dict)
        or source_artifact.get("revision")
        != "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
    ):
        raise ValueError("SAM 3 source Volume revision differs")
    if (
        not isinstance(model_artifact, dict)
        or model_artifact.get("revision")
        != "3c879f39826c281e95690f02c7821c4de09afae7"
    ):
        raise ValueError("SAM 3 model Volume revision differs")
    before = set(sys.modules)
    probes = [
        "torch",
        "torchvision",
        "timm",
        "sam3",
        "sam3.model_builder",
        "sam3.model.sam3_image_processor",
    ]
    for module_name in probes:
        importlib.import_module(module_name)
    import torch

    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise ValueError("exactly one CUDA device is required")
    imported = sorted(set(sys.modules) - before)
    forbidden = sorted(
        name
        for name in imported
        if name.startswith(("nvdiffrec", "nvdiffrast", "rembg", "rmbg"))
    )
    if forbidden:
        raise ValueError("SAM 3 runtime imported a forbidden module")
    image_id = os.environ.get("MODAL_IMAGE_ID", "")
    if not image_id.startswith("im-"):
        raise ValueError("Modal image ID is absent")
    evidence = manifest.get("evidence")
    model_inventory_hash = model_seal.get("fileInventoryHash")
    if not isinstance(evidence, dict) or not isinstance(model_inventory_hash, str):
        raise ValueError("SAM 3 runtime evidence is absent")
    properties = torch.cuda.get_device_properties(0)
    material: dict[str, object] = {
        "kind": "ReferenceImageRuntimeProbe",
        "abi": "basalt-reference-image-runtime-probe@1",
        "status": "eligible",
        "producerId": "sam3",
        "modalImageId": image_id,
        "runtimeManifestHash": manifest["hash"],
        "workerSha256": manifest["workerSha256"],
        "runtimeEvidence": evidence,
        "sourceSnapshotSealHash": source_seal["hash"],
        "modelSnapshotSealHash": model_seal["hash"],
        "modelInventoryArtifactHash": model_inventory_hash,
        "hardware": {
            "acceleratorModel": properties.name,
            "vramGiB": round(properties.total_memory / (1024**3), 3),
            "cudaBuild": str(torch.version.cuda),
        },
        "importProbe": {
            "requested": probes,
            "importedModules": imported,
            "forbiddenModules": forbidden,
        },
        "modelWeightsLoaded": False,
        "gpuAllocated": True,
        "networkEgress": "denied",
    }
    return {**material, "hash": digest(material)}


_probe_sam3_runtime.__module__ = "__main__"


probe_sam3_runtime = app.function(
    serialized=True,
    image=SAM3_RUNTIME_IMAGE,
    gpu=GPU_KIND,
    cpu=(1.0, 2.0),
    memory=(2048, 8192),
    volumes={
        SAM3_SOURCE_ROOT: SAM3_SOURCE_VOLUME.with_mount_options(read_only=True),
        SAM3_MODEL_ROOT: SAM3_MODEL_VOLUME.with_mount_options(read_only=True),
    },
    min_containers=0,
    max_containers=1,
    buffer_containers=0,
    scaledown_window=60,
    retries=0,
    timeout=180,
    block_network=True,
    restrict_modal_access=True,
    single_use_containers=True,
    include_source=False,
)(_probe_sam3_runtime)


@app.local_entrypoint()
def main(execution_literal: str = "", output_path: str = "") -> None:
    require(execution_literal == EXECUTION_LITERAL, "SAM 3 runtime probe literal is absent")
    result = probe_sam3_runtime.remote(execution_literal)
    serialized = canonical_bytes(result)
    if output_path:
        destination = Path(output_path).expanduser()
        require(destination.is_absolute() and destination.parent.is_dir(), "output path is invalid")
        require(not destination.exists(), "output path must be absent")
        destination.write_bytes(serialized + b"\n")
    print(serialized.decode("utf-8"))
