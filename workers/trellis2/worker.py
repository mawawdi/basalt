#!/usr/bin/env python3
"""Fail-closed TRELLIS.2 static-object worker.

The dry-run and probe commands remain dependency-free. ``--execute`` is the
qualified Linux/NVIDIA entry point: it consumes one exact RGBA PNG, loads only
pre-provisioned local model files, runs the fixed 1024 cascade, and writes raw
mesh attributes as safetensors. It deliberately bypasses TRELLIS.2's stock
loader, background remover, renderer, and GLB exporter.

This file does not make the route production-eligible by itself. Basalt admits
an execution only through a retained qualification and independently retained
receipt whose identities match the output produced here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKER_ID = "basalt-trellis2-protocol-worker"
WORKER_REVISION = "2026-09-10.5"
SOURCE_COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
MODEL_ID = "microsoft/TRELLIS.2-4B"
MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d"
SPARSE_DECODER_MODEL_ID = "microsoft/TRELLIS-image-large"
SPARSE_DECODER_MODEL_REVISION = "25e0d31ffbebe4b5a97464dd851910efc3002d96"
DINOV3_MODEL_ID = "facebook/dinov3-vitl16-pretrain-lvd1689m"
DINOV3_MODEL_REVISION = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
MODEL_SNAPSHOT_SEAL_HASH = "a85c4f0213a80cdea55939ab99700588bfafbc6337ad145e73520072eba2f33d"
SPARSE_DECODER_SNAPSHOT_SEAL_HASH = (
    "bc3b9c605d46bcbc11a03d6f8d52fd45d6d31b969e728f4d2c8c14bd2af9120b"
)
DINOV3_SNAPSHOT_SEAL_HASH = "99a92ab12775e39231f2c8d48c680c83673b1f48486de69d2375b253af2e4368"
FACTORY_REVISION_HASH = "7d4284a3f26041b2b02c5d147ea9378d8816ae38c3cbc44ebcdecfcf28ece281"
PROFILE_ID = "trellis2-1024-cascade-12-step"
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_REFERENCE_BYTES = 64 * 1024 * 1024
MINIMUM_VRAM_GIB = 40.0
TENSOR_BUNDLE_ABI = "basalt-mesh-attribute-tensor-bundle@2"
WORKER_RESULT_ABI = "basalt-trellis2-worker-result@4"
EXECUTION_STAGE_NAMES = (
    "model_load_started",
    "model_load_complete",
    "sparse_structure_complete",
    "shape_cascade_complete",
    "texture_cascade_complete",
    "mesh_decode_complete",
)

PROFILE = {
    "id": PROFILE_ID,
    "pipeline": "1024_cascade",
    "resolution": 1024,
    "sparseStructure": {"steps": 12, "guidance": 7.5, "rescale": 0.7, "rescaleT": 5},
    "shape": {"steps": 12, "guidance": 7.5, "rescale": 0.5, "rescaleT": 3},
    "texture": {"steps": 12, "guidance": 1, "rescale": 0, "rescaleT": 3},
}

MODEL_KEYS = (
    "shape_slat_decoder",
    "shape_slat_flow_model_1024",
    "shape_slat_flow_model_512",
    "sparse_structure_decoder",
    "sparse_structure_flow_model",
    "tex_slat_decoder",
    "tex_slat_flow_model_1024",
    "tex_slat_flow_model_512",
)
NETWORK_ATTEMPTS: list[str] = []


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


def read_json(path: Path) -> Any:
    resolved = path.resolve(strict=True)
    require(resolved == path.absolute(), "input path must be canonical")
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), "input must be a regular file")
    require(metadata.st_size <= MAX_INPUT_BYTES, "input exceeds byte budget")
    raw = resolved.read_bytes()
    value = json.loads(raw.decode("utf-8"))
    require(raw.rstrip(b"\n") == canonical_bytes(value), "input JSON must be canonical")
    return value


def validate_hash(value: Any, label: str) -> str:
    require(isinstance(value, str) and len(value) == 64, f"{label} must be a sha256")
    require(all(character in "0123456789abcdef" for character in value), f"{label} is not hex")
    return value


def validate_modal_image_id(value: Any, label: str) -> str:
    require(
        isinstance(value, str)
        and value.startswith("im-")
        and len(value) > 3
        and value[3:].isalnum(),
        f"{label} must be an exact Modal Image ID",
    )
    return value


def validate_request(value: Any) -> dict[str, Any]:
    require(isinstance(value, dict), "request must be an object")
    require(
        set(value)
        == {
            "kind",
            "abi",
            "route",
            "executionClass",
            "factoryId",
            "factoryRevisionHash",
            "sourceCommit",
            "modelId",
            "modelRevision",
            "qualificationHash",
            "qualificationBinding",
            "attemptId",
            "invocationHash",
            "requirementHash",
            "styleContractHash",
            "capability",
            "reference",
            "seedOrdinal",
            "seed",
            "profile",
            "delivery",
            "hash",
        },
        "request shape differs from the fixed worker contract",
    )
    require(value.get("kind") == "Trellis2GenerationRequest", "wrong request kind")
    require(value.get("abi") == "basalt-trellis2-generation-request@3", "wrong request ABI")
    require(value.get("route") == "neural_asset", "wrong route")
    require(value.get("executionClass") == "remote_neural_asset", "wrong execution class")
    require(value.get("factoryId") == "Trellis2StaticObject", "wrong factory")
    require(value.get("factoryRevisionHash") == FACTORY_REVISION_HASH, "wrong factory revision")
    require(value.get("sourceCommit") == SOURCE_COMMIT, "unpinned TRELLIS.2 source")
    require(value.get("modelId") == MODEL_ID, "wrong model")
    require(value.get("modelRevision") == MODEL_REVISION, "unpinned model revision")
    validate_hash(value.get("hash"), "request hash")
    request_material = {key: entry for key, entry in value.items() if key != "hash"}
    require(content_hash(request_material) == value["hash"], "request identity mismatch")
    validate_hash(value.get("qualificationHash"), "qualification hash")
    validate_hash(value.get("invocationHash"), "invocation hash")
    validate_hash(value.get("requirementHash"), "requirement hash")
    validate_hash(value.get("styleContractHash"), "style contract hash")
    binding = value.get("qualificationBinding")
    require(
        isinstance(binding, dict)
        and set(binding)
        == {
            "modalImageId",
            "runtimeImageHash",
            "workerSha256",
            "dependencyInventoryHash",
            "dinoV3TermsSnapshotHash",
            "adapterRevisionHash",
            "adapterSha256",
            "postprocessorIdentityHash",
            "modelIdentityHash",
            "termsSnapshotHash",
            "egressPolicyHash",
            "inputPolicyHash",
        },
        "qualification binding is absent or malformed",
    )
    validate_modal_image_id(binding["modalImageId"], "qualification binding modalImageId")
    for key in set(binding) - {"modalImageId"}:
        validate_hash(binding[key], f"qualification binding {key}")
    require(
        binding["modelIdentityHash"]
        == content_hash({"modelId": MODEL_ID, "modelRevision": MODEL_REVISION}),
        "model identity binding differs from the fixed model",
    )
    require(
        binding["egressPolicyHash"]
        == content_hash({"runtimeDownloads": "denied", "runtimeEgress": "denied"}),
        "egress policy binding differs from the fixed policy",
    )
    require(
        binding["inputPolicyHash"]
        == content_hash(
            {
                "backgroundRemoval": "caller_supplied_alpha_only",
                "inputPolicy": "single_rights_bound_rgba_png",
            }
        ),
        "input policy binding differs from the fixed policy",
    )

    capability = value.get("capability")
    require(
        capability == {"form": "object", "partRole": "render_static"},
        "TRELLIS.2 qualification is static-object only",
    )
    profile = value.get("profile")
    require(profile == PROFILE, "request differs from the fixed TRELLIS.2 profile")

    reference = value.get("reference")
    require(isinstance(reference, dict), "missing reference")
    require(
        set(reference)
        == {"kind", "abi", "artifact", "decoding", "alphaStatistics", "rights", "hash"},
        "reference shape differs from the fixed worker contract",
    )
    require(reference.get("kind") == "Trellis2ReferenceImage", "wrong reference kind")
    require(reference.get("abi") == "basalt-trellis2-reference-image@1", "wrong reference ABI")
    validate_hash(reference.get("hash"), "reference hash")
    require(
        content_hash({key: entry for key, entry in reference.items() if key != "hash"})
        == reference["hash"],
        "reference identity mismatch",
    )
    require(reference.get("artifact", {}).get("mediaType") == "image/png", "reference is not PNG")
    require(
        isinstance(reference.get("artifact"), dict)
        and set(reference["artifact"]) == {"locator", "artifactHash", "bytes", "mediaType"},
        "reference artifact shape is invalid",
    )
    validate_hash(reference["artifact"].get("artifactHash"), "reference artifact hash")
    decoding = reference.get("decoding")
    require(
        isinstance(decoding, dict)
        and set(decoding)
        == {
            "width",
            "height",
            "bitDepth",
            "colorType",
            "channelCount",
            "alphaMode",
            "decoderIdentityHash",
            "decoderEvidenceArtifact",
        }
        and decoding.get("bitDepth") == 8
        and decoding.get("colorType") == "rgba"
        and decoding.get("channelCount") == 4,
        "reference must be exact RGBA8",
    )
    alpha = reference.get("alphaStatistics")
    require(
        isinstance(alpha, dict)
        and set(alpha) == {"transparentPixels", "translucentPixels", "opaquePixels"}
        and alpha.get("opaquePixels", 0) > 0
        and alpha.get("transparentPixels", 0) + alpha.get("translucentPixels", 0) > 0,
        "reference must carry an explicit alpha mask",
    )
    require(
        sum(int(alpha[key]) for key in ("transparentPixels", "translucentPixels", "opaquePixels"))
        == int(decoding.get("width", 0)) * int(decoding.get("height", 0)),
        "reference alpha inventory differs from decoded dimensions",
    )
    rights = reference.get("rights")
    require(
        isinstance(rights, dict)
        and set(rights) == {"usage", "sourceLabel", "licenseId", "attribution", "evidenceArtifact"}
        and rights.get("usage")
        in ("creator_owned", "commercial_use_permitted", "evaluation_only"),
        "reference lacks retained rights evidence",
    )
    delivery = value.get("delivery")
    require(isinstance(delivery, dict), "missing delivery policy")
    require(
        set(delivery)
        == {
            "expectedBounds",
            "maximumTriangles",
            "maximumTextureEdge",
            "maximumMeshes",
            "requiredTextureChannels",
            "transparency",
        },
        "delivery shape differs from the fixed worker contract",
    )
    require(delivery.get("maximumTriangles", 0) <= 18_000, "triangle budget exceeds qualification")
    require(delivery.get("maximumTextureEdge", 0) <= 2048, "texture budget exceeds qualification")
    require(delivery.get("maximumMeshes") == 1, "TRELLIS.2 route is single-mesh only")
    require(delivery.get("transparency") == "opaque_only", "transparency is not qualified")
    return value


def dry_run(request: dict[str, Any]) -> dict[str, Any]:
    profile_hash = content_hash(request["profile"])
    material = {
        "abi": "basalt-trellis2-dry-run-plan@1",
        "code": "dry_run_only",
        "executionClass": "remote_neural_asset",
        "expectedOutput": {
            "contract": TENSOR_BUNDLE_ABI,
            "mediaType": "application/x-safetensors",
        },
        "factoryId": "Trellis2StaticObject",
        "isolation": {
            "inputMount": "read_only",
            "outputMount": "write_only",
            "runtimeDownloads": "denied",
            "runtimeEgress": "denied",
            "trustRemoteCode": False,
        },
        "kind": "Trellis2DryRunPlan",
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "modelWillRun": False,
        "profileHash": profile_hash,
        "qualificationHash": request["qualificationHash"],
        "referenceArtifactHash": request["reference"]["artifact"]["artifactHash"],
        "requestHash": request["hash"],
        "requiredHardware": {"acceleratorVendor": "nvidia", "minimumVramGiB": 40},
        "route": "neural_asset",
        "seed": request["seed"],
        "sourceCommit": SOURCE_COMMIT,
        "status": "incomplete",
    }
    return {**material, "hash": content_hash(material)}


def local_probe() -> dict[str, Any]:
    worker_path = Path(__file__).resolve()
    material = {
        "code": "qualification_runtime_not_executed",
        "kind": "Trellis2LocalCapabilityProbe",
        "modelLoaded": False,
        "modelRevision": MODEL_REVISION,
        "networkUsed": False,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "sourceCommit": SOURCE_COMMIT,
        "status": "incomplete",
        "workerId": WORKER_ID,
        "workerRevision": WORKER_REVISION,
        "workerSha256": hashlib.sha256(worker_path.read_bytes()).hexdigest(),
    }
    return {**material, "hash": content_hash(material)}


def utc_at_milliseconds(epoch_milliseconds: int) -> str:
    return datetime.fromtimestamp(epoch_milliseconds / 1000, timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def require_regular_file(path: Path, maximum_bytes: int, label: str) -> Path:
    resolved = path.resolve(strict=True)
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(metadata.st_size > 0 and metadata.st_size <= maximum_bytes, f"{label} byte bound failed")
    return resolved


def require_directory(path: Path, label: str) -> Path:
    resolved = path.resolve(strict=True)
    metadata = os.lstat(resolved)
    require(stat.S_ISDIR(metadata.st_mode), f"{label} must be a directory")
    return resolved


def contained_path(root: Path, relative_path: str, label: str) -> Path:
    require(relative_path and not os.path.isabs(relative_path), f"{label} must be relative")
    candidate = (root / relative_path).resolve(strict=True)
    require(candidate == root or root in candidate.parents, f"{label} escapes its declared root")
    return candidate


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def deny_network() -> None:
    """Install a process-local denial in addition to the runtime's network namespace."""

    os.environ.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "DIFFUSERS_OFFLINE": "1",
            "WANDB_DISABLED": "true",
        }
    )

    class NetworkDeniedSocket(socket.socket):
        def connect(self, *_args: Any, **_kwargs: Any) -> None:
            NETWORK_ATTEMPTS.append("socket.connect")
            raise RuntimeError("TRELLIS.2 runtime network access is denied")

        def connect_ex(self, *_args: Any, **_kwargs: Any) -> int:
            NETWORK_ATTEMPTS.append("socket.connect_ex")
            raise RuntimeError("TRELLIS.2 runtime network access is denied")

    def denied_connection(*_args: Any, **_kwargs: Any) -> None:
        NETWORK_ATTEMPTS.append("socket.resolve_or_create")
        raise RuntimeError("TRELLIS.2 runtime network access is denied")

    socket.socket = NetworkDeniedSocket
    socket.create_connection = denied_connection
    socket.getaddrinfo = denied_connection


