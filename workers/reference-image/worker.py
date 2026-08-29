#!/usr/bin/env python3
"""Protocol and sealed offline inference worker for Basalt image production.

Ordinary local modes import only the Python standard library. The evaluation
mode is executable only inside an immutable, network-denied Modal runtime and
currently implements Qwen Image Edit 2511 composition and SAM 3 segmentation.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import re
import stat
import sys
import time
from pathlib import Path
from typing import Any


WORKER_ID = "basalt-reference-image-protocol-worker"
WORKER_REVISION = "2026-09-10.4"
REQUEST_ABI = "basalt-reference-image-worker-request@5"
RECEIPT_ABI = "basalt-reference-image-worker-receipt@5"
AUTHORIZATION_ABI = "basalt-reference-image-evaluation-smoke-authorization@1"
EVALUATION_SCOPE = "evaluation_smoke"
OUTPUT_VOLUME_NAME = "basalt-neural-output"
QWEN_SOURCE_COMMIT = "6b5e1f5cec987d404be5ac6657db3b9aacb56a89"
FLUX2_SOURCE_COMMIT = "50fe5162777813d869182b139e83b10743caef15"
LONGCAT_SOURCE_COMMIT = "f0e4c43c5ef74b011ff71570fbfc2bdffbc9ab06"
SAM3_SOURCE_COMMIT = "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7"
QWEN_IMAGE_2512_REVISION = "25468b98e3276ca6700de15c6628e51b7de54a26"
QWEN_IMAGE_EDIT_2511_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
FLUX2_KLEIN_4B_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294"
LONGCAT_IMAGE_EDIT_REVISION = "7b54ef423aa7854be7861600024be5c56ab7875a"
SAM3_MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
SAM3_SCORE_THRESHOLD = 0.05
# A composed region can produce many overlapping high-scoring hypotheses for
# one text prompt. Unioning them creates a scene matte instead of an object
# mask. Keep the best hypothesis per window; overlapping windows still recover
# visible portions of a partially occluded object.
SAM3_MAX_SELECTED_INSTANCES_PER_WINDOW = 1
# A full-frame mask that touches the image edge is almost always a background
# or scene matte rather than the requested object. Tiled passes are only a
# recovery path for genuinely occluded objects; they must never turn a
# scene-sized detection into the reference alpha.
SAM3_MAX_FULL_FRAME_AREA_FRACTION = 0.72
SAM3_MAX_BORDER_AREA_FRACTION = 0.18
RUNTIME_POLICY_HASH = "badc561f01576f4b429d1922c9a4057393c2b61c69b490a00b387bfe47914081"
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 256 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MODAL_IMAGE_ID = re.compile(r"^im-[A-Za-z0-9]+$")

PRODUCERS = {
    "qwen_image_2512": {
        "route": "isolated_reference",
        "producerId": "qwen_image_2512",
        "sourceCommit": QWEN_SOURCE_COMMIT,
        "modelId": "Qwen/Qwen-Image-2512",
        "modelRevision": QWEN_IMAGE_2512_REVISION,
        "outputRole": "original_image",
        "outputChannels": 3,
        "outputColorSpace": "srgb",
    },
    "qwen_image_edit_2511": {
        "route": "region_composition",
        "producerId": "qwen_image_edit_2511",
        "sourceCommit": QWEN_SOURCE_COMMIT,
        "modelId": "Qwen/Qwen-Image-Edit-2511",
        "modelRevision": QWEN_IMAGE_EDIT_2511_REVISION,
        "outputRole": "composition_image",
        "outputChannels": 3,
        "outputColorSpace": "srgb",
    },
    "flux2_klein_4b": {
        "route": "region_composition",
        "producerId": "flux2_klein_4b",
        "sourceCommit": FLUX2_SOURCE_COMMIT,
        "modelId": "black-forest-labs/FLUX.2-klein-4B",
        "modelRevision": FLUX2_KLEIN_4B_REVISION,
        "outputRole": "composition_image",
        "outputChannels": 3,
        "outputColorSpace": "srgb",
    },
    "longcat_image_edit": {
        "route": "region_composition",
        "producerId": "longcat_image_edit",
        "sourceCommit": LONGCAT_SOURCE_COMMIT,
        "modelId": "meituan-longcat/LongCat-Image-Edit",
        "modelRevision": LONGCAT_IMAGE_EDIT_REVISION,
        "outputRole": "composition_image",
        "outputChannels": 3,
        "outputColorSpace": "srgb",
    },
    "sam3": {
        "route": "prompted_segmentation",
        "producerId": "sam3",
        "sourceCommit": SAM3_SOURCE_COMMIT,
        "modelId": "facebook/sam3",
        "modelRevision": SAM3_MODEL_REVISION,
        "outputRole": "alpha_mask",
        "outputChannels": 1,
        "outputColorSpace": "linear",
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


def require_hash(value: Any, label: str) -> str:
    require(isinstance(value, str) and SHA256.fullmatch(value) is not None, f"{label} is invalid")
    return value


def read_regular_file(path_value: str, maximum_bytes: int, label: str) -> bytes:
    path = Path(path_value)
    require(path.is_absolute(), f"{label} path must be absolute")
    absolute = path.absolute()
    resolved = path.resolve(strict=True)
    # Modal exposes an immutable Volume through a trusted mount indirection, so
    # resolving a file below that mount does not preserve its lexical path.
    # Caller-controlled files remain exact-path only.  For Volume files, keep
    # the declared mount path bounded and still reject a symlink at the leaf.
    if resolved != absolute:
        volume_root = Path("/mnt/basalt-neural-input")
        require(absolute.is_relative_to(volume_root), f"{label} path must be canonical")
    metadata = os.lstat(absolute)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(0 < metadata.st_size <= maximum_bytes, f"{label} exceeds its byte bound")
    return absolute.read_bytes()


def read_canonical_json(path_value: str, label: str) -> dict[str, Any]:
    raw = read_regular_file(path_value, MAX_JSON_BYTES, label)
    value = json.loads(raw.decode("utf-8"))
    require(isinstance(value, dict), f"{label} must be a JSON object")
    require(raw.rstrip(b"\n") == canonical_bytes(value), f"{label} must be canonical JSON")
    return value


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    require(isinstance(value, dict) and set(value) == keys, f"{label} shape differs")
    return value


def validate_artifact(value: Any, media_type: str, label: str) -> dict[str, Any]:
    artifact = exact_keys(value, {"locator", "artifactHash", "bytes", "mediaType"}, label)
    require(artifact["mediaType"] == media_type, f"{label} media type differs")
    artifact_hash = require_hash(artifact["artifactHash"], f"{label} hash")
    require(artifact["locator"] == f"binary-artifacts/{artifact_hash}.bin", f"{label} locator differs")
    require(
        isinstance(artifact["bytes"], int) and 0 < artifact["bytes"] <= MAX_IMAGE_BYTES,
        f"{label} byte bound failed",
    )
    return artifact


def validate_execution_binding(value: Any) -> dict[str, Any]:
    keys = {
        "modalImageId",
        "runtimeImageHash",
        "workerSourceHash",
        "modelVolumeSnapshotHash",
        "dependencyInventoryHash",
        "dependencyInventoryArtifactHash",
        "sbomArtifactHash",
        "importTraceArtifactHash",
        "modelInventoryArtifactHash",
        "runtimePolicyHash",
    }
    binding = exact_keys(value, keys, "execution binding")
    require(
        isinstance(binding["modalImageId"], str)
        and MODAL_IMAGE_ID.fullmatch(binding["modalImageId"]) is not None,
        "execution binding Modal image ID is invalid",
    )
    for key in keys - {"modalImageId"}:
        require_hash(binding[key], f"execution binding {key}")
    require(binding["runtimePolicyHash"] == RUNTIME_POLICY_HASH, "runtime policy hash differs")
    require(
        binding["dependencyInventoryHash"] == binding["dependencyInventoryArtifactHash"],
        "dependency inventory does not identify its retained bytes",
    )
    return binding


def validate_request(value: Any) -> dict[str, Any]:
    keys = {
        "kind",
        "abi",
        "route",
        "executionClass",
        "executionScope",
        "producerId",
        "sourceCommit",
        "modelId",
        "modelRevision",
        "producerQualificationHash",
        "invocationHash",
        "attemptId",
        "executionBinding",
        "payload",
        "hash",
    }
    request = exact_keys(value, keys, "worker request")
    require(request["kind"] == "ReferenceImageWorkerRequest", "worker request kind differs")
    require(request["abi"] == REQUEST_ABI, "worker request ABI differs")
    require(request["executionClass"] == "remote_neural_image", "execution class differs")
    require(
        request["executionScope"] in {"evaluation_smoke", "product"},
        "worker execution scope differs",
    )
    route = request.get("route")
    producer_id = request.get("producerId")
    require(producer_id in PRODUCERS, "worker producer is unsupported")
    route_contract = PRODUCERS[producer_id]
    require(route == route_contract["route"], "worker route does not match its producer")
    for key in ("producerId", "sourceCommit", "modelId", "modelRevision"):
        require(request[key] == route_contract[key], f"worker request {key} differs")
    for key in ("producerQualificationHash", "invocationHash", "attemptId"):
        require_hash(request[key], f"worker request {key}")
    validate_execution_binding(request["executionBinding"])
    payload = validate_payload(request["payload"], route)
    require(payload["kind"] == route, "worker payload route differs")
    request_hash = require_hash(request["hash"], "worker request hash")
    require(
        content_hash({key: entry for key, entry in request.items() if key != "hash"}) == request_hash,
        "worker request identity is invalid",
    )
    return request


def validate_evaluation_authorization(
    value: Any,
    request: dict[str, Any],
    *,
    now_epoch_seconds: float | None = None,
    enforce_expiry: bool = True,
) -> dict[str, Any]:
    keys = {
        "kind",
        "abi",
        "executionScope",
        "requestHash",
        "producerQualificationHash",
        "producerId",
        "route",
        "attemptId",
        "oneShot",
        "outputVolume",
        "maximumOutputPixels",
        "maximumGpuSeconds",
        "maximumEstimatedCostUsd",
        "issuerIdentityHash",
        "nonce",
        "issuedAt",
        "expiresAt",
        "hash",
    }
    authorization = exact_keys(value, keys, "evaluation-smoke authorization")
    require(
        authorization["kind"] == "ReferenceImageEvaluationSmokeAuthorization"
        and authorization["abi"] == AUTHORIZATION_ABI
        and authorization["executionScope"] == EVALUATION_SCOPE,
        "evaluation-smoke authorization identity differs",
    )
    require(request["executionScope"] == EVALUATION_SCOPE, "request is not an evaluation smoke")
    for key in ("issuerIdentityHash", "nonce"):
        require_hash(authorization[key], f"evaluation-smoke {key}")
    bindings = {
        "requestHash": request["hash"],
        "producerQualificationHash": request["producerQualificationHash"],
        "executionScope": request["executionScope"],
        "producerId": request["producerId"],
        "route": request["route"],
        "attemptId": request["attemptId"],
    }
    for key, expected in bindings.items():
        require(authorization[key] == expected, f"evaluation-smoke {key} differs")
    require(authorization["oneShot"] is True, "evaluation smoke must be one shot")
    require(
        authorization["outputVolume"] == OUTPUT_VOLUME_NAME,
        "evaluation-smoke output Volume differs",
    )
    require(
        isinstance(authorization["maximumOutputPixels"], int)
        and 256 * 256 <= authorization["maximumOutputPixels"] <= 2048 * 2048,
        "evaluation-smoke pixel bound is invalid",
    )
    require(
        isinstance(authorization["maximumGpuSeconds"], int)
        and 1 <= authorization["maximumGpuSeconds"] <= 900,
        "evaluation-smoke GPU bound is invalid",
    )
    require(
        isinstance(authorization["maximumEstimatedCostUsd"], (int, float))
        and not isinstance(authorization["maximumEstimatedCostUsd"], bool)
        and 0 < authorization["maximumEstimatedCostUsd"] <= 2,
        "evaluation-smoke cost bound is invalid",
    )
    from datetime import datetime

    try:
        issued = datetime.fromisoformat(authorization["issuedAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(authorization["expiresAt"].replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise ValueError("evaluation-smoke timestamp is invalid") from error
    require(issued.tzinfo is not None and expires.tzinfo is not None, "authorization timezone is absent")
    require(expires > issued, "evaluation-smoke expiry is invalid")
    observed_epoch = time.time() if now_epoch_seconds is None else now_epoch_seconds
    if enforce_expiry:
        require(observed_epoch <= expires.timestamp(), "evaluation-smoke authorization expired")
    payload = request["payload"]
    pixels = (
        payload["width"] * payload["height"]
        if request["route"] == "prompted_segmentation"
        else payload["canvas"]["width"] * payload["canvas"]["height"]
    )
    require(pixels <= authorization["maximumOutputPixels"], "evaluation-smoke pixel bound exceeded")
    authorization_hash = require_hash(authorization["hash"], "evaluation-smoke hash")
    require(
        content_hash({key: entry for key, entry in authorization.items() if key != "hash"})
        == authorization_hash,
        "evaluation-smoke authorization identity is invalid",
    )
    return authorization


def load_runtime_manifest(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest_path = os.environ.get("BASALT_REFERENCE_IMAGE_RUNTIME_MANIFEST", "")
    require(manifest_path.startswith("/opt/basalt/"), "runtime manifest path is absent")
    manifest = read_canonical_json(manifest_path, "runtime manifest")
    manifest_hash = require_hash(manifest.get("hash"), "runtime manifest hash")
    require(
        content_hash({key: value for key, value in manifest.items() if key != "hash"})
        == manifest_hash,
        "runtime manifest identity differs",
    )
    binding = request["executionBinding"]
    modal_image_id = os.environ.get("MODAL_IMAGE_ID", "")
    require(
        MODAL_IMAGE_ID.fullmatch(modal_image_id) is not None
        and binding["modalImageId"] == modal_image_id,
        "request Modal image differs",
    )
    require(binding["runtimeImageHash"] == manifest_hash, "request runtime image differs")
    worker_hash = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
    require(binding["workerSourceHash"] == worker_hash, "request worker source differs")
    require(manifest.get("workerSha256") == worker_hash, "runtime worker source differs")
    evidence = exact_keys(
        manifest.get("evidence"),
        {
            "dependencyInventoryHash",
            "dependencyInventoryArtifactHash",
            "sbomArtifactHash",
            "importTraceArtifactHash",
        },
        "runtime evidence",
    )
    for key, value in evidence.items():
        require_hash(value, f"runtime evidence {key}")
        require(binding[key] == value, f"request {key} differs from runtime evidence")
    producer = request["producerId"]
    roots = runtime_roots(producer)
    source_seal = read_canonical_json(
        str(Path(roots["sourceRoot"]) / "snapshot/.basalt-evidence/snapshot-seal.json"),
        "source snapshot seal",
    )
    model_seal = read_canonical_json(
        str(Path(roots["modelRoot"]) / "snapshot/.basalt-evidence/snapshot-seal.json"),
        "model snapshot seal",
    )
    for seal, label in ((source_seal, "source"), (model_seal, "model")):
        seal_hash = require_hash(seal.get("hash"), f"{label} snapshot seal hash")
        require(
            content_hash({key: value for key, value in seal.items() if key != "hash"}) == seal_hash,
            f"{label} snapshot seal identity differs",
        )
    require(
        model_seal["hash"] == binding["modelVolumeSnapshotHash"],
        "request model snapshot seal differs",
    )
    require(
        model_seal.get("fileInventoryHash") == binding["modelInventoryArtifactHash"],
        "request model inventory differs",
    )
    expected = PRODUCERS[producer]
    require(
        source_seal.get("artifact", {}).get("revision") == expected["sourceCommit"],
        "source snapshot revision differs",
    )
    require(
        model_seal.get("artifact", {}).get("revision") == expected["modelRevision"],
        "model snapshot revision differs",
    )
    return manifest, source_seal, model_seal


def runtime_roots(producer_id: str) -> dict[str, str]:
    model_root = {
        "qwen_image_2512": "/mnt/basalt-neural-input/qwen-image-2512-model",
        "qwen_image_edit_2511": "/mnt/basalt-neural-input/qwen-image-edit-2511-model",
        "flux2_klein_4b": "/mnt/basalt-neural-input/flux2-klein-4b-model",
        "longcat_image_edit": "/mnt/basalt-neural-input/longcat-image-edit-model",
        "sam3": "/mnt/basalt-neural-input/sam3-model",
    }[producer_id]
    source_root = {
        "flux2_klein_4b": "/mnt/basalt-neural-input/flux2-source",
        "longcat_image_edit": "/mnt/basalt-neural-input/longcat-image-source",
        "sam3": "/mnt/basalt-neural-input/sam3-source",
    }.get(producer_id, "/mnt/basalt-neural-input/qwen-image-source")
    return {"modelRoot": model_root, "sourceRoot": source_root}


def validate_canvas(value: Any) -> dict[str, Any]:
    canvas = exact_keys(value, {"width", "height", "colorSpace"}, "canvas")
    require(canvas["colorSpace"] == "srgb", "canvas color space differs")
    for key in ("width", "height"):
        require(
            isinstance(canvas[key], int)
            and 256 <= canvas[key] <= 2048
            and canvas[key] % 64 == 0,
            f"canvas {key} is invalid",
        )
    return canvas


def validate_rights_hashes(value: Any) -> None:
    require(isinstance(value, list) and 1 <= len(value) <= 64, "rights evidence is absent")
    for index, entry in enumerate(value):
        require_hash(entry, f"rights evidence {index}")


def validate_creative_payload(payload: dict[str, Any]) -> None:
    require(isinstance(payload["prompt"], str) and payload["prompt"].strip(), "prompt is absent")
    require(isinstance(payload["negativePrompt"], str), "negative prompt is invalid")
    require(
        isinstance(payload["creativeLatitude"], (int, float))
        and not isinstance(payload["creativeLatitude"], bool)
        and 0 <= payload["creativeLatitude"] <= 1,
        "creative latitude is invalid",
    )
    require(isinstance(payload["seed"], int) and 0 <= payload["seed"] <= 2_147_483_647, "seed is invalid")
    validate_canvas(payload["canvas"])
    validate_rights_hashes(payload["inputRightsEvidenceHashes"])


def validate_payload(value: Any, route: str) -> dict[str, Any]:
    if route == "isolated_reference":
        keys = {
            "kind",
            "referenceRequestHash",
            "referenceRequestArtifactHash",
            "requirementHash",
            "styleContractHash",
            "prompt",
            "negativePrompt",
            "creativeLatitude",
            "seed",
            "canvas",
            "subjectPolicy",
            "inputRightsEvidenceHashes",
        }
        payload = exact_keys(value, keys, "isolated-reference payload")
        for key in ("referenceRequestHash", "referenceRequestArtifactHash", "requirementHash", "styleContractHash"):
            require_hash(payload[key], f"isolated-reference {key}")
        require(payload["subjectPolicy"] == "isolated_subject_clear_silhouette", "subject policy differs")
        validate_creative_payload(payload)
        return payload
    if route == "region_composition":
        keys = {
            "kind",
            "regionalPlanHash",
            "regionFoundationHash",
            "regionId",
            "contextRender",
            "cameraCalibrationHash",
            "protectedPixelMask",
            "requirementHashes",
            "styleContractHash",
            "compositionIndex",
            "prompt",
            "negativePrompt",
            "creativeLatitude",
            "seed",
            "canvas",
            "inputRightsEvidenceHashes",
        }
        payload = exact_keys(value, keys, "region-composition payload")
        for key in (
            "regionalPlanHash",
            "regionFoundationHash",
            "cameraCalibrationHash",
            "styleContractHash",
        ):
            require_hash(payload[key], f"region-composition {key}")
        requirement_hashes = payload["requirementHashes"]
        require(
            isinstance(requirement_hashes, list)
            and 1 <= len(requirement_hashes) <= 256
            and requirement_hashes == sorted(requirement_hashes)
            and len(set(requirement_hashes)) == len(requirement_hashes),
            "region-composition requirement hashes must be unique and canonical",
        )
        for index, requirement_hash in enumerate(requirement_hashes):
            require_hash(requirement_hash, f"region-composition requirement hash {index}")
        require(isinstance(payload["regionId"], str) and payload["regionId"], "region ID is absent")
        require(isinstance(payload["compositionIndex"], int) and 0 <= payload["compositionIndex"] <= 255, "composition index is invalid")
        validate_artifact(payload["contextRender"], "image/png", "context render")
        validate_artifact(payload["protectedPixelMask"], "image/png", "protected-pixel mask")
        validate_creative_payload(payload)
        return payload
    keys = {
        "kind",
        "segmentationRequestHash",
        "segmentationRequestArtifactHash",
        "referenceRequestHash",
        "requirementHash",
        "styleContractHash",
        "inputImage",
        "width",
        "height",
        "segmentationPrompt",
        "randomness",
    }
    payload = exact_keys(value, keys, "segmentation payload")
    for key in (
        "segmentationRequestHash",
        "segmentationRequestArtifactHash",
        "referenceRequestHash",
        "requirementHash",
        "styleContractHash",
    ):
        require_hash(payload[key], f"segmentation {key}")
    validate_artifact(payload["inputImage"], "image/png", "segmentation input")
    for key in ("width", "height"):
        require(isinstance(payload[key], int) and 256 <= payload[key] <= 2048, f"segmentation {key} is invalid")
    require(isinstance(payload["segmentationPrompt"], str) and payload["segmentationPrompt"].strip(), "segmentation prompt is absent")
    require(payload["randomness"] == "disabled", "segmentation randomness must be disabled")
    return payload


def validate_receipt(
    value: Any,
    request: dict[str, Any],
    output_bytes: bytes,
    authorization: dict[str, Any] | None = None,
) -> dict[str, Any]:
    keys = {
        "kind",
        "abi",
        "status",
        "route",
        "executionScope",
        "evaluationAuthorizationHash",
        "requestHash",
        "producerQualificationHash",
        "invocationHash",
        "attemptId",
        "executionBinding",
        "output",
        "inference",
        "runtime",
        "hash",
    }
    receipt = exact_keys(value, keys, "worker receipt")
    require(receipt["kind"] == "ReferenceImageWorkerReceipt", "worker receipt kind differs")
    require(receipt["abi"] == RECEIPT_ABI, "worker receipt ABI differs")
    expected_status = "evaluation_complete" if request["executionScope"] == EVALUATION_SCOPE else "eligible"
    require(receipt["status"] == expected_status, "worker receipt status differs")
    require(receipt["executionScope"] == request["executionScope"], "worker receipt scope differs")
    if request["executionScope"] == EVALUATION_SCOPE:
        require(authorization is not None, "evaluation authorization is absent")
        validate_evaluation_authorization(authorization, request, enforce_expiry=False)
        require(
            receipt["evaluationAuthorizationHash"] == authorization["hash"],
            "worker receipt authorization differs",
        )
    else:
        require(
            receipt["evaluationAuthorizationHash"] is None,
            "product receipt retained an evaluation authorization",
        )
    for key in ("route", "requestHash", "producerQualificationHash", "invocationHash", "attemptId"):
        request_key = "hash" if key == "requestHash" else key
        require(receipt[key] == request[request_key], f"worker receipt {key} differs")
    require(receipt["executionBinding"] == request["executionBinding"], "worker execution binding differs")
    binding = validate_execution_binding(receipt["executionBinding"])
    output = exact_keys(
        receipt["output"],
        {"role", "mediaType", "sha256", "bytes", "width", "height", "channels", "colorSpace"},
        "worker output",
    )
    route_contract = PRODUCERS[request["producerId"]]
    require(output["role"] == route_contract["outputRole"], "worker output role differs")
    require(output["mediaType"] == "image/png", "worker output media type differs")
    require(output["channels"] == route_contract["outputChannels"], "worker output channels differ")
    require(output["colorSpace"] == route_contract["outputColorSpace"], "worker output color space differs")
    require(output["bytes"] == len(output_bytes), "worker output byte count differs")
    require(output["sha256"] == hashlib.sha256(output_bytes).hexdigest(), "worker output bytes differ")
    payload = request["payload"]
    expected_width = payload["width"] if request["route"] == "prompted_segmentation" else payload["canvas"]["width"]
    expected_height = payload["height"] if request["route"] == "prompted_segmentation" else payload["canvas"]["height"]
    require(output["width"] == expected_width and output["height"] == expected_height, "worker output dimensions differ")
    inference = exact_keys(
        receipt["inference"],
        {
            "seed",
            "steps",
            "scoreThreshold",
            "instanceCount",
            "modelOutputSha256",
            "postprocess",
            "protectedPixelCount",
            "protectedPixelMismatchCount",
            "elapsedMilliseconds",
            "gpuSeconds",
        },
        "worker inference",
    )
    require_hash(inference["modelOutputSha256"], "model output hash")
    require(
        isinstance(inference["elapsedMilliseconds"], int)
        and inference["elapsedMilliseconds"] >= 0
        and isinstance(inference["gpuSeconds"], (int, float))
        and not isinstance(inference["gpuSeconds"], bool)
        and inference["gpuSeconds"] >= 0,
        "worker timing evidence is invalid",
    )
    if request["route"] == "region_composition":
        require(
            inference["seed"] == payload["seed"]
            and inference["steps"] == 40
            and inference["scoreThreshold"] is None
            and inference["instanceCount"] == 0
            and inference["postprocess"] == "protected_pixel_composite"
            and isinstance(inference["protectedPixelCount"], int)
            and inference["protectedPixelCount"] >= 0
            and inference["protectedPixelMismatchCount"] == 0,
            "composition inference evidence differs",
        )
    elif request["route"] == "prompted_segmentation":
        require(
            inference["seed"] is None
            and inference["steps"] == 0
            and inference["scoreThreshold"] == SAM3_SCORE_THRESHOLD
            and isinstance(inference["instanceCount"], int)
            and 0 <= inference["instanceCount"] <= 4096
            and inference["postprocess"] == "best_instance_mask"
            and inference["protectedPixelCount"] == 0
            and inference["protectedPixelMismatchCount"] == 0,
            "segmentation inference evidence differs",
        )
    runtime = exact_keys(
        receipt["runtime"],
        {
            "runtimeEgress",
            "networkAttempted",
            "runtimeDownloads",
            "trustRemoteCode",
            "modelRoot",
            "sourceRoot",
            "runtimeManifestHash",
            "modelSnapshotSealHash",
            "sourceSnapshotSealHash",
        },
        "worker runtime",
    )
    require(
        runtime["runtimeEgress"] == "denied"
        and runtime["networkAttempted"] is False
        and runtime["runtimeDownloads"] is False
        and runtime["trustRemoteCode"] is False,
        "worker isolation evidence differs",
    )
    expected_roots = runtime_roots(request["producerId"])
    require(runtime["modelRoot"] == expected_roots["modelRoot"], "worker model root differs")
    require(runtime["sourceRoot"] == expected_roots["sourceRoot"], "worker source root differs")
    require(runtime["runtimeManifestHash"] == binding["runtimeImageHash"], "runtime manifest differs")
    require(
        runtime["modelSnapshotSealHash"] == binding["modelVolumeSnapshotHash"],
        "runtime model snapshot differs",
    )
    require_hash(runtime["sourceSnapshotSealHash"], "source snapshot seal hash")
    require_hash(binding["sbomArtifactHash"], "SBOM artifact hash")
    require_hash(binding["importTraceArtifactHash"], "import trace artifact hash")
    receipt_hash = require_hash(receipt["hash"], "worker receipt hash")
    require(
        content_hash({key: entry for key, entry in receipt.items() if key != "hash"}) == receipt_hash,
        "worker receipt identity is invalid",
    )
    return receipt


def decode_png(payload: bytes, label: str, expected_size: tuple[int, int]):
    from PIL import Image

    with Image.open(io.BytesIO(payload)) as decoded:
        require(decoded.format == "PNG", f"{label} is not a PNG")
        require(decoded.size == expected_size, f"{label} dimensions differ")
        decoded.load()
        return decoded.copy()


def encode_png(image: Any) -> bytes:
    destination = io.BytesIO()
    image.save(destination, format="PNG", optimize=False, compress_level=9)
    payload = destination.getvalue()
    require(0 < len(payload) <= MAX_IMAGE_BYTES, "encoded PNG exceeds its byte bound")
    return payload


def execute_qwen_composition(
    request: dict[str, Any],
    input_image_bytes: bytes,
    protected_mask_bytes: bytes,
) -> tuple[bytes, bytes, dict[str, Any]]:
    require(request["producerId"] == "qwen_image_edit_2511", "Qwen worker producer differs")
    payload = request["payload"]
    size = (payload["canvas"]["width"], payload["canvas"]["height"])
    context = decode_png(input_image_bytes, "context render", size).convert("RGB")
    protected = decode_png(protected_mask_bytes, "protected-pixel mask", size).convert("L")
    import numpy as np
    import torch
    from diffusers import QwenImageEditPlusPipeline
    from PIL import Image

    require(torch.cuda.is_available() and torch.cuda.device_count() == 1, "one CUDA GPU is required")
    model_root = Path(runtime_roots(request["producerId"])["modelRoot"]) / "snapshot"
    pipeline = QwenImageEditPlusPipeline.from_pretrained(
        str(model_root),
        local_files_only=True,
        trust_remote_code=False,
        torch_dtype=torch.bfloat16,
    )
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    generator = torch.Generator(device="cuda").manual_seed(payload["seed"])
    started = time.monotonic()
    with torch.inference_mode():
        raw = pipeline(
            image=[context],
            prompt=payload["prompt"],
            negative_prompt=payload["negativePrompt"] or " ",
            width=size[0],
            height=size[1],
            generator=generator,
            true_cfg_scale=4.0,
            guidance_scale=1.0,
            num_inference_steps=40,
            num_images_per_prompt=1,
        ).images[0]
    elapsed = time.monotonic() - started
    raw = raw.convert("RGB")
    require(raw.size == size, "Qwen output dimensions differ")
    raw_bytes = encode_png(raw)
    protected_array = np.asarray(protected, dtype=np.uint8) >= 128
    binary_mask = Image.fromarray((protected_array * 255).astype(np.uint8), mode="L")
    final = Image.composite(context, raw, binary_mask)
    context_array = np.asarray(context, dtype=np.uint8)
    final_array = np.asarray(final, dtype=np.uint8)
    mismatches = int(np.count_nonzero(np.any(context_array != final_array, axis=2) & protected_array))
    require(mismatches == 0, "protected-pixel composite changed protected source pixels")
    final_bytes = encode_png(final)
    evidence = {
        "seed": payload["seed"],
        "steps": 40,
        "scoreThreshold": None,
        "instanceCount": 0,
        "modelOutputSha256": hashlib.sha256(raw_bytes).hexdigest(),
        "postprocess": "protected_pixel_composite",
        "protectedPixelCount": int(np.count_nonzero(protected_array)),
        "protectedPixelMismatchCount": mismatches,
        "elapsedMilliseconds": round(elapsed * 1000),
        "gpuSeconds": round(elapsed, 6),
    }
    del pipeline
    torch.cuda.empty_cache()
    return final_bytes, raw_bytes, evidence


def execute_sam3_segmentation(
    request: dict[str, Any],
    input_image_bytes: bytes,
) -> tuple[bytes, bytes, dict[str, Any]]:
    require(request["producerId"] == "sam3", "SAM 3 worker producer differs")
    payload = request["payload"]
    size = (payload["width"], payload["height"])
    input_image = decode_png(input_image_bytes, "segmentation input", size).convert("RGB")
    import numpy as np
    import torch
    from PIL import Image
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model_builder import build_sam3_image_model

    require(torch.cuda.is_available() and torch.cuda.device_count() == 1, "one CUDA GPU is required")
    model_root = Path(runtime_roots(request["producerId"])["modelRoot"]) / "snapshot"
    checkpoint = model_root / "sam3.pt"
    require(checkpoint.is_file(), "sealed SAM 3 checkpoint is absent")
    # Pass the tokenizer asset explicitly.  The official builder falls back to
    # pkg_resources when this is omitted, but sealed Modal installs can load the
    # package without exposing its data files through that legacy lookup.  A
    # missing/incorrect BPE path does not necessarily raise; it can leave the
    # text encoder producing zero detections, so make the asset binding
    # explicit and fail closed.
    bpe_path = Path(__import__("sam3").__file__).resolve().parent / "assets" / "bpe_simple_vocab_16e6.txt.gz"
    require(bpe_path.is_file(), "sealed SAM 3 BPE tokenizer is absent")
    model = build_sam3_image_model(
        bpe_path=str(bpe_path),
        checkpoint_path=str(checkpoint),
        load_from_HF=False,
        device="cuda",
        eval_mode=True,
        enable_segmentation=True,
        enable_inst_interactivity=False,
        compile=False,
    )
    # Keep the processor's internal filter open so the worker's explicit,
    # receipt-bound threshold below is the sole admission authority.
    processor = Sam3Processor(model, confidence_threshold=0.0)
    # SAM 3 can miss a small or partially occluded object when it only sees the
    # full region. Run one full-image pass plus deterministic overlapping crops;
    # every crop is mapped back into the same source pixel coordinates before
    # the union is admitted. This is the WorldClaw-style windowed evidence path,
    # not a second model or an informal post-process.
    width, height = size
    window_specs = [(0, 0, width, height)]
    if width > 8 and height > 8:
        window_width = max(8, int(round(width * 0.75)))
        window_height = max(8, int(round(height * 0.75)))
        x_starts = sorted({0, max(0, width - window_width)})
        y_starts = sorted({0, max(0, height - window_height)})
        window_specs.extend(
            (x, y, min(width, x + window_width), min(height, y + window_height))
            for y in y_starts
            for x in x_starts
        )

    started = time.monotonic()
    union = torch.zeros((height, width), dtype=torch.bool, device="cpu")
    canonical_full_frame: torch.Tensor | None = None
    raw_identity = hashlib.sha256()
    instance_count = 0
    # SAM 3's released CUDA path expects its mixed-precision feature tensors;
    # running the whole vision trunk in native fp32 produces an internal
    # BFloat16/Float matmul mismatch on the official checkpoint.  Keep the
    # official bfloat16 autocast context, while retaining explicit tokenizer
    # and threshold bindings above.
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        for left, top, right, bottom in window_specs:
            crop = input_image.crop((left, top, right, bottom))
            state = processor.set_image(crop)
            result = processor.set_text_prompt(state=state, prompt=payload["segmentationPrompt"])
            masks = result["masks"]
            scores = result["scores"]
            require(torch.is_tensor(masks) and torch.is_tensor(scores), "SAM 3 result tensors are absent")
            scores = scores.reshape(-1)
            # Keep this bounded diagnostic in the Modal log.  It is not part
            # of the receipt identity; it lets a qualification distinguish a
            # genuine no-detection from a provider that only emits scores
            # below Basalt's admission threshold.
            if scores.numel():
                print(
                    f"SAM3 window=({left},{top},{right},{bottom}) "
                    f"proposals={scores.numel()} "
                    f"score_min={float(scores.min().item()):.6f} "
                    f"score_max={float(scores.max().item()):.6f}",
                    flush=True,
                )
            else:
                print(
                    f"SAM3 window=({left},{top},{right},{bottom}) proposals=0",
                    flush=True,
                )
            normalized_masks = masks
            while normalized_masks.ndim > 3 and normalized_masks.shape[1] == 1:
                normalized_masks = normalized_masks.squeeze(1)
            require(normalized_masks.ndim == 3, "SAM 3 mask tensor shape differs")
            ranked = torch.argsort(scores, descending=True)
            selected_indices: list[int] = []
            selected_mask_tensors: list[torch.Tensor] = []
            crop_area = max(1, (right - left) * (bottom - top))
            full_frame = left == 0 and top == 0 and right == width and bottom == height
            candidates: list[tuple[float, int, torch.Tensor]] = []
            for candidate_index in ranked[scores[ranked] >= SAM3_SCORE_THRESHOLD].tolist():
                candidate = normalized_masks[candidate_index].bool()
                candidate_area = int(candidate.sum().item())
                if candidate_area == 0:
                    continue
                area_fraction = candidate_area / crop_area
                border = torch.cat(
                    (
                        candidate[0, :],
                        candidate[-1, :],
                        candidate[:, 0],
                        candidate[:, -1],
                    )
                )
                border_area_fraction = float(border.sum().item()) / max(1, candidate_area)
                # Reject scene mattes and edge contamination in the canonical
                # full-frame pass. An invalid mask must trigger a new
                # reference/plan decision, never feed background pixels to 3D.
                if full_frame and (
                    area_fraction > SAM3_MAX_FULL_FRAME_AREA_FRACTION
                    or border_area_fraction > SAM3_MAX_BORDER_AREA_FRACTION
                ):
                    continue
                boundedness = max(0.0, 1.0 - max(0.0, area_fraction - 0.45) / 0.55)
                edge_penalty = min(1.0, border_area_fraction / SAM3_MAX_BORDER_AREA_FRACTION)
                quality = float(scores[candidate_index].item()) + 0.15 * boundedness - 0.35 * edge_penalty
                candidates.append((quality, candidate_index, candidate))
            candidates.sort(key=lambda item: (-item[0], item[1]))
            for _, candidate_index, candidate in candidates:
                duplicate = False
                for prior in selected_mask_tensors:
                    intersection = int((candidate & prior).sum().item())
                    union_area = int((candidate | prior).sum().item())
                    if union_area and intersection / union_area >= 0.9:
                        duplicate = True
                        break
                if duplicate:
                    continue
                selected_indices.append(candidate_index)
                selected_mask_tensors.append(candidate)
                if len(selected_indices) == SAM3_MAX_SELECTED_INSTANCES_PER_WINDOW:
                    break
            selected_masks = normalized_masks[selected_indices]
            raw_identity.update(
                json.dumps([left, top, right, bottom], separators=(",", ":")).encode("ascii")
            )
            raw_identity.update(
                masks.detach().to(device="cpu", dtype=torch.float32).contiguous().numpy().tobytes()
            )
            raw_identity.update(
                scores.detach().to(device="cpu", dtype=torch.float32).contiguous().numpy().tobytes()
            )
            instance_count += len(selected_indices)
            if selected_masks.numel() == 0:
                continue
            require(selected_masks.ndim == 3, "SAM 3 mask tensor shape differs")
            crop_union = selected_masks.bool().any(dim=0)
            crop_union = crop_union.to(dtype=torch.float32).unsqueeze(0).unsqueeze(0)
            crop_union = torch.nn.functional.interpolate(
                crop_union,
                size=(bottom - top, right - left),
                mode="nearest",
            )[0, 0].bool().detach().cpu()
            if full_frame:
                # The full-frame pass is the canonical object mask. Tiled
                # windows are only a bounded recovery path when that pass has
                # no admissible instance; OR-ing every tile into a valid full
                # mask recreates the scene-matte noise this stage is meant to
                # prevent.
                canonical_full_frame = crop_union
            else:
                union[top:bottom, left:right] |= crop_union
    elapsed = time.monotonic() - started
    if canonical_full_frame is not None:
        union = canonical_full_frame
    require(tuple(union.shape) == (height, width), "SAM 3 output dimensions differ")
    union_array = union.numpy().astype(np.uint8) * 255
    mask_image = Image.fromarray(union_array, mode="L")
    output_bytes = encode_png(mask_image)
    evidence = {
        "seed": None,
        "steps": 0,
        "scoreThreshold": SAM3_SCORE_THRESHOLD,
        "instanceCount": instance_count,
        "modelOutputSha256": raw_identity.hexdigest(),
        "postprocess": "best_instance_mask",
        "protectedPixelCount": 0,
        "protectedPixelMismatchCount": 0,
        "elapsedMilliseconds": round(elapsed * 1000),
        "gpuSeconds": round(elapsed, 6),
    }
    del processor, model
    torch.cuda.empty_cache()
    return output_bytes, output_bytes, evidence


def seal_evaluation_receipt(
    request: dict[str, Any],
    authorization: dict[str, Any],
    output_bytes: bytes,
    inference: dict[str, Any],
    manifest: dict[str, Any],
    source_seal: dict[str, Any],
    model_seal: dict[str, Any],
) -> dict[str, Any]:
    payload = request["payload"]
    width = payload["width"] if request["route"] == "prompted_segmentation" else payload["canvas"]["width"]
    height = payload["height"] if request["route"] == "prompted_segmentation" else payload["canvas"]["height"]
    roots = runtime_roots(request["producerId"])
    material = {
        "kind": "ReferenceImageWorkerReceipt",
        "abi": RECEIPT_ABI,
        "status": "evaluation_complete",
        "route": request["route"],
        "executionScope": EVALUATION_SCOPE,
        "evaluationAuthorizationHash": authorization["hash"],
        "requestHash": request["hash"],
        "producerQualificationHash": request["producerQualificationHash"],
        "invocationHash": request["invocationHash"],
        "attemptId": request["attemptId"],
        "executionBinding": request["executionBinding"],
        "output": {
            "role": PRODUCERS[request["producerId"]]["outputRole"],
            "mediaType": "image/png",
            "sha256": hashlib.sha256(output_bytes).hexdigest(),
            "bytes": len(output_bytes),
            "width": width,
            "height": height,
            "channels": PRODUCERS[request["producerId"]]["outputChannels"],
            "colorSpace": PRODUCERS[request["producerId"]]["outputColorSpace"],
        },
        "inference": inference,
        "runtime": {
            "runtimeEgress": "denied",
            "networkAttempted": False,
            "runtimeDownloads": False,
            "trustRemoteCode": False,
            "modelRoot": roots["modelRoot"],
            "sourceRoot": roots["sourceRoot"],
            "runtimeManifestHash": manifest["hash"],
            "modelSnapshotSealHash": model_seal["hash"],
            "sourceSnapshotSealHash": source_seal["hash"],
        },
    }
    return {**material, "hash": content_hash(material)}


def execute_evaluation_smoke(
    request_path: str,
    authorization_path: str,
    input_path: str,
    protected_mask_path: str,
    output_path: str,
    model_output_path: str,
    receipt_path: str,
) -> dict[str, Any]:
    request = validate_request(read_canonical_json(request_path, "worker request"))
    authorization = validate_evaluation_authorization(
        read_canonical_json(authorization_path, "evaluation-smoke authorization"), request
    )
    require(request["producerId"] in {"qwen_image_edit_2511", "sam3"}, "producer is not implemented")
    input_bytes = read_regular_file(input_path, MAX_IMAGE_BYTES, "worker input")
    input_artifact = (
        request["payload"]["contextRender"]
        if request["route"] == "region_composition"
        else request["payload"]["inputImage"]
    )
    require(input_artifact["bytes"] == len(input_bytes), "worker input byte count differs")
    require(
        input_artifact["artifactHash"] == hashlib.sha256(input_bytes).hexdigest(),
        "worker input bytes differ",
    )
    manifest, source_seal, model_seal = load_runtime_manifest(request)
    if request["producerId"] == "qwen_image_edit_2511":
        protected_bytes = read_regular_file(
            protected_mask_path, MAX_IMAGE_BYTES, "protected-pixel mask"
        )
        protected_artifact = request["payload"]["protectedPixelMask"]
        require(protected_artifact["bytes"] == len(protected_bytes), "protected mask byte count differs")
        require(
            protected_artifact["artifactHash"] == hashlib.sha256(protected_bytes).hexdigest(),
            "protected mask bytes differ",
        )
        output_bytes, model_output_bytes, inference = execute_qwen_composition(
            request, input_bytes, protected_bytes
        )
    else:
        require(protected_mask_path == "", "SAM 3 does not accept a protected-pixel mask")
        output_bytes, model_output_bytes, inference = execute_sam3_segmentation(request, input_bytes)
    receipt = seal_evaluation_receipt(
        request,
        authorization,
        output_bytes,
        inference,
        manifest,
        source_seal,
        model_seal,
    )
    validate_receipt(receipt, request, output_bytes, authorization)
    write_absent(Path(output_path), output_bytes)
    write_absent(Path(model_output_path), model_output_bytes)
    write_absent(Path(receipt_path), canonical_bytes(receipt) + b"\n")
    return receipt


def write_absent(path: Path, payload: bytes) -> None:
    require(path.is_absolute() and path.parent.is_dir(), "output parent must exist")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def dry_run(request: dict[str, Any]) -> dict[str, Any]:
    payload = request["payload"]
    input_hash = None
    if request["route"] == "region_composition":
        input_hash = payload["contextRender"]["artifactHash"]
    elif request["route"] == "prompted_segmentation":
        input_hash = payload["inputImage"]["artifactHash"]
    material = {
        "kind": "ReferenceImageDryRunPlan",
        "abi": "basalt-reference-image-dry-run-plan@1",
        "status": "incomplete",
        "code": "dry_run_only",
        "requestHash": request["hash"],
        "route": request["route"],
        "producerQualificationHash": request["producerQualificationHash"],
        "modelRevision": request["modelRevision"],
        "inputArtifactHash": input_hash,
        "modelWillRun": False,
        "gpuAllocated": False,
        "remoteInvocationOccurred": False,
        "runtimeDownloads": "denied",
        "runtimeEgress": "denied",
        "trustRemoteCode": False,
        "expectedOutputRole": PRODUCERS[request["producerId"]]["outputRole"],
    }
    return {**material, "hash": content_hash(material)}


def local_probe() -> dict[str, Any]:
    worker_path = Path(__file__).resolve()
    material = {
        "kind": "ReferenceImageLocalCapabilityProbe",
        "abi": "basalt-reference-image-local-capability-probe@1",
        "status": "incomplete",
        "code": "evaluation_inference_implemented_runtime_unprobed",
        "workerId": WORKER_ID,
        "workerRevision": WORKER_REVISION,
        "workerSha256": hashlib.sha256(worker_path.read_bytes()).hexdigest(),
        "routes": sorted({contract["route"] for contract in PRODUCERS.values()}),
        "pins": {producer: PRODUCERS[producer] for producer in sorted(PRODUCERS)},
        "python": platform.python_version(),
        "platform": platform.platform(),
        "modelLoaded": False,
        "modelWillRun": False,
        "gpuAllocated": False,
        "remoteInvocationOccurred": False,
        "networkUsed": False,
        "runtimeDownloads": False,
        "trustRemoteCode": False,
    }
    return {**material, "hash": content_hash(material)}


def replay(
    request_path: str,
    receipt_path: str,
    output_path: str,
    authorization_path: str | None = None,
) -> dict[str, Any]:
    request = validate_request(read_canonical_json(request_path, "worker request"))
    receipt = read_canonical_json(receipt_path, "worker receipt")
    output = read_regular_file(output_path, MAX_IMAGE_BYTES, "worker output")
    authorization = (
        read_canonical_json(authorization_path, "evaluation-smoke authorization")
        if authorization_path is not None
        else None
    )
    validate_receipt(receipt, request, output, authorization)
    material = {
        "kind": "ReferenceImageReplayDecision",
        "abi": "basalt-reference-image-replay-decision@1",
        "status": "eligible",
        "requestHash": request["hash"],
        "receiptHash": receipt["hash"],
        "outputSha256": hashlib.sha256(output).hexdigest(),
        "modelWillRun": False,
        "gpuAllocated": False,
        "remoteInvocationOccurred": False,
    }
    return {**material, "hash": content_hash(material)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Basalt reference-image worker protocol")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--local-probe", action="store_true")
    modes.add_argument("--dry-run", metavar="REQUEST")
    modes.add_argument("--replay", nargs=3, metavar=("REQUEST", "RECEIPT", "OUTPUT"))
    modes.add_argument(
        "--replay-evaluation",
        nargs=4,
        metavar=("REQUEST", "AUTHORIZATION", "RECEIPT", "OUTPUT"),
    )
    modes.add_argument(
        "--execute-evaluation-smoke",
        nargs=7,
        metavar=(
            "REQUEST",
            "AUTHORIZATION",
            "INPUT",
            "PROTECTED_MASK_OR_EMPTY",
            "OUTPUT",
            "MODEL_OUTPUT",
            "RECEIPT",
        ),
    )
    arguments = parser.parse_args()
    if arguments.local_probe:
        output = local_probe()
    elif arguments.dry_run:
        output = dry_run(validate_request(read_canonical_json(arguments.dry_run, "worker request")))
    elif arguments.replay_evaluation:
        request_path, authorization_path, receipt_path, output_path = arguments.replay_evaluation
        output = replay(request_path, receipt_path, output_path, authorization_path)
    elif arguments.execute_evaluation_smoke:
        output = execute_evaluation_smoke(*arguments.execute_evaluation_smoke)
    else:
        output = replay(*arguments.replay)
    print(canonical_bytes(output).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
