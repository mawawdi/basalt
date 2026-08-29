#!/usr/bin/env python3
"""Build content-addressed evidence for isolated reference-image runtimes."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)
QWEN_SOURCE_COMMIT = "6b5e1f5cec987d404be5ac6657db3b9aacb56a89"
QWEN_MODEL_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
DIFFUSERS_COMMIT = "9380e58821092ad05e618fa8a259030136ba43c0"
SAM3_SOURCE_COMMIT = "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
SAM3_MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
WORKER_PATH = Path("/opt/basalt/reference-image-worker.py")
FORBIDDEN_DISTRIBUTIONS = {
    "backgroundremover",
    "birefnet",
    "nvdiffrec",
    "nvdiffrast",
    "rembg",
    "rmbg",
}
FORBIDDEN_MODULE_PREFIXES = ("nvdiffrec", "nvdiffrast", "rembg", "rmbg")
ROUTES = {
    "qwen_image_edit_2511": {
        "abi": "basalt-qwen-image-edit-2511-runtime-image@1",
        "sourceCommits": {
            "producer": QWEN_SOURCE_COMMIT,
            "diffusers": DIFFUSERS_COMMIT,
        },
        "modelRevision": QWEN_MODEL_REVISION,
        "sourceRoot": "/mnt/basalt-neural-input/qwen-image-source",
        "modelRoot": "/mnt/basalt-neural-input/qwen-image-edit-2511-model",
        "modules": (
            "torch",
            "PIL",
            "numpy",
            "transformers",
            "diffusers",
            "diffusers.pipelines.qwenimage.pipeline_qwenimage_edit_plus",
        ),
        "expectedDistributions": {
            "diffusers": "0.36.0",
            "httpx": "0.28.1",
            "numpy": "1.26.4",
            "pillow": "11.1.0",
            "torch": "2.6.0+cu124",
            "transformers": "4.57.1",
        },
    },
    "sam3": {
        "abi": "basalt-sam3-reference-segmentation-runtime-image@1",
        "sourceCommits": {"producer": SAM3_SOURCE_COMMIT},
        "modelRevision": SAM3_MODEL_REVISION,
        "sourceRoot": "/mnt/basalt-neural-input/sam3-source",
        "modelRoot": "/mnt/basalt-neural-input/sam3-model",
        "modules": (
            "torch",
            "torchvision",
            "PIL",
            "numpy",
            "timm",
            "sam3",
            "sam3.model_builder",
            "sam3.model.sam3_image_processor",
        ),
        "expectedDistributions": {
            "numpy": "1.26.4",
            "pillow": "11.1.0",
            "sam3": "0.1.0",
            "timm": "1.0.17",
            "torch": "2.6.0+cu124",
            "torchvision": "0.21.0+cu124",
        },
    },
}


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
    require(stat.S_ISREG(os.lstat(resolved).st_mode), f"{path} is not a regular file")
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
        if (name, version) in seen:
            continue
        seen.add((name, version))
        metadata_path = Path(distribution._path) / "METADATA"  # type: ignore[attr-defined]
        entry: dict[str, Any] = {
            "name": name,
            "version": version,
            "license": " ".join(
                (
                    distribution.metadata.get("License-Expression")
                    or distribution.metadata.get("License")
                    or "NOASSERTION"
                ).split()
            )[:512],
        }
        if metadata_path.is_file():
            entry["metadataSha256"] = sha256_file(metadata_path)
        entries.append(entry)
    entries.sort(key=lambda entry: (entry["name"], entry["version"]))
    return entries


def check_distributions(route: dict[str, Any], inventory: list[dict[str, Any]]) -> None:
    installed = {entry["name"]: entry["version"] for entry in inventory}
    for name, version in route["expectedDistributions"].items():
        require(installed.get(name) == version, f"runtime dependency {name}=={version} is absent")
    require(
        not set(installed).intersection(FORBIDDEN_DISTRIBUTIONS),
        "runtime contains a forbidden distribution",
    )


def source_commits(producer_id: str) -> dict[str, str]:
    route = ROUTES[producer_id]
    actual: dict[str, str] = {"producer": route["sourceCommits"]["producer"]}
    if producer_id == "qwen_image_edit_2511":
        actual["diffusers"] = subprocess.run(
            ["git", "-C", "/opt/basalt/diffusers-source", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            encoding="utf-8",
            timeout=30,
        ).stdout.strip()
    else:
        actual["producer"] = subprocess.run(
            ["git", "-C", "/opt/basalt/sam3-source", "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            encoding="utf-8",
            timeout=30,
        ).stdout.strip()
    require(actual == route["sourceCommits"], "runtime source commit differs")
    return actual


IMPORT_SCRIPT = r"""
import importlib, json, sys
before = set(sys.modules)
for name in json.loads(sys.argv[1]):
    importlib.import_module(name)