def reference_image(path: Path, request: dict[str, Any]):
    reference_path = require_regular_file(path, MAX_REFERENCE_BYTES, "reference image")
    require(
        sha256_file(reference_path) == request["reference"]["artifact"]["artifactHash"],
        "reference bytes do not match the request",
    )
    from PIL import Image

    image = Image.open(reference_path)
    image.load()
    require(image.format == "PNG", "reference decoder did not identify PNG")
    require(image.mode == "RGBA", "reference must decode as RGBA")
    require(
        image.size
        == (
            request["reference"]["decoding"]["width"],
            request["reference"]["decoding"]["height"],
        ),
        "reference dimensions differ from retained decoding evidence",
    )
    alpha = image.getchannel("A")
    extrema = alpha.getextrema()
    require(extrema is not None and extrema[0] < 255 and extrema[1] > 0, "reference alpha is invalid")
    histogram = alpha.histogram()
    measured = {
        "transparentPixels": int(histogram[0]),
        "translucentPixels": int(sum(histogram[1:255])),
        "opaquePixels": int(histogram[255]),
    }
    require(
        measured == request["reference"]["alphaStatistics"],
        "decoded reference alpha statistics differ from retained evidence",
    )
    return image


def conditioning_image(image: Any):
    """Make a neutral RGB image from the caller-owned alpha cutout.

    TRELLIS' stock preprocessor premultiplies an RGBA cutout against black.
    That is useful for its own background-removal path, but it makes dark
    stylized objects indistinguishable from the transparent canvas.  Basalt has
    already qualified the alpha mask, so crop it here and composite onto a
    neutral studio matte before calling the model with preprocessing disabled.
    This keeps transparency out of the encoder without ever instantiating a
    prohibited background-removal model.
    """
    from PIL import Image
    import numpy as np

    require(image.mode == "RGBA", "conditioning image must be RGBA")
    alpha = np.asarray(image.getchannel("A"), dtype=np.uint8)
    opaque = np.argwhere(alpha > int(0.8 * 255))
    require(opaque.size > 0, "conditioning image has no opaque subject")
    left, top = opaque[:, 1].min(), opaque[:, 0].min()
    right, bottom = opaque[:, 1].max(), opaque[:, 0].max()
    center_x = (int(left) + int(right)) / 2
    center_y = (int(top) + int(bottom)) / 2
    size = max(int(right) - int(left), int(bottom) - int(top))
    margin = max(8, int(round(size * 0.08)))
    size += margin * 2
    crop = (
        max(0, int(round(center_x - size / 2))),
        max(0, int(round(center_y - size / 2))),
        min(image.width, int(round(center_x + size / 2))),
        min(image.height, int(round(center_y + size / 2))),
    )
    cropped = image.crop(crop)
    background = Image.new("RGB", cropped.size, (148, 158, 172))
    background.paste(cropped.convert("RGB"), mask=cropped.getchannel("A"))
    return background


