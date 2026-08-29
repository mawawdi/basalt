#!/usr/bin/env python3
"""Build and GPU-probe the immutable TRELLIS.2 Modal runtime image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from gpu_profile import selected_gpu, selected_gpu_profile, selected_minimum_vram_gib


APP_NAME = "basalt-trellis2-runtime-image"
EXECUTION_LITERAL = "BUILD_AND_PROBE_BASALT_TRELLIS2_RUNTIME_IMAGE"
GPU_PROFILE = selected_gpu_profile()
GPU_KIND = selected_gpu()
GPU_MINIMUM_VRAM_GIB = selected_minimum_vram_gib()
BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)
SOURCE_COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
CUMESH_COMMIT = "12289e1062f0603f2f0d0771b02e1395d247f26f"
FLEX_GEMM_COMMIT = "6dd94a859c26ee8246888502eada3dd8ad85532e"
UTILS3D_COMMIT = "9a4eb15e4021b67b12c460c7057d642626897ec8"

MODEL_VOLUME_NAME = "basalt-trellis2-model-af44b45f2e35a493"
SPARSE_DECODER_VOLUME_NAME = "basalt-trellis2-sparse-decoder-model-25e0d31ffbebe4b5"
DINOV3_VOLUME_NAME = "basalt-dinov3-model-ea8dc2863c51be0a"
MODEL_ROOT = "/mnt/trellis2-model"
SPARSE_DECODER_ROOT = "/mnt/trellis2-sparse-decoder"
DINOV3_ROOT = "/mnt/trellis2-dinov3"

RUNTIME_MANIFEST_SOURCE = Path(__file__).resolve().with_name("runtime_manifest.py")
WORKER_SOURCE = Path(__file__).resolve().with_name("worker.py")
OVOXEL_INIT_SOURCE = Path(__file__).resolve().with_name("o_voxel_runtime_init.py")


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
        "kind": "Trellis2RuntimeImageBuildContract",
        "abi": "basalt-trellis2-runtime-image-build-contract@1",
        "status": "incomplete",
        "code": "runtime_image_not_built_or_probed",
        "remoteInvocationOccurred": False,
        "gpuAllocated": False,
        "baseImage": BASE_IMAGE,
        "sourceCommits": {
            "trellis2": SOURCE_COMMIT,
            "cumesh": CUMESH_COMMIT,
            "flexGemm": FLEX_GEMM_COMMIT,
            "utils3d": UTILS3D_COMMIT,
        },
        "inputVolumes": [
            MODEL_VOLUME_NAME,
            SPARSE_DECODER_VOLUME_NAME,
            DINOV3_VOLUME_NAME,
        ],
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


APT_PACKAGES = [
    "build-essential",
    "ca-certificates",
    "git",
    "libgl1",
    "libglib2.0-0",
    "libjpeg-dev",
    "ninja-build",
]
BASIC_PYTHON_PACKAGES = [
    "certifi==2026.7.22",
    "charset-normalizer==3.5.1",
    "easydict==1.13",
    "einops==0.8.2",
    "filelock==3.18.0",
    "fsspec==2026.7.0",
    "glcontext==3.0.0",
    "hf-xet==1.6.0",
    "huggingface-hub==0.35.3",
    "idna==3.19",
    "imageio==2.37.0",
    "imageio-ffmpeg==0.6.0",
    "Jinja2==3.1.6",
    "kornia==0.8.0",
    "kornia-rs==0.1.14",
    "MarkupSafe==3.0.3",
    "moderngl==5.12.0",
    "networkx==3.4.2",
    "ninja==1.11.1.4",
    "numpy==1.26.4",
    "opencv-python-headless==4.11.0.86",
    "packaging==24.2",
    "Pillow==11.1.0",
    "plyfile==1.1",
    "psutil==7.0.0",
    "PyYAML==6.0.3",
    "regex==2026.9.10",
    "requests==2.34.2",
    "safetensors==0.5.3",
    "scipy==1.15.2",
    "setuptools==75.8.2",
    "timm==1.0.15",
    "tokenizers==0.22.2",
    "tqdm==4.67.1",
    "transformers==4.57.1",
    "trimesh==4.6.5",
    "typing-extensions==4.16.0",
    "urllib3==2.7.0",
    "wheel==0.45.1",
    "zstandard==0.23.0",
]


def exact_clone(repository: str, destination: str, commit: str, recursive: bool = False) -> list[str]:
    commands = [
        f"git clone --quiet --filter=blob:none --no-checkout {repository} {destination}",
        f"git -C {destination} fetch --quiet --depth 1 origin {commit}",
        f"git -C {destination} checkout --quiet --detach {commit}",
        f"test \"$(git -C {destination} rev-parse HEAD)\" = {commit}",
    ]
    if recursive:
        commands.append(f"git -C {destination} submodule update --init --recursive --depth 1")
    return commands


build_commands: list[str] = ["mkdir -p /opt/basalt/deps"]
build_commands.extend(
    exact_clone("https://github.com/microsoft/TRELLIS.2.git", "/opt/basalt/trellis2-source", SOURCE_COMMIT, True)
)
build_commands.extend(
    exact_clone("https://github.com/JeffreyXiang/CuMesh.git", "/opt/basalt/deps/CuMesh", CUMESH_COMMIT, True)
)
build_commands.extend(
    exact_clone("https://github.com/JeffreyXiang/FlexGEMM.git", "/opt/basalt/deps/FlexGEMM", FLEX_GEMM_COMMIT)
)
build_commands.extend(
    exact_clone("https://github.com/EasternJournalist/utils3d.git", "/opt/basalt/deps/utils3d", UTILS3D_COMMIT)
)

RUNTIME_IMAGE = (
    modal.Image.from_registry(BASE_IMAGE, add_python="3.10")
    .apt_install(*APT_PACKAGES)
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(*BASIC_PYTHON_PACKAGES)
    .run_commands(*build_commands)
    .run_commands(
        "python -m pip install --no-deps --no-build-isolation /opt/basalt/deps/utils3d",
        "CC=/usr/bin/gcc CXX=/usr/bin/g++ MAX_JOBS=4 TORCH_CUDA_ARCH_LIST=8.0 BUILD_TARGET=cuda python -m pip install --no-deps --no-build-isolation /opt/basalt/deps/CuMesh",
        "CC=/usr/bin/gcc CXX=/usr/bin/g++ MAX_JOBS=4 TORCH_CUDA_ARCH_LIST=8.0 BUILD_TARGET=cuda python -m pip install --no-deps --no-build-isolation /opt/basalt/deps/FlexGEMM",
    )
    .add_local_file(OVOXEL_INIT_SOURCE, "/opt/basalt/o_voxel_runtime_init.py", copy=True)
    .run_commands(
        "cp /opt/basalt/o_voxel_runtime_init.py /opt/basalt/trellis2-source/o-voxel/o_voxel/__init__.py",
        "CC=/usr/bin/gcc CXX=/usr/bin/g++ MAX_JOBS=4 TORCH_CUDA_ARCH_LIST=8.0 BUILD_TARGET=cuda python -m pip install --no-deps --no-build-isolation /opt/basalt/trellis2-source/o-voxel",
        "CC=/usr/bin/gcc CXX=/usr/bin/g++ MAX_JOBS=4 TORCH_CUDA_ARCH_LIST=8.0 python -m pip install --no-build-isolation flash-attn==2.7.3",
    )
    .add_local_file(WORKER_SOURCE, "/opt/basalt/trellis2-worker.py", copy=True)
    .add_local_file(RUNTIME_MANIFEST_SOURCE, "/opt/basalt/runtime_manifest.py", copy=True)
    .env(
        {
            "ATTN_BACKEND": "flash_attn",
            "DIFFUSERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_OFFLINE": "1",
            "PYTHONPATH": "/opt/basalt/trellis2-source",
            "SPARSE_ATTN_BACKEND": "flash_attn",
            "SPARSE_CONV_BACKEND": "flex_gemm",
            "TOKENIZERS_PARALLELISM": "false",
            "TRANSFORMERS_OFFLINE": "1",
        }
    )
    .run_commands(
        "chmod 0555 /opt/basalt/trellis2-worker.py",
        "python /opt/basalt/runtime_manifest.py --write /opt/basalt/trellis2-runtime-manifest.json",
    )
)

MODEL_VOLUME = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
SPARSE_DECODER_VOLUME = modal.Volume.from_name(SPARSE_DECODER_VOLUME_NAME, create_if_missing=False)
DINOV3_VOLUME = modal.Volume.from_name(DINOV3_VOLUME_NAME, create_if_missing=False)
app = modal.App(APP_NAME, include_source=False)


@app.function(
    serialized=True,
    image=RUNTIME_IMAGE,
    gpu=GPU_KIND,
    cpu=(1.0, 2.0),
    memory=(2048, 8192),
    volumes={
        MODEL_ROOT: MODEL_VOLUME.with_mount_options(read_only=True),
        SPARSE_DECODER_ROOT: SPARSE_DECODER_VOLUME.with_mount_options(read_only=True),
        DINOV3_ROOT: DINOV3_VOLUME.with_mount_options(read_only=True),
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
)
def probe_runtime_image(execution_literal: str) -> dict[str, Any]:
    import hashlib
    import importlib
    import json
    import os
    import sys
    from pathlib import Path

    if execution_literal != "BUILD_AND_PROBE_BASALT_TRELLIS2_RUNTIME_IMAGE":
        raise ValueError("runtime image execution literal is absent or invalid")

    def canonical(value: Any) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    def decode(path: Path) -> dict[str, Any]:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or raw.rstrip(b"\n") != canonical(value):
            raise ValueError(f"{path} is not canonical JSON")
        material = {key: entry for key, entry in value.items() if key != "hash"}
        if hashlib.sha256(canonical(material)).hexdigest() != value.get("hash"):
            raise ValueError(f"{path} identity differs")
        return value

    manifest = decode(Path("/opt/basalt/trellis2-runtime-manifest.json"))
    seals = {
        "trellis2": decode(Path("/mnt/trellis2-model/snapshot/.basalt-evidence/snapshot-seal.json")),
        "sparseDecoder": decode(
            Path("/mnt/trellis2-sparse-decoder/snapshot/.basalt-evidence/snapshot-seal.json")
        ),
        "dinoV3": decode(Path("/mnt/trellis2-dinov3/snapshot/.basalt-evidence/snapshot-seal.json")),
    }
    for name, seal in seals.items():
        expected = manifest["modelArtifacts"][name]
        if seal.get("hash") != expected["snapshotSealHash"]:
            raise ValueError(f"{name} snapshot seal differs")
        if seal.get("artifact", {}).get("artifactId") != expected["artifactId"]:
            raise ValueError(f"{name} artifact identity differs")
        if seal.get("artifact", {}).get("revision") != expected["revision"]:
            raise ValueError(f"{name} revision differs")
    before = set(sys.modules)
    probes = [
        "torch",
        "torchvision",
        "transformers",
        "safetensors.torch",
        "flash_attn",
        "cumesh",
        "flex_gemm",
        "o_voxel.convert",
        "trellis2.models",
        "trellis2.modules.image_feature_extractor",
        "trellis2.pipelines.samplers",
        "trellis2.pipelines.trellis2_image_to_3d",
    ]
    for module_name in probes:
        importlib.import_module(module_name)
    from transformers import DINOv3ViTModel
    import torch

    if DINOv3ViTModel.__name__ != "DINOv3ViTModel":
        raise ValueError("DINOv3 model class is unavailable")
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise ValueError("exactly one CUDA device is required")
    properties = torch.cuda.get_device_properties(0)
    imported = sorted(set(sys.modules) - before)
    forbidden = sorted(
        name
        for name in imported
        if name.startswith(("nvdiffrec", "nvdiffrast", "rembg", "rmbg"))
    )
    if forbidden:
        raise ValueError("runtime import probe loaded a forbidden module")
    modal_image_id = os.environ.get("MODAL_IMAGE_ID", "")
    if not modal_image_id.startswith("im-"):
        raise ValueError("Modal image identity is absent")
    return {
        "kind": "Trellis2RuntimeImageProbe",
        "abi": "basalt-trellis2-runtime-image-probe@2",
        "status": "eligible",
        "modalImageId": modal_image_id,
        "runtimeManifestHash": manifest["hash"],
        "dependencyInventoryHash": manifest["dependencyInventoryHash"],
        "workerSha256": manifest["workerSha256"],
        "modelSnapshotSealHashes": {
            name: seal["hash"] for name, seal in sorted(seals.items())
        },
        "gpuAllocated": True,
        "gpuProfile": GPU_PROFILE,
        "requestedGpu": GPU_KIND,
        "minimumVramGiB": GPU_MINIMUM_VRAM_GIB,
        "hardware": {
            "acceleratorModel": properties.name,
            "vramGiB": round(properties.total_memory / (1024**3), 3),
            "cudaBuild": str(torch.version.cuda),
        },
        "importProbe": {
            "probes": probes,
            "importedModuleCount": len(imported),
            "importedRootModules": sorted({name.split(".", 1)[0] for name in imported}),
            "forbiddenModules": forbidden,
        },
        "modelWeightsLoaded": False,
        "networkEgress": "denied",
    }


@app.local_entrypoint()
def main(execution_literal: str = "", output_path: str = "") -> None:
    require(execution_literal == EXECUTION_LITERAL, "runtime image execution literal is absent or invalid")
    serialized = canonical_bytes(probe_runtime_image.remote(execution_literal))
    if output_path:
        destination = Path(output_path).expanduser()
        require(destination.is_absolute(), "runtime probe output path must be absolute")
        require(destination.parent.is_dir(), "runtime probe output parent must already exist")
        require(not destination.exists(), "runtime probe output must be absent")
        with destination.open("xb") as handle:
            handle.write(serialized)
            handle.write(b"\n")
    print(serialized.decode("utf-8"))
