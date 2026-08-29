#!/usr/bin/env python3
"""Prepare exact, model-free Qwen Edit and SAM 3 evaluation-smoke packages.

The script consumes retained provisioning receipts and runtime probes.  It
never contacts Modal, Hugging Face, or a model.  Output JSON is canonical and
content-addressed so the paid runners can reject any changed input.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import stat
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REQUEST_ABI = "basalt-reference-image-worker-request@5"
AUTHORIZATION_ABI = "basalt-reference-image-evaluation-smoke-authorization@1"
TECHNICAL_QUALIFICATION_ABI = (
    "basalt-reference-image-evaluation-technical-qualification@1"
)
RUNTIME_PROBE_ABI = "basalt-reference-image-runtime-probe@1"
OUTPUT_VOLUME = "basalt-neural-output"
EXECUTION_CLASS = "remote_neural_image"
RUNTIME_POLICY = {
    "runtimeEgress": "denied",
    "runtimeDownloads": "denied",
    "trustRemoteCode": False,
    "weightProvisioning": "preloaded_immutable",
    "outputRetention": "content_addressed",
}
RUNTIME_POLICY_HASH = hashlib.sha256(
    json.dumps(RUNTIME_POLICY, separators=(",", ":"), sort_keys=True).encode("utf-8")
).hexdigest()
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MODAL_IMAGE_ID = re.compile(r"^im-[A-Za-z0-9]+$")
ENTITY_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,127}$")
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 256 * 1024 * 1024
ACTIVE_REGION_CONTEXT_HANDOFF_ABI = "basalt-active-region-context-handoff@1"
ACTIVE_REGION_REQUIREMENT_INTENT_MANIFEST_ABI = (
    "basalt-active-region-requirement-intent-manifest@1"
)
ACTIVE_REGION_MATERIALIZATION_ABI = (
    "basalt-active-region-composition-input-materialization@1"
)

QWEN = {
    "id": "qwen_image_edit_2511",
    "task": "regional_composition_generation",
    "sourceRepository": "QwenLM/Qwen-Image",
    "sourceCommit": "6b5e1f5cec987d404be5ac6657db3b9aacb56a89",
    "modelId": "Qwen/Qwen-Image-Edit-2511",
    "modelRevision": "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9",
    "licenseId": "Apache-2.0",
    "licenseUrl": "https://huggingface.co/Qwen/Qwen-Image-Edit-2511",
}
SAM3 = {
    "id": "sam3",
    "task": "prompted_segmentation",
    "sourceRepository": "facebookresearch/sam3",
    "sourceCommit": "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7",
    "modelId": "facebook/sam3",
    "modelRevision": "3c879f39826c281e95690f02c7821c4de09afae7",
    "licenseId": "SAM-3-License",
    "licenseUrl": "https://huggingface.co/facebook/sam3",
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


def seal(material: dict[str, Any]) -> dict[str, Any]:
    require("hash" not in material, "material already contains a hash")
    return {**material, "hash": content_hash(material)}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_regular(path_value: str | Path, maximum: int, label: str) -> bytes:
    path = Path(path_value)
    supplied_metadata = os.lstat(path)
    require(stat.S_ISREG(supplied_metadata.st_mode), f"{label} must be a regular file")
    resolved = path.resolve(strict=True)
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(0 < metadata.st_size <= maximum, f"{label} exceeds its byte bound")
    return resolved.read_bytes()


def decode_json(
    path_value: str | Path,
    label: str,
    *,
    sealed: bool,
    identity_excludes: tuple[str, ...] = ("hash",),
) -> dict[str, Any]:
    raw = read_regular(path_value, MAX_JSON_BYTES, label)
    value = json.loads(raw.decode("utf-8"))
    require(isinstance(value, dict), f"{label} must be a JSON object")
    require(raw.rstrip(b"\n") == canonical_bytes(value), f"{label} must be canonical JSON")
    if sealed:
        identity = value.get("hash")
        require(isinstance(identity, str) and SHA256.fullmatch(identity) is not None, f"{label} hash is invalid")
        require(
            content_hash(
                {
                    key: item
                    for key, item in value.items()
                    if key not in identity_excludes
                }
            )
            == identity,
            f"{label} identity differs",
        )
    return value


def png_dimensions(payload: bytes, label: str) -> tuple[int, int]:
    require(payload.startswith(b"\x89PNG\r\n\x1a\n"), f"{label} is not a PNG")
    require(len(payload) >= 33 and payload[12:16] == b"IHDR", f"{label} lacks a PNG IHDR")
    width, height = struct.unpack(">II", payload[16:24])
    require(width == 512 and height == 512, f"{label} must be exactly 512x512")
    return width, height


def artifact(payload: bytes, media_type: str) -> dict[str, Any]:
    identity = hashlib.sha256(payload).hexdigest()
    return {
        "locator": f"binary-artifacts/{identity}.bin",
        "artifactHash": identity,
        "bytes": len(payload),
        "mediaType": media_type,
    }


def validate_provisioning_receipt(
    receipt: dict[str, Any],
    *,
    artifact_id: str,
    revision: str,
    volume_name: str,
    snapshot_path: str,
) -> None:
    require(
        set(receipt)
        == {
            "kind",
            "abi",
            "artifactId",
            "revision",
            "volumeName",
            "snapshotPath",
            "snapshotSealHash",
            "qualificationStatus",
            "modelWasImported",
            "gpuWasAllocated",
        },
        "provisioning receipt fields differ",
    )
    require(receipt["kind"] == "BasaltNeuralProvisioningReceipt", "provisioning receipt kind differs")
    require(receipt["abi"] == "basalt-neural-provisioning-receipt@1", "provisioning receipt ABI differs")
    require(receipt["artifactId"] == artifact_id, "provisioning artifact differs")
    require(receipt["revision"] == revision, "provisioning revision differs")
    require(receipt["volumeName"] == volume_name, "provisioning Volume differs")
    require(receipt["snapshotPath"] == snapshot_path, "provisioning snapshot path differs")
    require(SHA256.fullmatch(receipt.get("snapshotSealHash", "")) is not None, "snapshot seal hash is invalid")
    require(receipt["qualificationStatus"] == "incomplete", "provisioning receipt made an admission claim")
    require(receipt["modelWasImported"] is False and receipt["gpuWasAllocated"] is False, "provisioning imported a model or allocated a GPU")


def technical_qualification(
    producer: dict[str, str],
    probe: dict[str, Any],
    source_receipt: dict[str, Any],
    model_receipt: dict[str, Any],
    qualified_at: str,
) -> dict[str, Any]:
    source_slug = "qwen-image-source" if producer["id"] == "qwen_image_edit_2511" else "sam3-source"
    model_slug = "qwen-image-edit-2511-model" if producer["id"] == "qwen_image_edit_2511" else "sam3-model"
    source_artifact_id = "qwen_image.source" if producer["id"] == "qwen_image_edit_2511" else "sam3.source"
    model_artifact_id = "qwen_image_edit_2511.model" if producer["id"] == "qwen_image_edit_2511" else "sam3.model"
    validate_provisioning_receipt(
        source_receipt,
        artifact_id=source_artifact_id,
        revision=producer["sourceCommit"],
        volume_name=f"basalt-{source_slug}-{producer['sourceCommit'][:16]}",
        snapshot_path=f"/mnt/basalt-neural-input/{source_slug}/snapshot",
    )
    validate_provisioning_receipt(
        model_receipt,
        artifact_id=model_artifact_id,
        revision=producer["modelRevision"],
        volume_name=f"basalt-{model_slug}-{producer['modelRevision'][:16]}",
        snapshot_path=f"/mnt/basalt-neural-input/{model_slug}/snapshot",
    )
    require(probe.get("kind") == "ReferenceImageRuntimeProbe" and probe.get("abi") == RUNTIME_PROBE_ABI, "runtime probe contract differs")
    require(probe.get("status") == "eligible" and probe.get("producerId") == producer["id"], "runtime probe did not qualify this producer")
    require(content_hash({key: item for key, item in probe.items() if key != "hash"}) == probe.get("hash"), "runtime probe identity differs")
    require(MODAL_IMAGE_ID.fullmatch(probe.get("modalImageId", "")) is not None, "runtime Modal image ID is invalid")
    require(probe.get("sourceSnapshotSealHash") == source_receipt["snapshotSealHash"], "runtime source snapshot differs from provisioning")
    require(probe.get("modelSnapshotSealHash") == model_receipt["snapshotSealHash"], "runtime model snapshot differs from provisioning")
    require(probe.get("modelWeightsLoaded") is False, "runtime probe unexpectedly loaded model weights")
    require(probe.get("gpuAllocated") is True and probe.get("networkEgress") == "denied", "runtime probe isolation evidence differs")
    import_probe = probe.get("importProbe")
    require(isinstance(import_probe, dict) and import_probe.get("forbiddenModules") == [], "runtime probe imported a forbidden module")
    runtime_evidence = probe.get("runtimeEvidence")
    require(
        isinstance(runtime_evidence, dict)
        and set(runtime_evidence)
        == {
            "dependencyInventoryHash",
            "dependencyInventoryArtifactHash",
            "sbomArtifactHash",
            "importTraceArtifactHash",
        },
        "runtime evidence differs",
    )
    for value in [
        probe.get("runtimeManifestHash"),
        probe.get("workerSha256"),
        probe.get("modelInventoryArtifactHash"),
        *runtime_evidence.values(),
    ]:
        require(isinstance(value, str) and SHA256.fullmatch(value) is not None, "runtime evidence hash is invalid")
    material = {
        "kind": "ReferenceImageEvaluationTechnicalQualification",
        "abi": TECHNICAL_QUALIFICATION_ABI,
        "usageScope": "evaluation_smoke",
        "producer": producer,
        "producerIdentityHash": content_hash(producer),
        "executionBinding": {
            "modalImageId": probe["modalImageId"],
            "runtimeImageHash": probe["runtimeManifestHash"],
            "workerSourceHash": probe["workerSha256"],
            "modelVolumeSnapshotHash": probe["modelSnapshotSealHash"],
            "dependencyInventoryHash": runtime_evidence["dependencyInventoryHash"],
            "dependencyInventoryArtifactHash": runtime_evidence["dependencyInventoryArtifactHash"],
            "sbomArtifactHash": runtime_evidence["sbomArtifactHash"],
            "importTraceArtifactHash": runtime_evidence["importTraceArtifactHash"],
            "modelInventoryArtifactHash": probe["modelInventoryArtifactHash"],
            "runtimePolicyHash": RUNTIME_POLICY_HASH,
        },
        "sourceVolumeSnapshotHash": probe["sourceSnapshotSealHash"],
        "evidence": {
            "runtimeProbeHash": probe["hash"],
            "sourceProvisioningReceiptHash": content_hash(source_receipt),
            "modelProvisioningReceiptHash": content_hash(model_receipt),
        },
        "qualifiedAt": qualified_at,
        "technicalStatus": "eligible",
    }
    return seal(material)


def derived_hash(fixture_hash: str, role: str) -> str:
    return content_hash({"fixtureHash": fixture_hash, "role": role})


def write_absent(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def retain_binary(root: Path, payload: bytes, record: dict[str, Any]) -> None:
    write_absent(root / record["locator"], payload)


def validate_json_artifact_reference(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} reference is absent")
    require(
        set(value) == {"locator", "artifactHash", "bytes"},
        f"{label} reference fields differ",
    )
    artifact_hash = value.get("artifactHash", "")
    require(SHA256.fullmatch(artifact_hash) is not None, f"{label} artifact hash is invalid")
    require(
        value.get("locator") == f"artifacts/{artifact_hash}.json",
        f"{label} artifact locator differs",
    )
    require(
        isinstance(value.get("bytes"), int) and 0 < value["bytes"] <= MAX_JSON_BYTES,
        f"{label} artifact byte count is invalid",
    )
    return value


def read_bound_json_artifact(
    store_root: Path,
    reference_value: Any,
    label: str,
) -> dict[str, Any]:
    reference = validate_json_artifact_reference(reference_value, label)
    payload = read_regular(store_root / reference["locator"], MAX_JSON_BYTES, label)
    require(len(payload) == reference["bytes"], f"{label} artifact byte count differs")
    require(
        hashlib.sha256(payload).hexdigest() == reference["artifactHash"],
        f"{label} artifact bytes differ",
    )
    value = json.loads(payload.decode("utf-8"))
    require(isinstance(value, dict), f"{label} must be a JSON object")
    require(payload == canonical_bytes(value) + b"\n", f"{label} is not canonical JSON")
    identity = value.get("hash", "")
    require(SHA256.fullmatch(identity) is not None, f"{label} identity is invalid")
    require(
        content_hash(
            {key: item for key, item in value.items() if key not in ("id", "hash")}
        )
        == identity,
        f"{label} sealed identity differs",
    )
    return value


def prepare_output_root(path_value: str) -> Path:
    path = Path(path_value)
    require(path.is_absolute(), "output root must be absolute")
    require(not path.exists(), "output root must be absent")
    path.mkdir(mode=0o700, parents=False)
    return path


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "timestamp timezone is absent")
    return parsed


def evaluation_authorization(
    request: dict[str, Any],
    qualification: dict[str, Any],
    issued_at: str,
    expires_at: str,
    nonce: str,
) -> dict[str, Any]:
    issued = parse_timestamp(issued_at)
    expires = parse_timestamp(expires_at)
    require(expires > issued and expires - issued <= timedelta(hours=24), "authorization expiry must be within 24 hours")
    require(SHA256.fullmatch(nonce) is not None, "authorization nonce must be a SHA-256-shaped value")
    material = {
        "kind": "ReferenceImageEvaluationSmokeAuthorization",
        "abi": AUTHORIZATION_ABI,
        "executionScope": "evaluation_smoke",
        "requestHash": request["hash"],
        "producerQualificationHash": qualification["hash"],
        "producerId": request["producerId"],
        "route": request["route"],
        "attemptId": request["attemptId"],
        "oneShot": True,
        "outputVolume": OUTPUT_VOLUME,
        "maximumOutputPixels": 512 * 512,
        "maximumGpuSeconds": 900,
        "maximumEstimatedCostUsd": 2,
        "issuerIdentityHash": content_hash({"authority": "basalt_local_evaluation_smoke_operator"}),
        "nonce": nonce,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
    }
    return seal(material)


def worker_request(
    qualification: dict[str, Any],
    route: str,
    invocation_hash: str,
    attempt_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    producer = qualification["producer"]
    material = {
        "kind": "ReferenceImageWorkerRequest",
        "abi": REQUEST_ABI,
        "route": route,
        "executionClass": EXECUTION_CLASS,
        "executionScope": "evaluation_smoke",
        "producerId": producer["id"],
        "sourceCommit": producer["sourceCommit"],
        "modelId": producer["modelId"],
        "modelRevision": producer["modelRevision"],
        "producerQualificationHash": qualification["hash"],
        "invocationHash": invocation_hash,
        "attemptId": attempt_id,
        "executionBinding": qualification["executionBinding"],
        "payload": payload,
    }
    return seal(material)


def common_inputs(arguments: argparse.Namespace, producer: dict[str, str]) -> tuple[dict[str, Any], str, str, str]:
    probe = decode_json(arguments.runtime_probe, "runtime probe", sealed=True)
    source_receipt = decode_json(arguments.source_provisioning_receipt, "source provisioning receipt", sealed=False)
    model_receipt = decode_json(arguments.model_provisioning_receipt, "model provisioning receipt", sealed=False)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    issued_at = arguments.issued_at or now.isoformat().replace("+00:00", "Z")
    expires_at = arguments.expires_at or (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    nonce = arguments.nonce or hashlib.sha256(os.urandom(32)).hexdigest()
    return technical_qualification(producer, probe, source_receipt, model_receipt, issued_at), issued_at, expires_at, nonce


def write_package(root: Path, values: dict[str, dict[str, Any]]) -> None:
    for name, value in values.items():
        write_absent(root / name, canonical_bytes(value) + b"\n")


def prepare_qwen(arguments: argparse.Namespace) -> None:
    qualification, issued_at, expires_at, nonce = common_inputs(arguments, QWEN)
    context = read_regular(arguments.context, MAX_IMAGE_BYTES, "context image")
    protected = read_regular(arguments.protected_mask, MAX_IMAGE_BYTES, "protected-pixel mask")
    png_dimensions(context, "context image")
    png_dimensions(protected, "protected-pixel mask")
    prompt = read_regular(arguments.prompt_file, 16_384, "composition prompt").decode("utf-8").strip()
    rights = read_regular(arguments.rights_statement, 64 * 1024, "rights statement")
    require(0 < len(prompt) <= 16_384, "composition prompt is empty or too large")
    require(ENTITY_ID.fullmatch(arguments.region_id) is not None, "region ID is invalid")
    context_artifact = artifact(context, "image/png")
    protected_artifact = artifact(protected, "image/png")
    rights_artifact = artifact(rights, "text/plain")
    fixture = seal(
        {
            "kind": "ReferenceImageEvaluationRegionFixture",
            "abi": "basalt-reference-image-evaluation-region-fixture@1",
            "scope": "evaluation_smoke",
            "regionId": arguments.region_id,
            "contextRender": context_artifact,
            "protectedPixelMask": protected_artifact,
            "prompt": prompt,
            "negativePrompt": arguments.negative_prompt,
            "canvas": {"width": 512, "height": 512, "colorSpace": "srgb"},
            "rightsEvidence": rights_artifact,
            "authority": "pixel_space_plumbing_fixture",
            "productionCameraClaim": False,
        }
    )
    requirement_hash = derived_hash(fixture["hash"], "requirement")
    invocation_hash = derived_hash(fixture["hash"], "invocation")
    attempt_id = content_hash({"fixtureHash": fixture["hash"], "producerId": QWEN["id"], "nonce": nonce})
    request = worker_request(
        qualification,
        "region_composition",
        invocation_hash,
        attempt_id,
        {
            "kind": "region_composition",
            "regionalPlanHash": derived_hash(fixture["hash"], "regional_plan"),
            "regionFoundationHash": derived_hash(fixture["hash"], "region_foundation"),
            "regionId": arguments.region_id,
            "contextRender": context_artifact,
            "cameraCalibrationHash": derived_hash(fixture["hash"], "pixel_space_camera"),
            "protectedPixelMask": protected_artifact,
            "requirementHashes": [requirement_hash],
            "styleContractHash": derived_hash(fixture["hash"], "style_contract"),
            "compositionIndex": 0,
            "prompt": prompt,
            "negativePrompt": arguments.negative_prompt,
            "creativeLatitude": 1,
            "seed": arguments.seed,
            "canvas": {"width": 512, "height": 512, "colorSpace": "srgb"},
            "inputRightsEvidenceHashes": [rights_artifact["artifactHash"]],
        },
    )
    authorization = evaluation_authorization(request, qualification, issued_at, expires_at, nonce)
    root = prepare_output_root(arguments.output_root)
    retain_binary(root, context, context_artifact)
    retain_binary(root, protected, protected_artifact)
    retain_binary(root, rights, rights_artifact)
    shutil.copyfile(root / context_artifact["locator"], root / "context.png")
    shutil.copyfile(root / protected_artifact["locator"], root / "protected-mask.png")
    write_package(
        root,
        {
            "technical-qualification.json": qualification,
            "fixture.json": fixture,
            "request.json": request,
            "authorization.json": authorization,
        },
    )
    command = (
        f"set -a; . {shlex.quote(str(Path(__file__).resolve().parents[2] / '.basalt/private/reference-image-evaluation.env'))}; set +a; "
        f"BASALT_QWEN_IMAGE_EDIT_2511_MODAL_IMAGE_ID={qualification['executionBinding']['modalImageId']} "
        "uvx --python 3.10 --from modal modal run --profile mo-awawdi "
        "workers/reference-image/modal_qwen.py "
        f"--request {shlex.quote(str(root / 'request.json'))} --authorization {shlex.quote(str(root / 'authorization.json'))} "
        f"--context {shlex.quote(str(root / 'context.png'))} --protected-mask {shlex.quote(str(root / 'protected-mask.png'))} "
        f"--output-root {shlex.quote(str(root))} --execution-literal RUN_ONE_BASALT_QWEN_IMAGE_EDIT_2511_EVALUATION_SMOKE"
    )
    write_absent(root / "run-command.txt", command.encode("utf-8") + b"\n")
    print(str(root / "run-command.txt"))


def multiply_matrix3(left: list[float], right: list[float]) -> list[float]:
    require(len(left) == 9 and len(right) == 9, "camera matrix dimensions differ")
    output: list[float] = []
    for row in range(3):
        for column in range(3):
            value = sum(
                left[row * 3 + inner] * right[inner * 3 + column]
                for inner in range(3)
            )
            output.append(canonical_matrix_number(value))
    return output


def canonical_affine_number(value: float) -> float | int:
    rounded = round(value, 12)
    if abs(rounded) < 1e-15:
        return 0
    return int(rounded) if float(rounded).is_integer() else rounded


def canonical_matrix_number(value: float) -> float | int:
    if abs(value) < 1e-15:
        return 0
    nearest = round(value)
    return int(nearest) if abs(value - nearest) < 1e-12 else value


def active_region_inputs(
    foundation_root_value: str,
) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any], bytes]:
    foundation_root = Path(foundation_root_value).resolve(strict=True)
    require(foundation_root.is_dir(), "foundation root must be a directory")
    handoff = decode_json(
        foundation_root / "active-region-context.json",
        "active-region context handoff",
        sealed=True,
        identity_excludes=("id", "hash"),
    )
    require(
        handoff.get("kind") == "ActiveRegionContextHandoff"
        and handoff.get("abi") == ACTIVE_REGION_CONTEXT_HANDOFF_ABI
        and handoff.get("id")
        == f"active_region_context_{handoff.get('hash', '')[:24]}",
        "active-region context handoff contract differs",
    )
    manifest = decode_json(
        foundation_root / "active-region-requirement-intents.json",
        "active-region requirement-intent manifest",
        sealed=True,
        identity_excludes=("id", "hash"),
    )
    require(
        manifest.get("kind") == "ActiveRegionRequirementIntentManifest"
        and manifest.get("abi") == ACTIVE_REGION_REQUIREMENT_INTENT_MANIFEST_ABI
        and manifest.get("id")
        == f"active_region_intents_{manifest.get('hash', '')[:24]}",
        "active-region requirement-intent manifest contract differs",
    )
    for key in ("runId", "runHash", "worldPlanHash", "regionId", "styleContractHash"):
        require(manifest.get(key) == handoff.get(key), f"active-region manifest {key} differs")
    require(
        manifest.get("activeRegionContextHandoffHash") == handoff["hash"],
        "active-region manifest belongs to another context handoff",
    )
    regional_plan = read_bound_json_artifact(
        foundation_root / "production-run/artifacts",
        handoff.get("regionalPlanArtifact"),
        "regional plan",
    )
    region_view_cell = read_bound_json_artifact(
        foundation_root / "production-run/artifacts",
        handoff.get("regionViewCellArtifact"),
        "region view cell",
    )
    require(
        regional_plan.get("kind") == "RegionalPlan"
        and regional_plan.get("hash") == handoff.get("regionalPlanHash")
        and regional_plan.get("worldPlanHash") == handoff.get("worldPlanHash")
        and regional_plan.get("surfaceIndexHash") == handoff.get("surfaceIndexHash")
        and regional_plan.get("globalFoundationHash")
        == handoff.get("globalFoundationHash"),
        "regional plan differs from its active-region handoff",
    )
    camera = region_view_cell.get("compositionCamera")
    require(isinstance(camera, dict), "region-view composition camera is absent")
    require(
        region_view_cell.get("kind") == "RegionViewCell"
        and region_view_cell.get("hash") == handoff.get("regionViewCellHash")
        and region_view_cell.get("regionalPlanHash") == handoff.get("regionalPlanHash")
        and region_view_cell.get("worldPlanHash") == handoff.get("worldPlanHash")
        and region_view_cell.get("surfaceIndexHash") == handoff.get("surfaceIndexHash")
        and region_view_cell.get("regionId") == handoff.get("regionId")
        and region_view_cell.get("regionFoundationHash")
        == handoff.get("regionFoundationHash")
        and region_view_cell.get("styleContractHash") == handoff.get("styleContractHash")
        and camera.get("hash") == handoff.get("cameraCalibrationHash"),
        "region view cell differs from its active-region handoff",
    )
    bindings = manifest.get("requirements")
    require(isinstance(bindings, list) and bindings, "active-region requirement intents are absent")
    require(
        [binding.get("requirementHash") for binding in bindings]
        == handoff.get("requirementHashes"),
        "active-region requirement hashes differ from their sealed intents",
    )
    for binding in bindings:
        require(isinstance(binding, dict), "active-region requirement binding is invalid")
        intent = read_bound_json_artifact(
            foundation_root / "production-run/artifacts",
            binding.get("intentArtifact"),
            f"asset requirement intent {binding.get('requirementId', '')}",
        )
        declaration = intent.get("declaration")
        style = intent.get("styleContract")
        require(
            intent.get("kind") == "AssetRequirementIntent"
            and intent.get("hash") == binding.get("requirementHash")
            and intent.get("declarationHash") == binding.get("declarationHash")
            and intent.get("resolutionHash") == binding.get("resolutionHash")
            and isinstance(declaration, dict)
            and declaration.get("id") == binding.get("declarationId")
            and isinstance(style, dict)
            and style.get("hash") == handoff.get("styleContractHash"),
            "active-region requirement intent differs from its manifest binding",
        )
    context_name = handoff.get("contextPngPath")
    require(context_name == "active-region-context.png", "active-region context path differs")
    context = read_regular(foundation_root / context_name, MAX_IMAGE_BYTES, "active-region context")
    width, height = png_dimensions_any(context, "active-region context")
    context_reference = handoff.get("contextRender")
    require(isinstance(context_reference, dict), "active-region context artifact is absent")
    require(
        (width, height) == (handoff.get("contextWidth"), handoff.get("contextHeight"))
        and context_reference.get("artifactHash") == hashlib.sha256(context).hexdigest()
        and context_reference.get("artifactHash") == handoff.get("contextImageHash")
        and context_reference.get("bytes") == len(context)
        and context_reference.get("mediaType") == "image/png",
        "active-region context pixels differ from their handoff",
    )
    return foundation_root, handoff, manifest, region_view_cell, context


def materialize_active_region_context(
    handoff: dict[str, Any],
    manifest: dict[str, Any],
    region_view_cell: dict[str, Any],
    source_bytes: bytes,
) -> tuple[bytes, bytes, dict[str, Any]]:
    try:
        from PIL import Image
    except ImportError as error:
        raise ValueError("active-region materialization requires local Pillow") from error

    source_width, source_height = png_dimensions_any(source_bytes, "active-region context")
    output_width = 512
    output_height = 512
    scale = canonical_affine_number(
        min(output_width / source_width, output_height / source_height)
    )
    translation_x = canonical_affine_number(
        (output_width - source_width * scale) / 2
    )
    translation_y = canonical_affine_number(
        (output_height - source_height * scale) / 2
    )
    require(
        source_width == 640
        and source_height == 384
        and scale == 0.8
        and translation_x == 0
        and translation_y == 102.4,
        "current active-region affine must be scale 0.8 with translation (0, 102.4)",
    )
    source_to_canvas = [
        scale,
        0,
        translation_x,
        0,
        scale,
        translation_y,
        0,
        0,
        1,
    ]
    inverse_scale = canonical_affine_number(1 / scale)
    canvas_to_source = [
        inverse_scale,
        0,
        canonical_affine_number(-translation_x * inverse_scale),
        0,
        inverse_scale,
        canonical_affine_number(-translation_y * inverse_scale),
        0,
        0,
        1,
    ]
    inverse_affine = tuple(canvas_to_source[:6])
    source = Image.open(io.BytesIO(source_bytes)).convert("RGB")
    letterbox_rgb = (105, 116, 125)
    context = source.transform(
        (output_width, output_height),
        Image.Transform.AFFINE,
        inverse_affine,
        resample=Image.Resampling.BICUBIC,
        fillcolor=letterbox_rgb,
    )
    coverage = Image.new("L", (source_width, source_height), 255).transform(
        (output_width, output_height),
        Image.Transform.AFFINE,
        inverse_affine,
        resample=Image.Resampling.BICUBIC,
        fillcolor=0,
    )
    protected = coverage.point(lambda value: 255 if value < 255 else 0, mode="L")
    context_buffer = io.BytesIO()
    context.save(context_buffer, format="PNG", optimize=False, compress_level=9)
    context_bytes = context_buffer.getvalue()
    protected_buffer = io.BytesIO()
    protected.save(protected_buffer, format="PNG", optimize=False, compress_level=9)
    protected_bytes = protected_buffer.getvalue()
    context_artifact = artifact(context_bytes, "image/png")
    protected_artifact = artifact(protected_bytes, "image/png")
    camera = region_view_cell["compositionCamera"]
    intrinsics = camera.get("intrinsics")
    require(
        isinstance(intrinsics, list)
        and len(intrinsics) == 9
        and all(isinstance(value, (int, float)) for value in intrinsics),
        "active-region camera intrinsics differ",
    )
    derived_intrinsics = multiply_matrix3(source_to_canvas, intrinsics)
    crop_material = {
        "kind": "CropSimilarity",
        "abi": "basalt-crop-similarity@1",
        "cameraCalibrationHash": camera["hash"],
        "sourceSize": {"width": source_width, "height": source_height},
        "outputSize": {"width": output_width, "height": output_height},
        "scale": scale,
        "rotationRadians": 0,
        "translation": {"x": translation_x, "y": translation_y},
        "sourceToCrop": source_to_canvas,
        "cropToSource": canvas_to_source,
        "derivedIntrinsics": derived_intrinsics,
        "effectiveFocalPixels": canonical_matrix_number(intrinsics[0] * scale),
    }
    crop_hash = content_hash(crop_material)
    crop = {
        **crop_material,
        "id": f"crop_similarity_{crop_hash[:24]}",
        "hash": crop_hash,
    }
    materialization = seal(
        {
            "kind": "ActiveRegionCompositionInputMaterialization",
            "abi": ACTIVE_REGION_MATERIALIZATION_ABI,
            "activeRegionContextHandoffHash": handoff["hash"],
            "requirementIntentManifestHash": manifest["hash"],
            "runId": handoff["runId"],
            "runHash": handoff["runHash"],
            "regionalPlanHash": handoff["regionalPlanHash"],
            "regionFoundationHash": handoff["regionFoundationHash"],
            "regionId": handoff["regionId"],
            "regionViewCellHash": handoff["regionViewCellHash"],
            "cameraCalibrationHash": handoff["cameraCalibrationHash"],
            "styleContractHash": handoff["styleContractHash"],
            "requirementHashes": handoff["requirementHashes"],
            "sourceContextRender": handoff["contextRender"],
            "sourceDimensions": {"width": source_width, "height": source_height},
            "outputDimensions": {"width": output_width, "height": output_height},
            "cropSimilarity": crop,
            "resampling": {
                "implementation": "Pillow.Image.transform",
                "filter": "bicubic",
                "inverseMapping": canvas_to_source,
                "letterboxRgb": list(letterbox_rgb),
            },
            "materializedContextRender": context_artifact,
            "protectedPixelMask": protected_artifact,
            "protectedPixelPolicy": "letterbox_and_fractional_boundary_pixels",
            "modelWillRun": False,
            "authority": "exact_active_region_pixels_and_camera_affine_input_only",
        }
    )
    return context_bytes, protected_bytes, materialization


def prepare_active_region_qwen(arguments: argparse.Namespace) -> None:
    qualification, issued_at, expires_at, nonce = common_inputs(arguments, QWEN)
    _, handoff, manifest, region_view_cell, source_context = active_region_inputs(
        arguments.foundation_root
    )
    context, protected, materialization = materialize_active_region_context(
        handoff,
        manifest,
        region_view_cell,
        source_context,
    )
    prompt = read_regular(arguments.prompt_file, 16_384, "composition prompt").decode(
        "utf-8"
    ).strip()
    rights = read_regular(arguments.rights_statement, 64 * 1024, "rights statement")
    require(0 < len(prompt) <= 16_384, "composition prompt is empty or too large")
    segmentation_query = arguments.segmentation_query.strip().lower()
    require(
        re.fullmatch(r"[a-z][a-z0-9 -]{0,63}", segmentation_query) is not None
        and len(segmentation_query.split()) <= 4,
        "active-region segmentation query must be a short target noun",
    )
    context_artifact = materialization["materializedContextRender"]
    protected_artifact = materialization["protectedPixelMask"]
    rights_artifact = artifact(rights, "text/plain")
    fixture = seal(
        {
            "kind": "ReferenceImageActiveRegionEvaluationFixture",
            "abi": "basalt-reference-image-active-region-evaluation-fixture@1",
            "scope": "evaluation_smoke",
            "activeRegionContextHandoffHash": handoff["hash"],
            "requirementIntentManifestHash": manifest["hash"],
            "materializationHash": materialization["hash"],
            "regionId": handoff["regionId"],
            "contextRender": context_artifact,
            "protectedPixelMask": protected_artifact,
            "prompt": prompt,
            "negativePrompt": arguments.negative_prompt,
            "segmentationQuery": segmentation_query,
            "canvas": {"width": 512, "height": 512, "colorSpace": "srgb"},
            "rightsEvidence": rights_artifact,
            "authority": "exact_active_region_context_for_advisory_composition",
            "productionCameraClaim": True,
        }
    )
    invocation_hash = content_hash(
        {
            "activeRegionContextHandoffHash": handoff["hash"],
            "materializationHash": materialization["hash"],
            "regionalPlanHash": handoff["regionalPlanHash"],
            "regionFoundationHash": handoff["regionFoundationHash"],
            "regionId": handoff["regionId"],
            "cameraCalibrationHash": handoff["cameraCalibrationHash"],
            "styleContractHash": handoff["styleContractHash"],
            "requirementHashes": handoff["requirementHashes"],
            "compositionIndex": arguments.composition_index,
            "producerId": QWEN["id"],
        }
    )
    attempt_id = content_hash(
        {
            "invocationHash": invocation_hash,
            "producerId": QWEN["id"],
            "nonce": nonce,
        }
    )
    request = worker_request(
        qualification,
        "region_composition",
        invocation_hash,
        attempt_id,
        {
            "kind": "region_composition",
            "regionalPlanHash": handoff["regionalPlanHash"],
            "regionFoundationHash": handoff["regionFoundationHash"],
            "regionId": handoff["regionId"],
            "contextRender": context_artifact,
            "cameraCalibrationHash": handoff["cameraCalibrationHash"],
            "protectedPixelMask": protected_artifact,
            "requirementHashes": handoff["requirementHashes"],
            "styleContractHash": handoff["styleContractHash"],
            "compositionIndex": arguments.composition_index,
            "prompt": prompt,
            "negativePrompt": arguments.negative_prompt,
            "creativeLatitude": arguments.creative_latitude,
            "seed": arguments.seed,
            "canvas": {"width": 512, "height": 512, "colorSpace": "srgb"},
            "inputRightsEvidenceHashes": [rights_artifact["artifactHash"]],
        },
    )
    authorization = evaluation_authorization(
        request,
        qualification,
        issued_at,
        expires_at,
        nonce,
    )
    root = prepare_output_root(arguments.output_root)
    retain_binary(root, context, context_artifact)
    retain_binary(root, protected, protected_artifact)
    retain_binary(root, rights, rights_artifact)
    shutil.copyfile(root / context_artifact["locator"], root / "context.png")
    shutil.copyfile(root / protected_artifact["locator"], root / "protected-mask.png")
    write_absent(
        root / "segmentation-prompt.txt",
        segmentation_query.encode("utf-8") + b"\n",
    )
    write_package(
        root,
        {
            "technical-qualification.json": qualification,
            "active-region-materialization.json": materialization,
            "fixture.json": fixture,
            "request.json": request,
            "authorization.json": authorization,
        },
    )
    command = (
        f"set -a; . {shlex.quote(str(Path(__file__).resolve().parents[2] / '.basalt/private/reference-image-evaluation.env'))}; set +a; "
        f"BASALT_QWEN_IMAGE_EDIT_2511_MODAL_IMAGE_ID={qualification['executionBinding']['modalImageId']} "
        "uvx --python 3.10 --from modal modal run --profile mo-awawdi "
        "workers/reference-image/modal_qwen.py "
        f"--request {shlex.quote(str(root / 'request.json'))} --authorization {shlex.quote(str(root / 'authorization.json'))} "
        f"--context {shlex.quote(str(root / 'context.png'))} --protected-mask {shlex.quote(str(root / 'protected-mask.png'))} "
        f"--output-root {shlex.quote(str(root))} --execution-literal RUN_ONE_BASALT_QWEN_IMAGE_EDIT_2511_EVALUATION_SMOKE"
    )
    write_absent(root / "run-command.txt", command.encode("utf-8") + b"\n")
    print(str(root / "run-command.txt"))


def validate_qwen_result(package: Path, result: Path) -> tuple[dict[str, Any], dict[str, Any], bytes]:
    request = decode_json(package / "request.json", "Qwen request", sealed=True)
    authorization = decode_json(package / "authorization.json", "Qwen authorization", sealed=True)
    qualification = decode_json(package / "technical-qualification.json", "Qwen technical qualification", sealed=True)
    receipt = decode_json(result / "worker-receipt.json", "Qwen worker receipt", sealed=True)
    output = read_regular(result / "output.png", MAX_IMAGE_BYTES, "Qwen output")
    png_dimensions(output, "Qwen output")
    require(request.get("producerId") == "qwen_image_edit_2511", "upstream request is not Qwen Edit")
    require(request.get("producerQualificationHash") == qualification.get("hash"), "Qwen request qualification differs")
    require(authorization.get("requestHash") == request.get("hash"), "Qwen authorization differs")
    require(receipt.get("requestHash") == request.get("hash"), "Qwen receipt request differs")
    require(receipt.get("evaluationAuthorizationHash") == authorization.get("hash"), "Qwen receipt authorization differs")
    require(receipt.get("executionBinding") == request.get("executionBinding"), "Qwen receipt runtime differs")
    require(receipt.get("output", {}).get("sha256") == hashlib.sha256(output).hexdigest(), "Qwen output hash differs")
    require(receipt.get("output", {}).get("bytes") == len(output), "Qwen output byte count differs")
    require(receipt.get("inference", {}).get("protectedPixelMismatchCount") == 0, "Qwen changed protected pixels")
    return request, receipt, output


def prepare_sam3(arguments: argparse.Namespace) -> None:
    qualification, issued_at, expires_at, nonce = common_inputs(arguments, SAM3)
    qwen_package = Path(arguments.qwen_package).resolve(strict=True)
    qwen_result = Path(arguments.qwen_result).resolve(strict=True)
    require(qwen_package.is_dir() and qwen_result.is_dir(), "Qwen package/result roots must be directories")
    qwen_request, qwen_receipt, output = validate_qwen_result(qwen_package, qwen_result)
    segmentation_prompt = read_regular(arguments.segmentation_prompt_file, 4096, "segmentation prompt").decode("utf-8").strip()
    require(0 < len(segmentation_prompt) <= 4096, "segmentation prompt is empty or too large")
    input_artifact = artifact(output, "image/png")
    upstream_payload = qwen_request.get("payload")
    require(isinstance(upstream_payload, dict), "Qwen request payload is absent")
    requirements = upstream_payload.get("requirementHashes")
    require(isinstance(requirements, list) and len(requirements) == 1, "Qwen smoke must bind one requirement")
    descriptor = seal(
        {
            "kind": "ReferenceImageEvaluationSegmentationFixture",
            "abi": "basalt-reference-image-evaluation-segmentation-fixture@1",
            "scope": "evaluation_smoke",
            "qwenRequestHash": qwen_request["hash"],
            "qwenWorkerReceiptHash": qwen_receipt["hash"],
            "inputImage": input_artifact,
            "requirementHash": requirements[0],
            "styleContractHash": upstream_payload["styleContractHash"],
            "segmentationPrompt": segmentation_prompt,
        }
    )
    descriptor_bytes = canonical_bytes(descriptor) + b"\n"
    descriptor_artifact_hash = hashlib.sha256(descriptor_bytes).hexdigest()
    attempt_id = content_hash({"fixtureHash": descriptor["hash"], "producerId": SAM3["id"], "nonce": nonce})
    request = worker_request(
        qualification,
        "prompted_segmentation",
        qwen_request["invocationHash"],
        attempt_id,
        {
            "kind": "prompted_segmentation",
            "segmentationRequestHash": descriptor["hash"],
            "segmentationRequestArtifactHash": descriptor_artifact_hash,
            "referenceRequestHash": qwen_request["hash"],
            "requirementHash": requirements[0],
            "styleContractHash": upstream_payload["styleContractHash"],
            "inputImage": input_artifact,
            "width": 512,
            "height": 512,
            "segmentationPrompt": segmentation_prompt,
            "randomness": "disabled",
        },
    )
    authorization = evaluation_authorization(request, qualification, issued_at, expires_at, nonce)
    root = prepare_output_root(arguments.output_root)
    retain_binary(root, output, input_artifact)
    shutil.copyfile(root / input_artifact["locator"], root / "input.png")
    write_package(
        root,
        {
            "technical-qualification.json": qualification,
            "segmentation-fixture.json": descriptor,
            "request.json": request,
            "authorization.json": authorization,
        },
    )
    command = (
        f"set -a; . {shlex.quote(str(Path(__file__).resolve().parents[2] / '.basalt/private/reference-image-evaluation.env'))}; set +a; "
        f"BASALT_SAM3_MODAL_IMAGE_ID={qualification['executionBinding']['modalImageId']} "
        "uvx --python 3.10 --from modal modal run --profile mo-awawdi "
        "workers/reference-image/modal_sam3.py "
        f"--request {shlex.quote(str(root / 'request.json'))} --authorization {shlex.quote(str(root / 'authorization.json'))} "
        f"--input-image {shlex.quote(str(root / 'input.png'))} --output-root {shlex.quote(str(root))} "
        "--execution-literal RUN_ONE_BASALT_SAM3_SEGMENTATION_EVALUATION_SMOKE"
    )
    write_absent(root / "run-command.txt", command.encode("utf-8") + b"\n")
    print(str(root / "run-command.txt"))


def materialize_fixture(arguments: argparse.Namespace) -> None:
    """Create the exact 512px crossing input without contacting a model."""

    try:
        from PIL import Image, ImageDraw
    except ImportError as error:
        raise ValueError("fixture materialization requires local Pillow") from error

    source_bytes = read_regular(arguments.source, MAX_IMAGE_BYTES, "foundation preview")
    source_width, source_height = png_dimensions_any(source_bytes, "foundation preview")
    require((source_width, source_height) == (640, 360), "crossing fixture source must be 640x360")
    source = Image.open(Path(arguments.source)).convert("RGB")
    resized = source.resize((512, 288), Image.Resampling.LANCZOS)
    context = Image.new("RGB", (512, 512), (105, 116, 125))
    context.paste(resized, (0, 112))
    mask = Image.new("L", (512, 512), 0)
    draw = ImageDraw.Draw(mask)
    # Letterbox pixels are outside the source camera image. Preserve them so
    # Qwen cannot hallucinate scene content outside the calibrated viewport.
    draw.rectangle((0, 0, 511, 111), fill=255)
    draw.rectangle((0, 400, 511, 511), fill=255)
    # Exact-pixel compositing is deliberately sparse inside the calibrated
    # viewport. Geometry, routes, and scale are enforced after generation by
    # camera calibration, raycasting, and the placement solver; painting their
    # blockout pixels back over a creative proposal visibly preserves proxy
    # geometry and suppresses useful invention.
    for x, y in ((66, 257), (281, 220), (469, 274), (377, 399), (93, 399), (214, 255), (217, 291)):
        draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=255)
    root = prepare_output_root(arguments.output_root)
    context.save(root / "context.png", format="PNG", optimize=False, compress_level=9)
    mask.save(root / "protected-mask.png", format="PNG", optimize=False, compress_level=9)
    prompt = (
        "Transform the retained crossing topology into a visually exceptional stylized coastal "
        "salvage harbor region: strong cliff and beacon silhouette; layered timber-and-stone "
        "shipyard and market forms; docks, vegetation, props, warm/cool material contrast, "
        "coherent playable negative space, and a clear route. Preserve the camera, land/water "
        "boundary, traversable paths, massing anchors, and every protected geometry pixel. "
        "Add inventive ornament, local forms, atmosphere, and fine detail. No text or UI."
    )
    rights = (
        "Context pixels are a Basalt-generated procedural render. This is an evaluation-only "
        "derivative output with no external reference pixels.\n"
    )
    write_absent(root / "prompt.txt", prompt.encode("utf-8") + b"\n")
    write_absent(root / "rights.txt", rights.encode("utf-8"))
    fixture_material = {
        "kind": "ReferenceImageEvaluationFixtureMaterialization",
        "abi": "basalt-reference-image-evaluation-fixture-materialization@1",
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "sourceDimensions": {"width": source_width, "height": source_height},
        "outputDimensions": {"width": 512, "height": 512},
        "resize": "lanczos_512x288_centered",
        "letterboxRgb": [105, 116, 125],
        "protectedGeometry": ["viewport_letterbox", "sparse_surface_anchors"],
        "modelWillRun": False,
    }
    write_package(root, {"materialization.json": seal(fixture_material)})
    print(str(root))


def png_dimensions_any(payload: bytes, label: str) -> tuple[int, int]:
    require(payload.startswith(b"\x89PNG\r\n\x1a\n"), f"{label} is not a PNG")
    require(len(payload) >= 33 and payload[12:16] == b"IHDR", f"{label} lacks a PNG IHDR")
    return struct.unpack(">II", payload[16:24])


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--runtime-probe", required=True)
    parser.add_argument("--source-provisioning-receipt", required=True)
    parser.add_argument("--model-provisioning-receipt", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--issued-at", default="")
    parser.add_argument("--expires-at", default="")
    parser.add_argument("--nonce", default="")


def main() -> int:
    parser = argparse.ArgumentParser()
    routes = parser.add_subparsers(dest="route", required=True)
    fixture = routes.add_parser("materialize-fixture")
    fixture.add_argument("--source", required=True)
    fixture.add_argument("--output-root", required=True)
    qwen = routes.add_parser("qwen")
    add_common(qwen)
    qwen.add_argument("--context", required=True)
    qwen.add_argument("--protected-mask", required=True)
    qwen.add_argument("--prompt-file", required=True)
    qwen.add_argument("--rights-statement", required=True)
    qwen.add_argument("--region-id", default="EvaluationRegion")
    qwen.add_argument("--negative-prompt", default="camera drift, terrain changes, blocked routes, illegible objects")
    qwen.add_argument("--seed", type=int, default=17)
    active_qwen = routes.add_parser("active-region-qwen")
    add_common(active_qwen)
    active_qwen.add_argument("--foundation-root", required=True)
    active_qwen.add_argument("--prompt-file", required=True)
    active_qwen.add_argument("--rights-statement", required=True)
    active_qwen.add_argument("--segmentation-query", required=True)
    active_qwen.add_argument(
        "--negative-prompt",
        default="camera drift, terrain changes, blocked routes, illegible objects",
    )
    active_qwen.add_argument("--creative-latitude", type=float, default=1)
    active_qwen.add_argument("--composition-index", type=int, default=0)
    active_qwen.add_argument("--seed", type=int, default=17)
    sam3 = routes.add_parser("sam3")
    add_common(sam3)
    sam3.add_argument("--qwen-package", required=True)
    sam3.add_argument("--qwen-result", required=True)
    sam3.add_argument("--segmentation-prompt-file", required=True)
    arguments = parser.parse_args()
    issued_at = getattr(arguments, "issued_at", "")
    expires_at = getattr(arguments, "expires_at", "")
    require(not issued_at or parse_timestamp(issued_at), "issued timestamp is invalid")
    require(not expires_at or parse_timestamp(expires_at), "expiry timestamp is invalid")
    if arguments.route == "materialize-fixture":
        materialize_fixture(arguments)
    elif arguments.route == "qwen":
        require(0 <= arguments.seed <= 2_147_483_647, "seed is outside the worker contract")
        prepare_qwen(arguments)
    elif arguments.route == "active-region-qwen":
        require(0 <= arguments.seed <= 2_147_483_647, "seed is outside the worker contract")
        require(
            0 <= arguments.composition_index <= 255,
            "composition index is outside the worker contract",
        )
        require(
            0 <= arguments.creative_latitude <= 1,
            "creative latitude is outside the worker contract",
        )
        prepare_active_region_qwen(arguments)
    else:
        prepare_sam3(arguments)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"Reference-image smoke preparation rejected: {error}", file=os.sys.stderr)
        raise SystemExit(2) from error