def require_snapshot_seal(
    root: Path,
    artifact_id: str,
    upstream_id: str,
    revision: str,
    expected_hash: str,
    label: str,
) -> dict[str, Any]:
    path = require_regular_file(
        root / ".basalt-evidence/snapshot-seal.json",
        1024 * 1024,
        f"{label} snapshot seal",
    )
    raw = path.read_bytes()
    seal = json.loads(raw.decode("utf-8"))
    require(isinstance(seal, dict), f"{label} snapshot seal must be an object")
    require(raw.rstrip(b"\n") == canonical_bytes(seal), f"{label} snapshot seal is not canonical")
    actual_hash = validate_hash(seal.get("hash"), f"{label} snapshot seal hash")
    require(
        content_hash({key: entry for key, entry in seal.items() if key != "hash"}) == actual_hash,
        f"{label} snapshot seal identity differs",
    )
    require(actual_hash == expected_hash, f"{label} snapshot seal differs from the runtime image")
    artifact = seal.get("artifact")
    require(isinstance(artifact, dict), f"{label} artifact binding is absent")
    require(artifact.get("artifactId") == artifact_id, f"{label} artifact ID differs")
    require(artifact.get("upstreamId") == upstream_id, f"{label} upstream ID differs")
    require(artifact.get("revision") == revision, f"{label} revision differs")
    require(seal.get("qualificationStatus") == "incomplete", f"{label} provisioning overclaims")
    return seal


