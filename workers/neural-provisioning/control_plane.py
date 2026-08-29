#!/usr/bin/env python3
"""Provider-neutral, CPU-only provisioning primitives for Basalt neural workers.

The module deliberately imports only the Python standard library. Network and
Modal integration are isolated in ``modal_app.py`` and are unreachable from its
``--local-probe`` path. Artifact downloads are exact-revision operations; model
code is never imported while an input volume is being provisioned.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


CONTROL_PLANE_ABI = "basalt-neural-provisioning-control-plane@1"
FILE_INVENTORY_ABI = "basalt-neural-file-inventory@1"
DEPENDENCY_INVENTORY_ABI = "basalt-neural-dependency-inventory@1"
SBOM_ABI = "basalt-neural-cyclonedx-sbom@1"
IMPORT_TRACE_ABI = "basalt-neural-import-trace@1"
SNAPSHOT_SEAL_ABI = "basalt-neural-provisioned-snapshot@1"

TRELLIS2_SOURCE_COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
TRELLIS2_MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d"
TRELLIS_IMAGE_LARGE_MODEL_REVISION = "25e0d31ffbebe4b5a97464dd851910efc3002d96"
PIXAL3D_SOURCE_COMMIT = "f7cf38429b0bd264f1995f0f8743a88b1c728b94"
PIXAL3D_MODEL_REVISION = "b0cb2e1b794cab9aa0ac38a95d794a4d9337437f"
HUNYUAN3D21_SOURCE_COMMIT = "82920d643c0dc2f7bfd7255f45f62d386edfe60c"
HUNYUAN3D21_MODEL_REVISION = "0b94677654c57bb9a6b6845cd7b704ccf551d327"
DINOV3_MODEL_REVISION = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
QWEN_IMAGE_SOURCE_COMMIT = "6b5e1f5cec987d404be5ac6657db3b9aacb56a89"
QWEN_IMAGE_2512_REVISION = "25468b98e3276ca6700de15c6628e51b7de54a26"
QWEN_IMAGE_EDIT_2511_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
FLUX2_SOURCE_COMMIT = "50fe5162777813d869182b139e83b10743caef15"
FLUX2_KLEIN_4B_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294"
LONGCAT_IMAGE_SOURCE_COMMIT = "f0e4c43c5ef74b011ff71570fbfc2bdffbc9ab06"
LONGCAT_IMAGE_EDIT_REVISION = "7b54ef423aa7854be7861600024be5c56ab7875a"
FIRERED_IMAGE_EDIT_SOURCE_COMMIT = "456d010bd3f9bd727f1ab7fe60838caf6ee479e6"
FIRERED_IMAGE_EDIT_1_1_REVISION = "3bc3f2a12722fd9883eb6357500de191d56baaf5"
SAM3_SOURCE_COMMIT = "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
SAM3_MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"

OUTPUT_VOLUME_NAME = "basalt-neural-output"
OUTPUT_VOLUME_MOUNT = "/mnt/basalt-neural-output"
HF_READ_SECRET_NAME = "basalt-neural-huggingface-read"
PROVISION_EXECUTION_LITERAL = "PROVISION_ONE_PINNED_BASALT_NEURAL_ARTIFACT"

EVIDENCE_DIRECTORY = ".basalt-evidence"
PIN_FILE = ".basalt-artifact-pin.json"
SNAPSHOT_DIRECTORY = "snapshot"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
REVISION_PATTERN = re.compile(r"^[a-f0-9]{40}$")
ARTIFACT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
VOLUME_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
MAX_INVENTORY_FILES = 2_000_000
MAX_INVENTORY_BYTES = 512 * 1024**3
MAX_IMPORT_TRACE_BYTES = 32 * 1024**2


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


def seal_manifest(material: Mapping[str, Any]) -> dict[str, Any]:
    require("hash" not in material, "manifest material must not contain a hash")
    copied = dict(material)
    return {**copied, "hash": content_hash(copied)}


def assert_manifest_identity(value: Mapping[str, Any]) -> None:
    manifest_hash = value.get("hash")
    require(
        isinstance(manifest_hash, str) and SHA256_PATTERN.fullmatch(manifest_hash) is not None,
        "manifest hash is invalid",
    )
    material = {key: item for key, item in value.items() if key != "hash"}
    require(content_hash(material) == manifest_hash, "manifest identity differs from its bytes")


@dataclass(frozen=True)
class ArtifactSpec:
    artifact_id: str
    artifact_class: str
    transport: str
    upstream_id: str
    revision: str
    volume_name: str
    mount_path: str
    consumers: tuple[str, ...]
    access: str
    maximum_bytes: int

    def contract(self) -> dict[str, Any]:
        return {
            "artifactId": self.artifact_id,
            "artifactClass": self.artifact_class,
            "transport": self.transport,
            "upstreamId": self.upstream_id,
            "revision": self.revision,
            "volume": {
                "name": self.volume_name,
                "mount": self.mount_path,
                "payloadDirectory": SNAPSHOT_DIRECTORY,
                "createIfMissingDuringProvisioning": True,
                "inferenceReadOnly": True,
            },
            "consumers": list(self.consumers),
            "access": self.access,
            "maximumBytes": self.maximum_bytes,
        }


def _source(
    artifact_id: str,
    upstream_id: str,
    revision: str,
    consumers: tuple[str, ...],
) -> ArtifactSpec:
    slug = artifact_id.replace(".", "-").replace("_", "-")
    return ArtifactSpec(
        artifact_id=artifact_id,
        artifact_class="source",
        transport="git",
        upstream_id=upstream_id,
        revision=revision,
        volume_name=f"basalt-{slug}-{revision[:16]}",
        mount_path=f"/mnt/basalt-neural-input/{slug}",
        consumers=consumers,
        access="public_https",
        maximum_bytes=8 * 1024**3,
    )


def _model(
    artifact_id: str,
    upstream_id: str,
    revision: str,
    consumers: tuple[str, ...],
    maximum_gib: int,
    *,
    access: str = "huggingface_read_secret",
) -> ArtifactSpec:
    slug = artifact_id.replace(".", "-").replace("_", "-")
    return ArtifactSpec(
        artifact_id=artifact_id,
        artifact_class="model",
        transport="huggingface_snapshot",
        upstream_id=upstream_id,
        revision=revision,
        volume_name=f"basalt-{slug}-{revision[:16]}",
        mount_path=f"/mnt/basalt-neural-input/{slug}",
        consumers=consumers,
        access=access,
        maximum_bytes=maximum_gib * 1024**3,
    )


ARTIFACT_SPECS: tuple[ArtifactSpec, ...] = (
    _source(
        "trellis2.source",
        "microsoft/TRELLIS.2",
        TRELLIS2_SOURCE_COMMIT,
        ("trellis2",),
    ),
    _model(
        "trellis2.model",
        "microsoft/TRELLIS.2-4B",
        TRELLIS2_MODEL_REVISION,
        ("trellis2",),
        80,
    ),
    _model(
        "trellis2.sparse_decoder_model",
        "microsoft/TRELLIS-image-large",
        TRELLIS_IMAGE_LARGE_MODEL_REVISION,
        ("trellis2",),
        40,
    ),
    _source(
        "pixal3d.source",
        "TencentARC/Pixal3D",
        PIXAL3D_SOURCE_COMMIT,
        ("pixal3d",),
    ),
    _model(
        "pixal3d.model",
        "TencentARC/Pixal3D",
        PIXAL3D_MODEL_REVISION,
        ("pixal3d",),
        80,
    ),
    _source(
        "hunyuan3d21.source",
        "Tencent-Hunyuan/Hunyuan3D-2.1",
        HUNYUAN3D21_SOURCE_COMMIT,
        ("hunyuan3d21",),
    ),
    _model(
        "hunyuan3d21.model",
        "tencent/Hunyuan3D-2.1",
        HUNYUAN3D21_MODEL_REVISION,
        ("hunyuan3d21",),
        100,
    ),
    _model(
        "dinov3.model",
        "facebook/dinov3-vitl16-pretrain-lvd1689m",
        DINOV3_MODEL_REVISION,
        ("pixal3d", "trellis2"),
        16,
    ),
    _source(
        "qwen_image.source",
        "QwenLM/Qwen-Image",
        QWEN_IMAGE_SOURCE_COMMIT,
        ("qwen_image_2512", "qwen_image_edit_2511"),
    ),
    _model(
        "qwen_image_2512.model",
        "Qwen/Qwen-Image-2512",
        QWEN_IMAGE_2512_REVISION,
        ("qwen_image_2512",),
        150,
    ),
    _model(
        "qwen_image_edit_2511.model",
        "Qwen/Qwen-Image-Edit-2511",
        QWEN_IMAGE_EDIT_2511_REVISION,
        ("qwen_image_edit_2511",),
        150,
    ),
    _source(
        "flux2.source",
        "black-forest-labs/flux2",
        FLUX2_SOURCE_COMMIT,
        ("flux2_klein_4b",),
    ),
    _model(
        "flux2_klein_4b.model",
        "black-forest-labs/FLUX.2-klein-4B",
        FLUX2_KLEIN_4B_REVISION,
        ("flux2_klein_4b",),
        80,
    ),
    _source(
        "longcat_image.source",
        "meituan-longcat/LongCat-Image",
        LONGCAT_IMAGE_SOURCE_COMMIT,
        ("longcat_image_edit",),
    ),
    _model(
        "longcat_image_edit.model",
        "meituan-longcat/LongCat-Image-Edit",
        LONGCAT_IMAGE_EDIT_REVISION,
        ("longcat_image_edit",),
        80,
    ),
    _source(
        "firered_image_edit.source",
        "FireRedTeam/FireRed-Image-Edit",
        FIRERED_IMAGE_EDIT_SOURCE_COMMIT,
        ("research_firered_image_edit_1_1",),
    ),
    _model(
        "firered_image_edit_1_1.model",
        "FireRedTeam/FireRed-Image-Edit-1.1",
        FIRERED_IMAGE_EDIT_1_1_REVISION,
        ("research_firered_image_edit_1_1",),
        150,
    ),
    _source(
        "sam3.source",
        "facebookresearch/sam3",
        SAM3_SOURCE_COMMIT,
        ("sam3",),
    ),
    _model(
        "sam3.model",
        "facebook/sam3",
        SAM3_MODEL_REVISION,
        ("sam3",),
        24,
    ),
)

ARTIFACTS_BY_ID = {spec.artifact_id: spec for spec in ARTIFACT_SPECS}

PROVISIONING_POLICY: dict[str, Any] = {
    "executionClass": "cpu",
    "gpu": None,
    "cpu": {"request": 2.0, "limit": 4.0},
    "memoryMiB": {"request": 4096, "limit": 16384},
    # Artifact staging and Hugging Face's local cache both live inside the
    # destination Volume. Leave ephemeral disk at Modal's small default rather
    # than reserving the platform's 512 GiB minimum large-disk tier.
    "ephemeralDisk": "modal_default",
    "minContainers": 0,
    "maxContainers": 1,
    "maxConcurrentInputs": 1,
    "bufferContainers": 0,
    "scaledownWindowSeconds": 60,
    "timeoutSeconds": 21600,
    "retries": 0,
    "modelImports": "denied",
    "trustRemoteCode": False,
    "egress": "fixed_artifact_origins_only",
    "arbitraryUrls": "denied",
    "credentials": {
        "modalTokenReadByWorker": False,
        "huggingFaceSecretName": HF_READ_SECRET_NAME,
        "secretValueInArgumentsOrReceipts": False,
    },
}

INFERENCE_POLICY: dict[str, Any] = {
    "inputVolumes": "read_only",
    "outputVolume": OUTPUT_VOLUME_NAME,
    "outputVolumeReadOnly": False,
    "runtimeDownloads": "denied",
    "runtimeEgress": "denied",
    "blockNetwork": True,
    "modalResourceAccess": "denied",
    "restrictModalAccess": True,
    "trustRemoteCode": False,
    "minContainers": 0,
    "maxContainers": 1,
    "maxConcurrentInputs": 1,
    "bufferContainers": 0,
    "scaledownWindowSeconds": 60,
    "retries": 0,
    "singleUseContainer": True,
}

OUTPUT_VOLUME_CONTRACT: dict[str, Any] = {
    "name": OUTPUT_VOLUME_NAME,
    "mount": OUTPUT_VOLUME_MOUNT,
    "createIfMissingDuringProvisioning": True,
    "writers": ["qualified_neural_workers"],
    "layout": "attempts/<request-sha256-prefix>/<request-sha256>/<attempt-sha256>",
    "publish": "atomic_directory_rename_then_volume_commit",
    "overwrite": "denied",
    "requiredReceipt": "content_addressed_canonical_json",
    "consumerAccess": "host_by_exact_receipt_path",
}


def validate_control_plane() -> None:
    require(len(ARTIFACTS_BY_ID) == len(ARTIFACT_SPECS), "artifact IDs are not unique")
    volume_names: set[str] = set()
    mount_paths: set[str] = set()
    for spec in ARTIFACT_SPECS:
        require(ARTIFACT_ID_PATTERN.fullmatch(spec.artifact_id) is not None, "artifact ID is invalid")
        require(spec.artifact_class in {"source", "model"}, "artifact class is invalid")
        require(spec.transport in {"git", "huggingface_snapshot"}, "artifact transport is invalid")
        require(REVISION_PATTERN.fullmatch(spec.revision) is not None, "artifact revision is not exact")
        require(spec.volume_name not in volume_names, "input volume names are not unique")
        require(VOLUME_NAME_PATTERN.fullmatch(spec.volume_name) is not None, "input volume name is invalid")
        require(spec.mount_path not in mount_paths, "input mount paths are not unique")
        require(spec.volume_name != OUTPUT_VOLUME_NAME, "an input volume reuses the output volume")
        require(PurePosixPath(spec.mount_path).is_absolute(), "input mount path is not absolute")
        require(spec.consumers, "artifact has no declared consumers")
        require(0 < spec.maximum_bytes <= MAX_INVENTORY_BYTES, "artifact byte bound is invalid")
        volume_names.add(spec.volume_name)
        mount_paths.add(spec.mount_path)

    dino = ARTIFACTS_BY_ID["dinov3.model"]
    require(dino.consumers == ("pixal3d", "trellis2"), "DINOv3 must be one shared artifact")
    require(PROVISIONING_POLICY["gpu"] is None, "provisioning must not allocate a GPU")
    require(PROVISIONING_POLICY["retries"] == 0, "provisioning retries must remain disabled")
    require(INFERENCE_POLICY["runtimeEgress"] == "denied", "inference egress must be denied")
    require(INFERENCE_POLICY["retries"] == 0, "inference retries must remain disabled")
    require(OUTPUT_VOLUME_CONTRACT["name"] == "basalt-neural-output", "output volume drifted")


def local_contract() -> dict[str, Any]:
    validate_control_plane()
    material = {
        "kind": "BasaltNeuralProvisioningControlPlane",
        "abi": CONTROL_PLANE_ABI,
        "status": "incomplete",
        "code": "artifacts_declared_but_not_provisioned_or_qualified",
        "remoteInvocationOccurred": False,
        "volumeCreationOccurred": False,
        "downloadOccurred": False,
        "gpuAllocated": False,
        "credentialsInspected": False,
        "artifacts": [spec.contract() for spec in sorted(ARTIFACT_SPECS, key=lambda item: item.artifact_id)],
        "outputVolume": OUTPUT_VOLUME_CONTRACT,
        "provisioningPolicy": PROVISIONING_POLICY,
        "inferencePolicy": INFERENCE_POLICY,
        "evidence": {
            "fileInventory": FILE_INVENTORY_ABI,
            "dependencyInventory": DEPENDENCY_INVENTORY_ABI,
            "sbom": SBOM_ABI,
            "importTrace": IMPORT_TRACE_ABI,
            "snapshotSeal": SNAPSHOT_SEAL_ABI,
            "qualificationBoundary": "provisioning_evidence_does_not_make_a_provider_eligible",
        },
    }
    return seal_manifest(material)


def artifact_spec(artifact_id: str) -> ArtifactSpec:
    require(isinstance(artifact_id, str), "artifact ID must be a string")
    require(artifact_id in ARTIFACTS_BY_ID, "artifact ID is not declared")
    return ARTIFACTS_BY_ID[artifact_id]


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), count


def inventory_tree(root: Path, spec: ArtifactSpec) -> dict[str, Any]:
    require(not root.is_symlink(), "inventory root must not be a symlink")
    root = root.resolve(strict=True)
    require(root.is_dir(), "inventory root must be a directory")
    entries: list[dict[str, Any]] = []
    total_bytes = 0

    for current_text, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_text)
        relative_current = current.relative_to(root)
        if relative_current == Path(".") and EVIDENCE_DIRECTORY in directory_names:
            directory_names.remove(EVIDENCE_DIRECTORY)
        directory_names.sort()
        file_names.sort()

        for directory_name in directory_names:
            directory = current / directory_name
            metadata = os.lstat(directory)
            require(stat.S_ISDIR(metadata.st_mode), "artifact tree contains a linked or special directory")

        for file_name in file_names:
            path = current / file_name
            metadata = os.lstat(path)
            require(stat.S_ISREG(metadata.st_mode), "artifact tree contains a linked or special file")
            relative = path.relative_to(root).as_posix()
            require(relative != "" and not relative.startswith("/"), "artifact path is invalid")
            require(".." not in PurePosixPath(relative).parts, "artifact path escapes its root")
            digest, byte_count = _sha256_file(path)
            total_bytes += byte_count
            require(total_bytes <= min(spec.maximum_bytes, MAX_INVENTORY_BYTES), "artifact byte bound exceeded")
            entries.append(
                {
                    "path": relative,
                    "bytes": byte_count,
                    "sha256": digest,
                    "executable": bool(stat.S_IMODE(metadata.st_mode) & 0o111),
                }
            )
            require(len(entries) <= MAX_INVENTORY_FILES, "artifact file-count bound exceeded")

    require(entries, "artifact tree is empty")
    tree_hash = content_hash(entries)
    return seal_manifest(
        {
            "kind": "BasaltNeuralFileInventory",
            "abi": FILE_INVENTORY_ABI,
            "artifact": spec.contract(),
            "fileCount": len(entries),
            "totalBytes": total_bytes,
            "treeHash": tree_hash,
            "files": entries,
        }
    )


def verify_inventory(root: Path, spec: ArtifactSpec, expected: Mapping[str, Any]) -> None:
    assert_manifest_identity(expected)
    actual = inventory_tree(root, spec)
    require(actual == dict(expected), "artifact bytes differ from the retained file inventory")


def _normalized_package_name(value: str) -> str:
    normalized = re.sub(r"[-_.]+", "-", value).lower()
    require(bool(normalized), "dependency name is empty")
    return normalized


def build_dependency_inventory(packages: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    by_identity: dict[tuple[str, str, str], dict[str, Any]] = {}
    for package in packages:
        name_value = package.get("name")
        version_value = package.get("version")
        ecosystem_value = package.get("ecosystem", "pypi")
        require(isinstance(name_value, str), "dependency name must be a string")
        require(isinstance(version_value, str) and bool(version_value), "dependency version is absent")
        require(ecosystem_value in {"deb", "pypi"}, "dependency ecosystem is invalid")
        name = _normalized_package_name(name_value)
        license_value = package.get("license", "NOASSERTION")
        require(isinstance(license_value, str), "dependency license must be a string")
        license_value = " ".join(license_value.split())[:512] or "NOASSERTION"
        metadata_hash = package.get("metadataSha256")
        require(
            metadata_hash is None
            or (isinstance(metadata_hash, str) and SHA256_PATTERN.fullmatch(metadata_hash) is not None),
            "dependency metadata hash is invalid",
        )
        item: dict[str, Any] = {
            "ecosystem": ecosystem_value,
            "name": name,
            "version": version_value,
            "license": license_value,
        }
        if metadata_hash is not None:
            item["metadataSha256"] = metadata_hash
        identity = (ecosystem_value, name, version_value)
        existing = by_identity.get(identity)
        require(
            existing is None or existing == item,
            "dependency inventory contains conflicting metadata for one package version",
        )
        by_identity[identity] = item

    normalized = list(by_identity.values())
    normalized.sort(key=lambda item: (item["ecosystem"], item["name"], item["version"]))
    return seal_manifest(
        {
            "kind": "BasaltNeuralDependencyInventory",
            "abi": DEPENDENCY_INVENTORY_ABI,
            "packages": normalized,
        }
    )


def capture_dependency_inventory() -> dict[str, Any]:
    packages: list[dict[str, Any]] = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if not isinstance(name, str) or not name.strip():
            continue
        license_value = distribution.metadata.get("License-Expression") or distribution.metadata.get("License")
        requirements = sorted(distribution.requires or [])
        metadata_material = {
            "name": name,
            "version": distribution.version,
            "license": license_value if isinstance(license_value, str) else "NOASSERTION",
            "requires": requirements,
        }
        packages.append(
            {
                "name": name,
                "version": distribution.version,
                "license": license_value if isinstance(license_value, str) else "NOASSERTION",
                "metadataSha256": content_hash(metadata_material),
                "ecosystem": "pypi",
            }
        )
    dpkg_query = shutil.which("dpkg-query")
    if dpkg_query is not None:
        completed = subprocess.run(
            [dpkg_query, "-W", "-f=${binary:Package}\t${Version}\n"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        for line in completed.stdout.splitlines():
            name, separator, version = line.partition("\t")
            require(bool(separator) and bool(name) and bool(version), "dpkg dependency output is invalid")
            packages.append(
                {
                    "ecosystem": "deb",
                    "name": name,
                    "version": version,
                    "license": "NOASSERTION",
                }
            )
    return build_dependency_inventory(packages)


def build_cyclonedx_sbom(
    dependency_inventory: Mapping[str, Any],
    *,
    subject_name: str,
    subject_version: str,
) -> dict[str, Any]:
    assert_manifest_identity(dependency_inventory)
    require(dependency_inventory.get("abi") == DEPENDENCY_INVENTORY_ABI, "dependency ABI differs")
    components = []
    for package in dependency_inventory.get("packages", []):
        purl_type = "pypi" if package["ecosystem"] == "pypi" else "deb/debian"
        components.append(
            {
                "type": "library",
                "bom-ref": f"pkg:{purl_type}/{package['name']}@{package['version']}",
                "name": package["name"],
                "version": package["version"],
                "licenses": [{"license": {"name": package["license"]}}],
            }
        )
    subject_ref = f"basalt:{subject_name}@{subject_version}"
    return seal_manifest(
        {
            "kind": "BasaltNeuralCycloneDxSbom",
            "abi": SBOM_ABI,
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "version": 1,
            "metadata": {
                "component": {
                    "type": "application",
                    "bom-ref": subject_ref,
                    "name": subject_name,
                    "version": subject_version,
                }
            },
            "components": components,
            "dependencies": [
                {
                    "ref": subject_ref,
                    "dependsOn": [component["bom-ref"] for component in components],
                }
            ],
            "dependencyInventoryHash": dependency_inventory["hash"],
        }
    )


def build_import_trace(
    probes: Sequence[str],
    modules: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    require(all(isinstance(probe, str) and probe for probe in probes), "import probe is invalid")
    items: list[dict[str, Any]] = []
    names: set[str] = set()
    for module in modules:
        name = module.get("name")
        origin = module.get("origin")
        require(isinstance(name, str) and name, "traced module name is invalid")
        require(name not in names, "import trace contains a duplicate module")
        require(origin is None or isinstance(origin, str), "traced module origin is invalid")
        names.add(name)
        item: dict[str, Any] = {"name": name, "origin": origin}
        file_hash = module.get("sha256")
        byte_count = module.get("bytes")
        if file_hash is not None or byte_count is not None:
            require(
                isinstance(file_hash, str) and SHA256_PATTERN.fullmatch(file_hash) is not None,
                "traced module hash is invalid",
            )
            require(isinstance(byte_count, int) and byte_count >= 0, "traced module byte count is invalid")
            item.update({"sha256": file_hash, "bytes": byte_count})
        items.append(item)
    items.sort(key=lambda item: item["name"])
    return seal_manifest(
        {
            "kind": "BasaltNeuralImportTrace",
            "abi": IMPORT_TRACE_ABI,
            "probes": list(probes),
            "networkPolicy": "audit_hook_denied_connect_and_resolution",
            "subprocessPolicy": "audit_hook_denied",
            "networkAttempts": 0,
            "subprocessAttempts": 0,
            "modules": items,
        }
    )


_IMPORT_TRACE_SCRIPT = r'''
import hashlib
import importlib
import json
import os
import stat
import sys

probes = json.loads(sys.argv[1])
extra_paths = json.loads(sys.argv[2])
for extra_path in reversed(extra_paths):
    sys.path.insert(0, extra_path)

def deny(event, args):
    if event in {
        "socket.connect",
        "socket.connect_ex",
        "socket.getaddrinfo",
        "subprocess.Popen",
        "os.system",
    }:
        raise RuntimeError("forbidden import-time side effect: " + event)

sys.addaudithook(deny)
before = set(sys.modules)
for probe in probes:
    importlib.import_module(probe)

items = []
for name in sorted(set(sys.modules) - before):
    module = sys.modules.get(name)
    origin = getattr(module, "__file__", None)
    item = {"name": name, "origin": origin}
    if isinstance(origin, str):
        candidate = origin
        if candidate.endswith((".pyc", ".pyo")):
            try:
                source = importlib.util.source_from_cache(candidate)
            except (ValueError, NotImplementedError):
                source = None
            if source and os.path.isfile(source):
                candidate = source
        try:
            metadata = os.lstat(candidate)
        except OSError:
            metadata = None
        if metadata is not None and stat.S_ISREG(metadata.st_mode):
            digest = hashlib.sha256()
            size = 0
            with open(candidate, "rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    digest.update(chunk)
            item.update({"origin": candidate, "sha256": digest.hexdigest(), "bytes": size})
    items.append(item)
sys.stdout.write(json.dumps(items, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True))
'''


def capture_import_trace(
    probes: Sequence[str],
    *,
    extra_paths: Sequence[Path] = (),
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    require(probes, "at least one import probe is required")
    require(0 < timeout_seconds <= 600, "import trace timeout is invalid")
    normalized_paths = [str(path.resolve(strict=True)) for path in extra_paths]
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": tempfile.gettempdir(),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DIFFUSERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            _IMPORT_TRACE_SCRIPT,
            json.dumps(list(probes), separators=(",", ":")),
            json.dumps(normalized_paths, separators=(",", ":")),
        ],
        check=True,
        capture_output=True,
        env=environment,
        timeout=timeout_seconds,
    )
    require(len(completed.stdout) <= MAX_IMPORT_TRACE_BYTES, "import trace output exceeds its bound")
    decoded = json.loads(completed.stdout.decode("utf-8"))
    require(isinstance(decoded, list), "import trace output is invalid")
    return build_import_trace(probes, decoded)


def _write_manifest(path: Path, manifest: Mapping[str, Any]) -> None:
    assert_manifest_identity(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = canonical_bytes(manifest) + b"\n"
    if path.exists():
        require(path.is_file() and not path.is_symlink(), "manifest path is not a regular file")
        require(path.read_bytes() == payload, "existing manifest differs")
        return
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def seal_snapshot(
    root: Path,
    spec: ArtifactSpec,
    *,
    import_probes: Sequence[str],
) -> dict[str, Any]:
    root = root.resolve(strict=True)
    pin = seal_manifest(
        {
            "kind": "BasaltNeuralArtifactPin",
            "abi": "basalt-neural-artifact-pin@1",
            "artifactId": spec.artifact_id,
            "artifactClass": spec.artifact_class,
            "transport": spec.transport,
            "upstreamId": spec.upstream_id,
            "revision": spec.revision,
        }
    )
    _write_manifest(root / PIN_FILE, pin)
    inventory = inventory_tree(root, spec)
    dependencies = capture_dependency_inventory()
    sbom = build_cyclonedx_sbom(
        dependencies,
        subject_name="basalt-neural-provisioner",
        subject_version=CONTROL_PLANE_ABI,
    )
    import_trace = capture_import_trace(import_probes)
    evidence_root = root / EVIDENCE_DIRECTORY
    _write_manifest(evidence_root / f"file-inventory-{inventory['hash']}.json", inventory)
    _write_manifest(evidence_root / f"dependency-inventory-{dependencies['hash']}.json", dependencies)
    _write_manifest(evidence_root / f"sbom-{sbom['hash']}.cdx.json", sbom)
    _write_manifest(evidence_root / f"import-trace-{import_trace['hash']}.json", import_trace)
    seal = seal_manifest(
        {
            "kind": "BasaltNeuralProvisionedSnapshot",
            "abi": SNAPSHOT_SEAL_ABI,
            "artifact": spec.contract(),
            "pinHash": pin["hash"],
            "fileInventoryHash": inventory["hash"],
            "dependencyInventoryHash": dependencies["hash"],
            "sbomHash": sbom["hash"],
            "importTraceHash": import_trace["hash"],
            "qualificationStatus": "incomplete",
            "qualificationReason": "provisioned_bytes_require_runtime_and_output_qualification",
        }
    )
    _write_manifest(evidence_root / "snapshot-seal.json", seal)
    return seal


def _existing_seal(root: Path, spec: ArtifactSpec) -> dict[str, Any] | None:
    seal_path = root / EVIDENCE_DIRECTORY / "snapshot-seal.json"
    if not root.exists():
        return None
    require(root.is_dir() and not root.is_symlink(), "snapshot path is not a regular directory")
    if not seal_path.exists():
        require(not any(root.iterdir()), "unsealed snapshot bytes require an explicit volume reset")
        return None
    require(seal_path.is_file() and not seal_path.is_symlink(), "snapshot seal is not a regular file")
    raw = seal_path.read_bytes()
    value = json.loads(raw.decode("utf-8"))
    require(isinstance(value, dict), "snapshot seal is not a JSON object")
    require(raw.rstrip(b"\n") == canonical_bytes(value), "snapshot seal is not canonical JSON")
    assert_manifest_identity(value)
    require(value.get("artifact") == spec.contract(), "snapshot seal belongs to another artifact")
    inventory_hash = value.get("fileInventoryHash")
    require(
        isinstance(inventory_hash, str) and SHA256_PATTERN.fullmatch(inventory_hash) is not None,
        "snapshot file inventory is absent or invalid",
    )
    inventory_path = root / EVIDENCE_DIRECTORY / f"file-inventory-{inventory_hash}.json"
    require(
        inventory_path.is_file() and not inventory_path.is_symlink(),
        "snapshot file inventory is not a regular file",
    )
    inventory_raw = inventory_path.read_bytes()
    inventory = json.loads(inventory_raw.decode("utf-8"))
    require(
        inventory_raw.rstrip(b"\n") == canonical_bytes(inventory),
        "snapshot file inventory is not canonical JSON",
    )
    verify_inventory(root, spec, inventory)
    return value


def _prepare_staging(parent: Path, artifact_id: str) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{artifact_id}-", dir=parent))
    require(staging.parent.resolve() == parent.resolve(), "staging directory escaped its volume")
    return staging


def _publish_staging(staging: Path, destination: Path) -> None:
    require(not destination.exists(), "destination appeared while provisioning")
    os.replace(staging, destination)


def provision_git_source(spec: ArtifactSpec, mount_root: Path) -> dict[str, Any]:
    require(spec.artifact_class == "source" and spec.transport == "git", "artifact is not a Git source")
    destination = mount_root / SNAPSHOT_DIRECTORY
    retained = _existing_seal(destination, spec)
    if retained is not None:
        return retained
    staging = _prepare_staging(mount_root, spec.artifact_id)
    repository = f"https://github.com/{spec.upstream_id}.git"
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": tempfile.gettempdir(),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    try:
        subprocess.run(["git", "init", "--quiet", str(staging)], check=True, env=environment)
        subprocess.run(
            ["git", "-C", str(staging), "remote", "add", "origin", repository],
            check=True,
            env=environment,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(staging),
                "-c",
                "protocol.file.allow=never",
                "fetch",
                "--quiet",
                "--depth=1",
                "--filter=blob:none",
                "origin",
                spec.revision,
            ],
            check=True,
            env=environment,
        )
        subprocess.run(
            ["git", "-C", str(staging), "checkout", "--quiet", "--detach", "FETCH_HEAD"],
            check=True,
            env=environment,
        )
        actual = subprocess.run(
            ["git", "-C", str(staging), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            env=environment,
            text=True,
        ).stdout.strip()
        require(actual == spec.revision, "Git checkout differs from the declared commit")
        shutil.rmtree(staging / ".git")
        seal = seal_snapshot(staging, spec, import_probes=("json", "hashlib"))
        _publish_staging(staging, destination)
        return seal
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def provision_huggingface_snapshot(spec: ArtifactSpec, mount_root: Path) -> dict[str, Any]:
    require(
        spec.artifact_class == "model" and spec.transport == "huggingface_snapshot",
        "artifact is not a Hugging Face model snapshot",
    )
    destination = mount_root / SNAPSHOT_DIRECTORY
    retained = _existing_seal(destination, spec)
    if retained is not None:
        return retained
    staging = _prepare_staging(mount_root, spec.artifact_id)
    try:
        # Lazy import keeps --local-probe and ordinary tests dependency-free. The
        # library resolves its own read credential; Basalt never reads or returns it.
        from huggingface_hub import snapshot_download  # type: ignore[import-not-found]

        snapshot_download(
            repo_id=spec.upstream_id,
            revision=spec.revision,
            local_dir=str(staging),
            local_dir_use_symlinks=False,
            max_workers=4,
        )
        cache_directory = staging / ".cache"
        if cache_directory.exists():
            shutil.rmtree(cache_directory)
        seal = seal_snapshot(staging, spec, import_probes=("huggingface_hub",))
        _publish_staging(staging, destination)
        return seal
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def provision_artifact(artifact_id: str, mount_root: Path) -> dict[str, Any]:
    spec = artifact_spec(artifact_id)
    # Modal exposes a declared Volume mount through a platform-owned symlink.
    # The remote wrapper supplies the exact path from this spec. Resolve it
    # once, then keep the inventory and publication rules below fail-closed for
    # every child; local tests may supply an isolated real directory.
    resolved_mount = mount_root.resolve(strict=True)
    resolved_metadata = os.lstat(resolved_mount)
    require(stat.S_ISDIR(resolved_metadata.st_mode), "artifact volume mount is absent")
    children = sorted(path.name for path in resolved_mount.iterdir())
    require(
        not children or children == [SNAPSHOT_DIRECTORY],
        "artifact volume contains an interrupted or undeclared payload and requires an explicit reset",
    )
    if spec.transport == "git":
        return provision_git_source(spec, resolved_mount)
    if spec.transport == "huggingface_snapshot":
        return provision_huggingface_snapshot(spec, resolved_mount)
    raise AssertionError("validated artifact transport has no provisioner")


def output_attempt_path(request_hash: str, attempt_hash: str) -> Path:
    require(SHA256_PATTERN.fullmatch(request_hash) is not None, "request hash is invalid")
    require(SHA256_PATTERN.fullmatch(attempt_hash) is not None, "attempt hash is invalid")
    relative = Path("attempts") / request_hash[:2] / request_hash / attempt_hash
    require(".." not in relative.parts and not relative.is_absolute(), "output path escaped its volume")
    return Path(OUTPUT_VOLUME_MOUNT) / relative


validate_control_plane()