after = sorted(set(sys.modules) - before)
print(json.dumps({
    "requested": json.loads(sys.argv[1]),
    "importedModules": after,
    "importedRootModules": sorted({name.split('.', 1)[0] for name in after}),
}, separators=(',', ':'), sort_keys=True))
"""


def import_trace(modules: tuple[str, ...]) -> dict[str, Any]:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": "/tmp",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DIFFUSERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }
    completed = subprocess.run(
        [sys.executable, "-I", "-c", IMPORT_SCRIPT, json.dumps(list(modules))],
        check=False,
        capture_output=True,
        env=environment,
        timeout=120,
    )
    require(
        completed.returncode == 0,
        "runtime import probe failed: "
        + completed.stderr.decode("utf-8", errors="replace")[-4096:].strip(),
    )
    trace = json.loads(completed.stdout.decode("utf-8"))
    imported = trace["importedModules"]
    forbidden = sorted(
        name for name in imported if name.startswith(FORBIDDEN_MODULE_PREFIXES)
    )
    require(not forbidden, "runtime import probe loaded a forbidden module")
    return {**trace, "forbiddenModules": forbidden, "networkEgress": "denied"}


def cyclonedx(inventory: list[dict[str, Any]], producer_id: str) -> dict[str, Any]:
    components = [
        {
            "type": "library",
            "name": entry["name"],
            "version": entry["version"],
            "licenses": [{"expression": entry["license"]}],
            "purl": f"pkg:pypi/{entry['name']}@{entry['version']}",
        }
        for entry in inventory
    ]
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {"component": {"type": "application", "name": producer_id}},
        "components": components,
    }


def build_manifest(producer_id: str) -> dict[str, Any]:
    require(platform.system() == "Linux", "runtime image evidence requires Linux")
    route = ROUTES[producer_id]
    inventory = distribution_inventory()
    check_distributions(route, inventory)
    trace = import_trace(route["modules"])
    sbom = cyclonedx(inventory, producer_id)
    dependency_bytes = canonical_bytes({"distributions": inventory})
    trace_bytes = canonical_bytes(trace)
    sbom_bytes = canonical_bytes(sbom)
    evidence = {
        "dependencyInventoryHash": hashlib.sha256(dependency_bytes).hexdigest(),
        "dependencyInventoryArtifactHash": hashlib.sha256(dependency_bytes).hexdigest(),
        "sbomArtifactHash": hashlib.sha256(sbom_bytes).hexdigest(),
        "importTraceArtifactHash": hashlib.sha256(trace_bytes).hexdigest(),
    }
    material = {
        "kind": "ReferenceImageRuntimeImage",
        "abi": route["abi"],
        "producerId": producer_id,
        "baseImage": BASE_IMAGE,
        "python": platform.python_version(),
        "sourceCommits": source_commits(producer_id),
        "modelRevision": route["modelRevision"],
        "sourceRoot": route["sourceRoot"],
        "modelRoot": route["modelRoot"],
        "workerSha256": sha256_file(WORKER_PATH),
        "dependencyInventory": inventory,
        "cycloneDxSbom": sbom,
        "importTrace": trace,
        "evidence": evidence,
        "runtimePolicy": {
            "runtimeEgress": "denied",
            "runtimeDownloads": "denied",
            "trustRemoteCode": False,
            "outputRetention": "content_addressed",
        },
    }
    return {**material, "hash": content_hash(material)}


def write_absent(path: Path, payload: bytes) -> None:
    require(path.is_absolute() and path.parent.is_dir(), "manifest parent is invalid")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def local_probe(producer_id: str) -> dict[str, Any]:
    route = ROUTES[producer_id]
    material = {
        "kind": "ReferenceImageRuntimeImageBuildPlan",
        "abi": "basalt-reference-image-runtime-image-build-plan@1",
        "status": "incomplete",
        "code": "runtime_image_not_built_or_probed",
        "producerId": producer_id,
        "baseImage": BASE_IMAGE,
        "sourceCommits": route["sourceCommits"],
        "modelRevision": route["modelRevision"],
        "modules": list(route["modules"]),
        "forbiddenDistributions": sorted(FORBIDDEN_DISTRIBUTIONS),
        "gpuWillRun": False,
        "remoteInvocationOccurred": False,
    }
    return {**material, "hash": content_hash(material)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("producer", choices=sorted(ROUTES))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--local-probe", action="store_true")
    mode.add_argument("--write", metavar="PATH")
    arguments = parser.parse_args()
    if arguments.local_probe:
        print(canonical_bytes(local_probe(arguments.producer)).decode("utf-8"))
        return 0
    manifest = build_manifest(arguments.producer)
    write_absent(Path(arguments.write), canonical_bytes(manifest) + b"\n")
    print(manifest["hash"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Reference-image runtime rejected: {error}", file=sys.stderr)
        raise SystemExit(2) from error