def resolve_model_base(model_root: Path, sparse_decoder_root: Path, locator: str) -> Path:
    if locator.startswith("microsoft/TRELLIS-image-large/"):
        base_root = sparse_decoder_root
        relative_path = locator.removeprefix("microsoft/TRELLIS-image-large/")
    else:
        base_root = model_root
        relative_path = locator
    relative = Path(relative_path)
    require(
        relative_path != "" and not relative.is_absolute() and relative.name not in {"", ".", ".."},
        "model checkpoint must be a relative basename",
    )
    root = require_directory(base_root, "model checkpoint root")
    parent = contained_path(root, str(relative.parent), "model checkpoint parent")
    base = parent / relative.name

    # Each Hugging Face checkpoint is two regular siblings. Their shared,
    # extensionless prefix deliberately is not a filesystem entry, so qualify
    # the existing parent before constructing the prefix passed to TRELLIS.
    for suffix, maximum_bytes, label in (
        (".json", 64 * 1024 * 1024, "model config"),
        (".safetensors", 64 * 1024 * 1024 * 1024, "model weights"),
    ):
        candidate = Path(f"{base}{suffix}")
        require(not stat.S_ISLNK(os.lstat(candidate).st_mode), f"{label} must not be a symlink")
        resolved = require_regular_file(candidate, maximum_bytes, label)
        require(
            resolved.parent == parent and resolved.name == f"{relative.name}{suffix}",
            f"{label} escapes its declared checkpoint parent",
        )
    return base


