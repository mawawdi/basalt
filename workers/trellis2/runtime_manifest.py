#!/usr/bin/env python3
"""Build and validate the immutable TRELLIS.2 runtime manifest."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import platform
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


MANIFEST_ABI = "basalt-trellis2-modal-runtime-image@3"
BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)
SOURCE_ROOT = Path("/opt/basalt/trellis2-source")
WORKER_PATH = Path("/opt/basalt/trellis2-worker.py")
PATCH_PATH = Path("/opt/basalt/o_voxel_runtime_init.py")
RUNTIME_MANIFEST_PATH = Path("/opt/basalt/trellis2-runtime-manifest.json")

SOURCE_COMMITS = {
    "trellis2": "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
    "cumesh": "12289e1062f0603f2f0d0771b02e1395d247f26f",
    "cubvh": "ce92267a24ef6ad7d2c8ccbc2ae2c021a6597e70",
    "cubvhEigen": "e63d9f6ccb7f6f29f31241b87c542f3f0ab3112b",
    "flexGemm": "6dd94a859c26ee8246888502eada3dd8ad85532e",
    "oVoxelEigen": "21e4582d1739107337a03460c81412981130373e",
    "utils3d": "9a4eb15e4021b67b12c460c7057d642626897ec8",
}
MODEL_ARTIFACTS = {
    "trellis2": {
        "artifactId": "trellis2.model",
        "revision": "af44b45f2e35a493886929c6d786e563ec68364d",
        "snapshotSealHash": "a85c4f0213a80cdea55939ab99700588bfafbc6337ad145e73520072eba2f33d",
    },
    "sparseDecoder": {
        "artifactId": "trellis2.sparse_decoder_model",
        "revision": "25e0d31ffbebe4b5a97464dd851910efc3002d96",
        "snapshotSealHash": "bc3b9c605d46bcbc11a03d6f8d52fd45d6d31b969e728f4d2c8c14bd2af9120b",
    },
    "dinoV3": {
        "artifactId": "dinov3.model",
        "revision": "ea8dc2863c51be0a264bab82070e3e8836b02d51",
        "snapshotSealHash": "99a92ab12775e39231f2c8d48c680c83673b1f48486de69d2375b253af2e4368",
    },
}
EXPECTED_DISTRIBUTIONS = {
    "cumesh": "0.0.1",
    "flash-attn": "2.7.3",
    "flex-gemm": "1.0.0",
    "numpy": "1.26.4",
    "o-voxel": "0.0.1",
    "pillow": "11.1.0",
    "safetensors": "0.5.3",
    "torch": "2.6.0+cu124",
    "torchvision": "0.21.0+cu124",
    "transformers": "4.57.1",
    "utils3d": "0.0.2",
}
FORBIDDEN_DISTRIBUTIONS = {
    "backgroundremover",
    "birefnet",
    "nvdiffrec",
    "nvdiffrast",
    "rembg",
    "rmbg",
}
FORBIDDEN_MODULE_PREFIXES = ("nvdiffrec", "nvdiffrast", "rembg", "rmbg")
MODULE_RESOLUTION_PROBES = (
    "torch",
    "torchvision",
    "transformers",
    "safetensors",
    "flash_attn",
    "cumesh",
    "flex_gemm",
    "o_voxel",
    "trellis2",
)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


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


def sha256_file(path: Path) -> str:
    resolved = path.resolve(strict=True)
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{path} is not a regular file")
    digest = hashlib.sha256()
    with resolved.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def distribution_inventory() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for distribution in importlib.metadata.distributions():
        name = normalized_name(distribution.metadata.get("Name", ""))
        version = distribution.version
        require(bool(name) and bool(version), "installed distribution lacks identity")
        identity = (name, version)
        if identity in seen:
            continue
        seen.add(identity)
        metadata_path = Path(distribution._path) / "METADATA"  # type: ignore[attr-defined]
        metadata_hash = sha256_file(metadata_path) if metadata_path.is_file() else None
        license_value = (
            distribution.metadata.get("License-Expression")
            or distribution.metadata.get("License")
            or "NOASSERTION"
        )
        entry: dict[str, Any] = {
            "name": name,
            "version": version,
            "license": " ".join(license_value.split())[:512] or "NOASSERTION",
        }
        if metadata_hash is not None:
            entry["metadataSha256"] = metadata_hash
        entries.append(entry)
    entries.sort(key=lambda entry: (entry["name"], entry["version"]))
    return entries


def check_expected_distributions(inventory: list[dict[str, Any]]) -> None:
    installed = {(entry["name"], entry["version"]) for entry in inventory}
    installed_names = {entry["name"] for entry in inventory}
    for name, version in EXPECTED_DISTRIBUTIONS.items():
        require((name, version) in installed, f"runtime dependency {name}=={version} is absent")
    require(
        not installed_names.intersection(FORBIDDEN_DISTRIBUTIONS),
        "runtime contains a forbidden distribution",
    )


def git_output(root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=True,
        capture_output=True,
        encoding="utf-8",
        errors="strict",
        timeout=30,
    )
    return completed.stdout.strip()


def check_sources() -> dict[str, str]:
    roots = {
        "trellis2": SOURCE_ROOT,
        "cumesh": Path("/opt/basalt/deps/CuMesh"),
        "cubvh": Path("/opt/basalt/deps/CuMesh/third_party/cubvh"),
        "cubvhEigen": Path("/opt/basalt/deps/CuMesh/third_party/cubvh/third_party/eigen"),
        "flexGemm": Path("/opt/basalt/deps/FlexGEMM"),
        "oVoxelEigen": SOURCE_ROOT / "o-voxel/third_party/eigen",
        "utils3d": Path("/opt/basalt/deps/utils3d"),
    }
    actual = {name: git_output(root, "rev-parse", "HEAD") for name, root in roots.items()}
    require(actual == SOURCE_COMMITS, "runtime source or submodule commit differs")
    return actual


def native_extension_inventory() -> list[dict[str, Any]]:
    roots = (Path("/usr/local/lib"), Path("/opt/basalt"))
    needles = ("cumesh", "flex_gemm", "o_voxel", "flash_attn")
    entries: list[dict[str, Any]] = []
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*.so"):
            path_text = path.as_posix().lower()
            if not any(needle in path_text for needle in needles):
                continue
            entries.append(
                {
                    "path": path.as_posix(),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    entries.sort(key=lambda entry: entry["path"])
    require(entries, "runtime native extension inventory is empty")
    return entries


def module_resolution_probe() -> dict[str, Any]:
    """Prove module presence without initializing CUDA in the image builder.

    Modal image-build containers do not have a GPU. CUDA-backed imports are
    executed separately by the sealed runtime probe on an A100.
    """
    resolved: list[dict[str, Any]] = []
    for module_name in MODULE_RESOLUTION_PROBES:
        spec = importlib.util.find_spec(module_name)
        require(spec is not None, f"runtime module {module_name} is absent")
        origin = spec.origin or "namespace"
        entry: dict[str, Any] = {"module": module_name, "origin": origin}
        if origin not in {"built-in", "frozen", "namespace"}:
            path = Path(origin)
            if path.is_file():
                entry["originSha256"] = sha256_file(path)
        resolved.append(entry)
    return {
        "mode": "build_static_resolution",
        "gpuImportsDeferredToRuntimeProbe": True,
        "modules": resolved,
    }


def build_manifest() -> dict[str, Any]:
    require(platform.system() == "Linux", "runtime image qualification requires Linux")
    sources = check_sources()
    inventory = distribution_inventory()
    check_expected_distributions(inventory)
    worker_hash = sha256_file(WORKER_PATH)
    patch_hash = sha256_file(PATCH_PATH)
    require(
        git_output(SOURCE_ROOT, "diff", "--name-only") == "o-voxel/o_voxel/__init__.py",
        "TRELLIS.2 runtime source has an undeclared patch set",
    )
    require(
        sha256_file(SOURCE_ROOT / "o-voxel/o_voxel/__init__.py") == patch_hash,
        "TRELLIS.2 O-Voxel source patch differs",
    )
    installed_init = Path(importlib.util.find_spec("o_voxel").origin or "")
    require(
        sha256_file(installed_init) == patch_hash,
        "installed O-Voxel runtime surface differs from the qualified patch",
    )
    native_extensions = native_extension_inventory()
    module_resolution = module_resolution_probe()
    import torch

    material = {
        "kind": "Trellis2ModalRuntimeImage",
        "abi": MANIFEST_ABI,
        "baseImage": BASE_IMAGE,
        "python": platform.python_version(),
        "torch": {"version": torch.__version__, "cudaBuild": str(torch.version.cuda)},
        "sourceCommits": sources,
        "modelArtifacts": MODEL_ARTIFACTS,
        "workerSha256": worker_hash,
        "oVoxelRuntimePatchSha256": patch_hash,
        "dependencyInventoryHash": content_hash(inventory),
        "dependencyInventory": inventory,
        "nativeExtensionInventoryHash": content_hash(native_extensions),
        "nativeExtensions": native_extensions,
        "moduleResolutionProbe": module_resolution,
        "runtimePolicy": {
            "downloads": "denied",
            "networkEgress": "denied",
            "trustRemoteCode": False,
            "backgroundRemoval": "caller_supplied_alpha_only",
            "officialExporter": "excluded",
        },
    }
    return {**material, "hash": content_hash(material)}


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    payload = canonical_bytes(manifest) + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.exists(), "runtime manifest output already exists")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def local_probe() -> dict[str, Any]:
    material = {
        "kind": "Trellis2RuntimeImageBuildPlan",
        "abi": "basalt-trellis2-runtime-image-build-plan@1",
        "status": "incomplete",
        "code": "runtime_image_not_built_or_probed",
        "baseImage": BASE_IMAGE,
        "sourceCommits": SOURCE_COMMITS,
        "modelArtifacts": MODEL_ARTIFACTS,
        "forbiddenDistributions": sorted(FORBIDDEN_DISTRIBUTIONS),
        "gpuWillRun": False,
        "remoteInvocationOccurred": False,
    }
    return {**material, "hash": content_hash(material)}


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--local-probe", action="store_true")
    mode.add_argument("--write", metavar="PATH")
    arguments = parser.parse_args()
    if arguments.local_probe:
        print(canonical_bytes(local_probe()).decode("utf-8"))
        return 0
    manifest = build_manifest()
    write_manifest(Path(arguments.write), manifest)
    print(manifest["hash"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"TRELLIS.2 runtime image rejected: {error}", file=sys.stderr)
        raise SystemExit(2) from error