def load_pipeline(
    source_root: Path,
    model_root: Path,
    sparse_decoder_root: Path,
    dino_root: Path,
):
    pipeline_path = require_regular_file(model_root / "pipeline.json", 8 * 1024 * 1024, "pipeline config")
    pipeline_document = json.loads(pipeline_path.read_text("utf-8"))
    require(pipeline_document.get("name") == "Trellis2ImageTo3DPipeline", "wrong pipeline type")
    args = pipeline_document.get("args")
    require(isinstance(args, dict), "pipeline arguments are absent")
    require(set(args.get("models", {})) == set(MODEL_KEYS), "pipeline checkpoint inventory changed")
    require(args.get("default_pipeline_type") == "1024_cascade", "pipeline default changed")
    require(args.get("rembg_model", {}).get("name") == "BiRefNet", "unexpected background model config")
    require(
        args.get("rembg_model", {}).get("args", {}).get("model_name") == "briaai/RMBG-2.0",
        "unexpected background model identity",
    )
    require(
        args.get("image_cond_model", {}).get("name") == "DinoV3FeatureExtractor",
        "unexpected image conditioner",
    )
    require(
        args.get("image_cond_model", {}).get("args", {}).get("model_name")
        == "facebook/dinov3-vitl16-pretrain-lvd1689m",
        "unexpected DINOv3 identity",
    )
    expected_stage_params = {
        "sparse_structure_sampler": {
            "steps": 12,
            "guidance_strength": 7.5,
            "guidance_rescale": 0.7,
            "rescale_t": 5.0,
        },
        "shape_slat_sampler": {
            "steps": 12,
            "guidance_strength": 7.5,
            "guidance_rescale": 0.5,
            "rescale_t": 3.0,
        },
        "tex_slat_sampler": {
            "steps": 12,
            "guidance_strength": 1.0,
            "guidance_rescale": 0.0,
            "rescale_t": 3.0,
        },
    }
    for key, expected in expected_stage_params.items():
        actual = args.get(key, {}).get("params", {})
        for name, expected_value in expected.items():
            require(actual.get(name) == expected_value, f"pipeline {key}.{name} changed")

    source_root_string = str(source_root.resolve(strict=True))
    preloaded = sorted(
        name for name in sys.modules if name == "trellis2" or name.startswith("trellis2.")
    )
    require(not preloaded, "TRELLIS.2 modules were imported before source-root qualification")

    # The immutable image intentionally exports this exact root through
    # PYTHONPATH. Canonicalize that trusted entry to index zero rather than
    # treating the qualified image configuration as an injection attack.
    def is_qualified_source_entry(value: str) -> bool:
        if value == "":
            return False
        try:
            return Path(value).resolve(strict=True) == source_root.resolve(strict=True)
        except (FileNotFoundError, OSError):
            return False

    sys.path[:] = [entry for entry in sys.path if not is_qualified_source_entry(entry)]
    sys.path.insert(0, source_root_string)
    import importlib.util

    specification = importlib.util.find_spec("trellis2")
    require(specification is not None, "qualified TRELLIS.2 module is absent")
    module_locations = tuple(specification.submodule_search_locations or ())
    require(len(module_locations) == 1, "qualified TRELLIS.2 module root is ambiguous")
    require(
        Path(module_locations[0]).resolve(strict=True).parent == source_root.resolve(strict=True),
        "TRELLIS.2 module resolves outside the qualified source root",
    )
    from trellis2 import models
    from trellis2.modules import image_feature_extractor
    from trellis2.pipelines import samplers
    from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline

    loaded_models = {
        key: models.from_pretrained(str(resolve_model_base(model_root, sparse_decoder_root, locator)))
        for key, locator in args["models"].items()
    }
    conditioners = image_feature_extractor.DinoV3FeatureExtractor(str(dino_root))
    sparse_sampler = getattr(samplers, args["sparse_structure_sampler"]["name"])(
        **args["sparse_structure_sampler"]["args"]
    )
    shape_sampler = getattr(samplers, args["shape_slat_sampler"]["name"])(
        **args["shape_slat_sampler"]["args"]
    )
    texture_sampler = getattr(samplers, args["tex_slat_sampler"]["name"])(
        **args["tex_slat_sampler"]["args"]
    )
    return Trellis2ImageTo3DPipeline(
        models=loaded_models,
        sparse_structure_sampler=sparse_sampler,
        shape_slat_sampler=shape_sampler,
        tex_slat_sampler=texture_sampler,
        sparse_structure_sampler_params=args["sparse_structure_sampler"]["params"],
        shape_slat_sampler_params=args["shape_slat_sampler"]["params"],
        tex_slat_sampler_params=args["tex_slat_sampler"]["params"],
        shape_slat_normalization=args["shape_slat_normalization"],
        tex_slat_normalization=args["tex_slat_normalization"],
        image_cond_model=conditioners,
        rembg_model=None,
        low_vram=args.get("low_vram", True),
        default_pipeline_type="1024_cascade",
    )


def vertex_normals(torch_module: Any, positions: Any, triangle_indices: Any):
    indices = triangle_indices.long()
    triangles = positions[indices]
    face_normals = torch_module.linalg.cross(
        triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    )
    normals = torch_module.zeros_like(positions)
    for corner in range(3):
        normals.index_add_(0, indices[:, corner], face_normals)
    lengths = torch_module.linalg.vector_norm(normals, dim=1, keepdim=True)
    fallback = torch_module.tensor([0.0, 0.0, 1.0], device=positions.device)
    return torch_module.where(lengths > 1e-12, normals / lengths.clamp_min(1e-12), fallback)


def topology_report(triangle_indices: Any, vertex_count: int) -> dict[str, int]:
    import numpy as np

    faces = triangle_indices.detach().cpu().numpy().astype(np.int64, copy=False)
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]), axis=0)
    edges.sort(axis=1)
    unique_edges, counts = np.unique(edges, axis=0, return_counts=True)
    parent = np.arange(vertex_count, dtype=np.int64)
    rank = np.zeros(vertex_count, dtype=np.uint8)

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = int(parent[value])
        return value

    for first, second in unique_edges:
        left, right = find(int(first)), find(int(second))
        if left == right:
            continue
        if rank[left] < rank[right]:
            left, right = right, left
        parent[right] = left
        if rank[left] == rank[right]:
            rank[left] += 1
    used = np.unique(faces.reshape(-1))
    components = len({find(int(index)) for index in used})
    return {
        "connectedComponents": components,
        "boundaryEdges": int(np.count_nonzero(counts == 1)),
        "nonManifoldEdges": int(np.count_nonzero(counts > 2)),
    }


def tensor_descriptor(name: str, tensor: Any, dtype: str) -> dict[str, Any]:
    minimum = float(tensor.min().item())
    maximum = float(tensor.max().item())
    require(np_is_finite(minimum) and np_is_finite(maximum), f"{name} contains non-finite data")
    return {
        "name": name,
        "dtype": dtype,
        "shape": [int(value) for value in tensor.shape],
        "valueRange": [minimum, maximum],
    }


def np_is_finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def execute(
    request: dict[str, Any],
    reference_path: Path,
    source_path: Path,
    model_path: Path,
    sparse_decoder_path: Path,
    dino_path: Path,
    tensor_path: Path,
) -> dict[str, Any]:
    require(platform.system() == "Linux", "qualified TRELLIS.2 execution requires Linux")
    require(os.environ.get("BASALT_TRELLIS2_RUNTIME_EGRESS") == "denied", "egress denial is absent")
    source_root = require_directory(source_path, "TRELLIS.2 source root")
    model_root = require_directory(model_path, "TRELLIS.2 model root")
    sparse_decoder_root = require_directory(
        sparse_decoder_path,
        "TRELLIS sparse-decoder model root",
    )
    dino_root = require_directory(dino_path, "DINOv3 model root")
    require(
        os.environ.get("BASALT_TRELLIS2_SOURCE_COMMIT") == SOURCE_COMMIT,
        "runtime source commit attestation differs from the qualification",
    )
    binding = request["qualificationBinding"]
    require(
        os.environ.get("BASALT_TRELLIS2_NETWORK_NAMESPACE") == "denied",
        "network namespace denial is absent",
    )
    require(
        os.environ.get("BASALT_TRELLIS2_MODAL_IMAGE_ID") == binding["modalImageId"],
        "Modal image identity differs from the qualification",
    )
    require(
        os.environ.get("BASALT_TRELLIS2_RUNTIME_IMAGE_HASH") == binding["runtimeImageHash"],
        "runtime image attestation differs from the qualification",
    )
    require_snapshot_seal(
        model_root,
        "trellis2.model",
        MODEL_ID,
        MODEL_REVISION,
        MODEL_SNAPSHOT_SEAL_HASH,
        "TRELLIS.2 model",
    )
    require_snapshot_seal(
        sparse_decoder_root,
        "trellis2.sparse_decoder_model",
        SPARSE_DECODER_MODEL_ID,
        SPARSE_DECODER_MODEL_REVISION,
        SPARSE_DECODER_SNAPSHOT_SEAL_HASH,
        "TRELLIS sparse-decoder model",
    )
    require_snapshot_seal(
        dino_root,
        "dinov3.model",
        DINOV3_MODEL_ID,
        DINOV3_MODEL_REVISION,
        DINOV3_SNAPSHOT_SEAL_HASH,
        "DINOv3 model",
    )
    require(
        sha256_file(require_regular_file(dino_root / "LICENSE.md", 8 * 1024 * 1024, "DINOv3 terms"))
        == binding["dinoV3TermsSnapshotHash"],
        "DINOv3 terms bytes differ from the qualification",
    )
    image = reference_image(reference_path, request)
    conditioned_image = conditioning_image(image)
    output_path = tensor_path.absolute()
    require(not output_path.exists(), "tensor output already exists")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    require(output_path.parent.resolve(strict=True) == output_path.parent, "output parent is not canonical")

    started_epoch_ms = time.time_ns() // 1_000_000
    stages: list[dict[str, Any]] = []

    def retain_stage(stage: str) -> None:
        expected_index = len(stages)
        require(
            expected_index < len(EXECUTION_STAGE_NAMES)
            and stage == EXECUTION_STAGE_NAMES[expected_index],
            "TRELLIS execution stage order changed",
        )
        observed_epoch_ms = time.time_ns() // 1_000_000
        event = {
            "stage": stage,
            "at": utc_at_milliseconds(observed_epoch_ms),
            "elapsedMs": observed_epoch_ms - started_epoch_ms,
        }
        stages.append(event)
        print(
            canonical_bytes(
                {
                    "kind": "Trellis2WorkerStage",
                    "abi": "basalt-trellis2-worker-stage@1",
                    "requestHash": request["hash"],
                    **event,
                }
            ).decode("utf-8"),
            file=sys.stderr,
            flush=True,
        )

    deny_network()
    retain_stage("model_load_started")
    pipeline = load_pipeline(source_root, model_root, sparse_decoder_root, dino_root)
    retain_stage("model_load_complete")

    def retain_after(method_name: str, stage: str) -> None:
        original = getattr(pipeline, method_name)

        def instrumented(*args: Any, **kwargs: Any) -> Any:
            result = original(*args, **kwargs)
            retain_stage(stage)
            return result

        setattr(pipeline, method_name, instrumented)

    retain_after("sample_sparse_structure", "sparse_structure_complete")
    retain_after("sample_shape_slat_cascade", "shape_cascade_complete")
    retain_after("sample_tex_slat", "texture_cascade_complete")
    retain_after("decode_latent", "mesh_decode_complete")
    import torch
    from safetensors.torch import save_file

    require(torch.cuda.is_available(), "CUDA is unavailable")
    properties = torch.cuda.get_device_properties(0)
    vram_gib = properties.total_memory / (1024**3)
    require(vram_gib >= MINIMUM_VRAM_GIB, "GPU has less than 40 GiB of VRAM")
    pipeline.to(torch.device("cuda"))
    profile = request["profile"]
    # Basalt owns the alpha crop and neutral studio matte above.  Do not invoke
    # the upstream preprocessor: its premultiplied black canvas makes dark
    # stylized objects compete with the background and can collapse the shape
    # into a slab.  The qualified pipeline has ``rembg_model=None`` and no
    # background-removal dependency is instantiated.
    meshes = pipeline.run(
        conditioned_image,
        num_samples=1,
        seed=request["seed"],
        sparse_structure_sampler_params={
            "steps": profile["sparseStructure"]["steps"],
            "guidance_strength": profile["sparseStructure"]["guidance"],
            "guidance_rescale": profile["sparseStructure"]["rescale"],
            "rescale_t": profile["sparseStructure"]["rescaleT"],
        },
        shape_slat_sampler_params={
            "steps": profile["shape"]["steps"],
            "guidance_strength": profile["shape"]["guidance"],
            "guidance_rescale": profile["shape"]["rescale"],
            "rescale_t": profile["shape"]["rescaleT"],
        },
        tex_slat_sampler_params={
            "steps": profile["texture"]["steps"],
            "guidance_strength": profile["texture"]["guidance"],
            "guidance_rescale": profile["texture"]["rescale"],
            "rescale_t": profile["texture"]["rescaleT"],
        },
        preprocess_image=False,
        pipeline_type="1024_cascade",
    )
    require(
        tuple(event["stage"] for event in stages) == EXECUTION_STAGE_NAMES,
        "TRELLIS execution stage evidence is incomplete",
    )
    require(isinstance(meshes, list) and len(meshes) == 1, "worker produced an ambiguous mesh set")
    mesh = meshes[0]
    positions = mesh.vertices.detach().float().contiguous()
    triangles = mesh.faces.detach().to(dtype=torch.int32).contiguous()
    require(positions.ndim == 2 and positions.shape[1] == 3, "positions have the wrong shape")
    require(triangles.ndim == 2 and triangles.shape[1] == 3, "triangles have the wrong shape")
    require(positions.shape[0] >= 3 and triangles.shape[0] > 0, "mesh is empty")
    require(int(triangles.min()) >= 0 and int(triangles.max()) < positions.shape[0], "indices are invalid")
    attributes = mesh.query_vertex_attrs().detach().float().contiguous()
    require(attributes.shape == (positions.shape[0], 6), "PBR attribute layout changed")
    base_color = attributes[:, 0:3].clamp(0, 1).contiguous()
    metallic = attributes[:, 3:4].clamp(0, 1).contiguous()
    roughness = attributes[:, 4:5].clamp(0, 1).contiguous()
    opacity = attributes[:, 5:6].clamp(0, 1).contiguous()
    normals = vertex_normals(torch, positions, triangles).float().contiguous()
    tensors = {
        "positions": positions.cpu(),
        "triangle_indices": triangles.cpu(),
        "base_color": base_color.cpu(),
        "roughness": roughness.cpu(),
        "metallic": metallic.cpu(),
        "opacity": opacity.cpu(),
        "normals": normals.cpu(),
    }
    save_file(
        tensors,
        str(output_path),
        metadata={
            "abi": TENSOR_BUNDLE_ABI,
            "dependency_inventory_hash": binding["dependencyInventoryHash"],
            "model_id": MODEL_ID,
            "modal_image_id": binding["modalImageId"],
            "request_hash": request["hash"],
            "qualification_hash": request["qualificationHash"],
            "profile_hash": content_hash(PROFILE),
            "reference_artifact_hash": request["reference"]["artifact"]["artifactHash"],
            "runtime_image_hash": binding["runtimeImageHash"],
            "seed": str(request["seed"]),
            "source_commit": SOURCE_COMMIT,
            "model_revision": MODEL_REVISION,
            "transform_ownership": "source_frame_unbaked",
            "worker_sha256": binding["workerSha256"],
        },
    )
    tensor_sha256 = sha256_file(output_path)
    descriptors = [
        tensor_descriptor("positions", tensors["positions"], "F32"),
        tensor_descriptor("triangle_indices", tensors["triangle_indices"], "I32"),
        tensor_descriptor("base_color", tensors["base_color"], "F32"),
        tensor_descriptor("roughness", tensors["roughness"], "F32"),
        tensor_descriptor("metallic", tensors["metallic"], "F32"),
        tensor_descriptor("opacity", tensors["opacity"], "F32"),
        tensor_descriptor("normals", tensors["normals"], "F32"),
    ]
    topology = topology_report(triangles, int(positions.shape[0]))
    ended_epoch_ms = time.time_ns() // 1_000_000
    elapsed_ms = ended_epoch_ms - started_epoch_ms
    material = {
        "kind": "Trellis2WorkerResult",
        "abi": WORKER_RESULT_ABI,
        "status": "candidate",
        "requestHash": request["hash"],
        "qualificationHash": request["qualificationHash"],
        "sourceCommit": SOURCE_COMMIT,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "profileHash": content_hash(PROFILE),
        "seed": request["seed"],
        "executionBinding": {
            "modalImageId": binding["modalImageId"],
            "runtimeImageHash": binding["runtimeImageHash"],
            "workerSha256": binding["workerSha256"],
            "dependencyInventoryHash": binding["dependencyInventoryHash"],
            "dinoV3TermsSnapshotHash": binding["dinoV3TermsSnapshotHash"],
            "referenceArtifactHash": request["reference"]["artifact"]["artifactHash"],
        },
        "output": {
            "mediaType": "application/x-safetensors",
            "sha256": tensor_sha256,
            "bytes": output_path.stat().st_size,
            "vertexCount": int(positions.shape[0]),
            "triangleCount": int(triangles.shape[0]),
            "tensors": descriptors,
            "transformOwnership": {
                "kind": "source_frame_unbaked",
                "sourceFrame": "trellis2-o-voxel-x-right-y-forward-z-up",
                "sourceToCanonicalMatrixColumnMajor": [
                    1, 0, 0, 0,
                    0, 0, -1, 0,
                    0, 1, 0, 0,
                    0, 0, 0, 1,
                ],
            },
            "topology": topology,
        },
        "hardware": {
            "acceleratorVendor": "nvidia",
            "acceleratorModel": properties.name,
            "vramGiB": vram_gib,
            "cudaVersion": str(torch.version.cuda),
            "driverVersion": os.environ.get("NVIDIA_DRIVER_VERSION", "unreported"),
        },
        "runtime": {
            "networkNamespace": "denied",
            "networkAttempted": bool(NETWORK_ATTEMPTS),
            "downloads": False,
            "trustRemoteCode": False,
            "backgroundRemovalInstantiated": False,
            "officialExporterLoaded": False,
            "forbiddenRuntimeModules": sorted(
                name
                for name in sys.modules
                if name.startswith("nvdiffrast") or name.startswith("nvdiffrec")
            ),
        },
        "stages": stages,
        "startedAt": utc_at_milliseconds(started_epoch_ms),
        "endedAt": utc_at_milliseconds(ended_epoch_ms),
        "elapsedMs": int(elapsed_ms),
    }
    require(not NETWORK_ATTEMPTS, "model runtime attempted network access")
    require(not material["runtime"]["forbiddenRuntimeModules"], "forbidden renderer entered runtime")
    return {**material, "hash": content_hash(material)}


def write_json(path: Path, value: Any) -> None:
    parent = path.absolute().parent
    parent.mkdir(parents=True, exist_ok=True)
    require(not path.exists(), "output must be absent")
    payload = canonical_bytes(value) + b"\n"
    file_descriptor, temporary = tempfile.mkstemp(prefix=".trellis2-", dir=parent)
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description="TRELLIS.2 qualified static-object worker")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--probe", metavar="OUTPUT")
    group.add_argument("--dry-run", nargs=2, metavar=("REQUEST", "OUTPUT"))
    group.add_argument(
        "--execute",
        nargs=9,
        metavar=(
            "REQUEST",
            "REFERENCE",
            "SOURCE_ROOT",
            "MODEL_ROOT",
            "SPARSE_DECODER_ROOT",
            "DINO_ROOT",
            "TENSORS",
            "REPORT",
            "EXPECTED_WORKER_SHA256",
        ),
    )
    arguments = parser.parse_args()
    if arguments.probe:
        write_json(Path(arguments.probe), local_probe())
        return 0
    if arguments.dry_run:
        request_path, output_path = arguments.dry_run
        request = validate_request(read_json(Path(request_path)))
        write_json(Path(output_path), dry_run(request))
        return 0
    (
        request_path,
        reference_path,
        source_root,
        model_root,
        sparse_decoder_root,
        dino_root,
        tensor_path,
        report_path,
        expected_worker_sha256,
    ) = arguments.execute
    request = validate_request(read_json(Path(request_path)))
    worker_hash = sha256_file(Path(__file__).resolve())
    require(worker_hash == validate_hash(expected_worker_sha256, "worker hash"), "worker hash mismatch")
    require(
        worker_hash == request["qualificationBinding"]["workerSha256"],
        "worker does not match the request qualification",
    )
    result = execute(
        request,
        Path(reference_path),
        Path(source_root),
        Path(model_root),
        Path(sparse_decoder_root),
        Path(dino_root),
        Path(tensor_path),
    )
    write_json(Path(report_path), result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"trellis2 worker rejected input: {error}", file=sys.stderr)
        raise SystemExit(2) from error
