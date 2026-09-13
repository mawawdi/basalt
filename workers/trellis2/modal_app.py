#!/usr/bin/env python3
"""Conservative Modal boundary for the unregistered TRELLIS.2 worker.

`python3 modal_app.py --local-probe` is dependency-free and never contacts
Modal. The Modal app itself only accepts an already-built immutable Image ID,
mounts stable seal-verified model Volumes read-only, and requires both an explicit
execution literal and an external Modal Secret before allocating a GPU.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from gpu_profile import selected_gpu, selected_gpu_profile, selected_minimum_vram_gib


APP_NAME = "basalt-trellis2-qualification"
RUNTIME_CONTRACT = "basalt-trellis2-modal-runtime-contract"
HANDOFF_CONTRACT = "basalt-trellis2-modal-handoff"
REMOTE_HANDOFF_CONTRACT = "basalt-trellis2-remote-output-handoff"
SOURCE_COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d"
SPARSE_DECODER_MODEL_REVISION = "25e0d31ffbebe4b5a97464dd851910efc3002d96"
DINOV3_MODEL_REVISION = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
BASE_IMAGE = (
    "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
    "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
)

GPU_PROFILE = selected_gpu_profile()
GPU_KIND = selected_gpu()
GPU_MINIMUM_VRAM_GIB = selected_minimum_vram_gib()
GPU_COUNT = 1
FUNCTION_TIMEOUT_SECONDS = 720
SUBPROCESS_TIMEOUT_SECONDS = 600
STARTUP_TIMEOUT_SECONDS = 120
MAX_CONTAINERS = 1
MIN_CONTAINERS = 0
BUFFER_CONTAINERS = 0
SCALEDOWN_WINDOW_SECONDS = 60
MAX_RETRIES = 0
CPU_REQUEST = 4.0
CPU_LIMIT = 8.0
MEMORY_REQUEST_MIB = 32 * 1024
MEMORY_LIMIT_MIB = 64 * 1024
EXECUTION_LITERAL = "RUN_ONE_QUALIFIED_BASALT_TRELLIS2_ASSET"
IMAGE_ID_ENV = "BASALT_TRELLIS2_MODAL_IMAGE_ID"
LOCAL_GATE_ENV = "BASALT_TRELLIS2_PAID_RUN_AUTHORIZATION"
MODAL_GATE_SECRET_NAME = "basalt-trellis2-execution-gate"
MODEL_VOLUME_NAME = "basalt-trellis2-model"
SPARSE_DECODER_VOLUME_NAME = (
    "basalt-trellis2-sparse-decoder-model"
)
DINOV3_VOLUME_NAME = "basalt-dinov3-model"
OUTPUT_VOLUME_NAME = "basalt-neural-output"

MODEL_ROOT = Path("/mnt/trellis2-model")
SPARSE_DECODER_ROOT = Path("/mnt/trellis2-sparse-decoder")
DINOV3_ROOT = Path("/mnt/trellis2-dinov3")
OUTPUT_ROOT = Path("/mnt/basalt-neural-output")

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_REFERENCE_BYTES = 64 * 1024 * 1024
MAX_TENSOR_BYTES = 2 * 1024 * 1024 * 1024
MAX_REPORT_BYTES = 2 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MODAL_IMAGE_ID_PATTERN = re.compile(r"^im-[A-Za-z0-9]+$")
NEW_ATTEMPT_OVERRIDE_PATTERN = re.compile(r"^[a-f0-9]{16,64}$")


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


def require_sha256(value: Any, label: str) -> str:
    require(isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None, f"{label} is invalid")
    return value


def decode_canonical_json(raw: bytes, maximum_bytes: int, label: str) -> dict[str, Any]:
    require(isinstance(raw, bytes), f"{label} must be bytes")
    require(0 < len(raw) <= maximum_bytes, f"{label} exceeds its byte bound")
    value = json.loads(raw.decode("utf-8"))
    require(isinstance(value, dict), f"{label} must be a JSON object")
    require(raw.rstrip(b"\n") == canonical_bytes(value), f"{label} must be canonical JSON")
    return value


def read_regular_file(path_value: str, maximum_bytes: int, label: str) -> bytes:
    path = Path(path_value)
    resolved = path.resolve(strict=True)
    require(resolved == path.absolute(), f"{label} path must be canonical")
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(0 < metadata.st_size <= maximum_bytes, f"{label} exceeds its byte bound")
    return resolved.read_bytes()


def local_contract() -> dict[str, Any]:
    image_configured = MODAL_IMAGE_ID_PATTERN.fullmatch(os.environ.get(IMAGE_ID_ENV, "")) is not None
    material = {
        "kind": "Trellis2ModalRuntimeContract",
        "contract": RUNTIME_CONTRACT,
        "status": "incomplete",
        "code": "remote_execution_not_authorized",
        "modelWillRun": False,
        "remoteInvocationOccurred": False,
        "appName": APP_NAME,
        "sourceCommit": SOURCE_COMMIT,
        "modelRevision": MODEL_REVISION,
        "dinoV3ModelRevision": DINOV3_MODEL_REVISION,
        "baseImage": BASE_IMAGE,
        "immutableImageIdConfigured": image_configured,
        "volumes": [
            {"name": MODEL_VOLUME_NAME, "mount": str(MODEL_ROOT), "readOnly": True},
            {
                "name": SPARSE_DECODER_VOLUME_NAME,
                "mount": str(SPARSE_DECODER_ROOT),
                "readOnly": True,
            },
            {"name": DINOV3_VOLUME_NAME, "mount": str(DINOV3_ROOT), "readOnly": True},
            {"name": OUTPUT_VOLUME_NAME, "mount": str(OUTPUT_ROOT), "readOnly": False},
        ],
        "execution": {
            "gpuProfile": GPU_PROFILE,
            "gpu": GPU_KIND,
            "gpuCount": GPU_COUNT,
            "minimumVramGiB": GPU_MINIMUM_VRAM_GIB,
            "functionTimeoutSeconds": FUNCTION_TIMEOUT_SECONDS,
            "subprocessTimeoutSeconds": SUBPROCESS_TIMEOUT_SECONDS,
            "startupTimeoutSeconds": STARTUP_TIMEOUT_SECONDS,
            "maxContainers": MAX_CONTAINERS,
            "minContainers": MIN_CONTAINERS,
            "bufferContainers": BUFFER_CONTAINERS,
            "scaledownWindowSeconds": SCALEDOWN_WINDOW_SECONDS,
            "retries": MAX_RETRIES,
            "singleUseContainer": True,
            "runtimeEgress": "denied",
            "modalResourceAccess": "denied",
            "maximumTensorBytes": MAX_TENSOR_BYTES,
        },
        "authorization": {
            "requiredExecutionLiteral": EXECUTION_LITERAL,
            "modalSecretName": MODAL_GATE_SECRET_NAME,
            "localGateEnvironmentName": LOCAL_GATE_ENV,
            "secretValueRetainedInRepository": False,
        },
        "handoff": {
            "contract": HANDOFF_CONTRACT,
            "tensorMediaType": "application/x-safetensors",
            "workerReportContract": "basalt-trellis2-worker-result",
            "hostAdmission": "retainTrellis2WorkerCandidate",
            "paidReplayPolicy": "claim_before_remote_and_fail_closed",
            "newAttemptOverridePattern": NEW_ATTEMPT_OVERRIDE_PATTERN.pattern,
            "responseMode": "small_hashed_manifest",
            "largeArtifacts": "content_addressed_output_volume",
        },
    }
    return {**material, "hash": content_hash(material)}


def run_local_probe() -> int:
    print(canonical_bytes(local_contract()).decode("utf-8"))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Basalt TRELLIS.2 Modal runtime boundary")
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("direct execution supports only --local-probe; use `modal run` for the Modal app")
    raise SystemExit(run_local_probe())


import modal  # noqa: E402  # Loaded only when Modal imports the app definition.
import sys  # noqa: E402
from modal._vendor import cloudpickle  # type: ignore[import-not-found]  # noqa: E402


def require_modal_image_id() -> str:
    image_id = os.environ.get(IMAGE_ID_ENV, "")
    require(
        MODAL_IMAGE_ID_PATTERN.fullmatch(image_id) is not None,
        f"{IMAGE_ID_ENV} must name a previously built immutable Modal Image",
    )
    return image_id


RUNTIME_IMAGE_ID = require_modal_image_id()
RUNTIME_IMAGE = modal.Image.from_id(RUNTIME_IMAGE_ID)
MODEL_VOLUME = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
SPARSE_DECODER_VOLUME = modal.Volume.from_name(
    SPARSE_DECODER_VOLUME_NAME,
    create_if_missing=False,
)
DINOV3_VOLUME = modal.Volume.from_name(DINOV3_VOLUME_NAME, create_if_missing=False)
OUTPUT_VOLUME = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
EXECUTION_GATE = modal.Secret.from_name(
    MODAL_GATE_SECRET_NAME,
    required_keys=[LOCAL_GATE_ENV],
)
app = modal.App(APP_NAME, include_source=False)

# The qualified worker and its model dependencies are already sealed into the
# immutable image. Serialize this transport module by value so remote
# deserialization never imports host-only repository code.
cloudpickle.register_pickle_by_value(sys.modules[__name__])


def validate_reference(request: dict[str, Any], reference_bytes: bytes) -> None:
    require(0 < len(reference_bytes) <= MAX_REFERENCE_BYTES, "reference exceeds its byte bound")
    reference = request.get("reference")
    require(isinstance(reference, dict), "request reference is absent")
    artifact = reference.get("artifact")
    require(isinstance(artifact, dict), "request reference artifact is absent")
    require(artifact.get("mediaType") == "image/png", "request reference is not PNG")
    require(artifact.get("bytes") == len(reference_bytes), "reference byte count differs")
    require(
        artifact.get("artifactHash") == hashlib.sha256(reference_bytes).hexdigest(),
        "reference bytes differ from request identity",
    )


def validate_worker_outputs(
    request: dict[str, Any], manifest: dict[str, Any], tensor_bytes: bytes, report_bytes: bytes
) -> dict[str, Any]:
    require(
        0 < len(tensor_bytes) <= MAX_TENSOR_BYTES,
        f"tensor result exceeds Modal handoff bound ({len(tensor_bytes)} > {MAX_TENSOR_BYTES})",
    )
    report = decode_canonical_json(report_bytes, MAX_REPORT_BYTES, "worker report")
    report_hash = require_sha256(report.get("hash"), "worker report hash")
    require(
        content_hash({key: value for key, value in report.items() if key != "hash"}) == report_hash,
        "worker report identity is invalid",
    )
    require(report.get("contract") == "basalt-trellis2-worker-result", "worker report contract differs")
    require(
        report.get("requestHash") == request.get("neuralRequestHash"),
        "worker report neural request differs",
    )
    require(report.get("workerRequestHash") == request.get("hash"), "worker report request differs")
    binding = report.get("executionBinding")
    require(isinstance(binding, dict), "worker execution binding is absent")
    require(binding.get("modalImageId") == manifest["modalImageId"], "worker Modal image differs")
    require(binding.get("runtimeImageHash") == manifest["hash"], "worker runtime image differs")
    require(
        binding.get("workerImplementationHash") == manifest["workerImplementationHash"],
        "worker implementation hash differs",
    )
    require(
        binding.get("dependencyInventoryHash") == manifest["dependencyInventoryHash"],
        "worker dependency inventory differs",
    )
    output = report.get("output")
    require(isinstance(output, dict), "worker output report is absent")
    require(output.get("mediaType") == "application/x-safetensors", "worker media type differs")
    require(output.get("bytes") == len(tensor_bytes), "worker tensor byte count differs")
    require(output.get("sha256") == hashlib.sha256(tensor_bytes).hexdigest(), "worker tensor hash differs")
    runtime = report.get("runtime")
    require(
        isinstance(runtime, dict)
        and runtime.get("networkNamespace") == "denied"
        and runtime.get("networkAttempted") is False
        and runtime.get("downloads") is False,
        "worker runtime isolation evidence is invalid",
    )
    return report


@app.function(
    serialized=True,
    image=RUNTIME_IMAGE,
    gpu=GPU_KIND,
    cpu=(CPU_REQUEST, CPU_LIMIT),
    memory=(MEMORY_REQUEST_MIB, MEMORY_LIMIT_MIB),
    volumes={
        str(MODEL_ROOT): MODEL_VOLUME.with_mount_options(read_only=True),
        str(SPARSE_DECODER_ROOT): SPARSE_DECODER_VOLUME.with_mount_options(read_only=True),
        str(DINOV3_ROOT): DINOV3_VOLUME.with_mount_options(read_only=True),
        str(OUTPUT_ROOT): OUTPUT_VOLUME,
    },
    secrets=[EXECUTION_GATE],
    min_containers=MIN_CONTAINERS,
    max_containers=MAX_CONTAINERS,
    buffer_containers=BUFFER_CONTAINERS,
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    retries=MAX_RETRIES,
    timeout=FUNCTION_TIMEOUT_SECONDS,
    startup_timeout=STARTUP_TIMEOUT_SECONDS,
    block_network=True,
    restrict_modal_access=True,
    single_use_containers=True,
    include_source=False,
)
def execute_qualified_asset(
    request_bytes: bytes,
    runtime_qualification_bytes: bytes,
    reference_bytes: bytes,
    output_key: str,
    execution_flag: str,
    execution_gate_commitment: str,
) -> dict[str, Any]:
    # Keep the serialized Function completely self-contained. With source
    # inclusion disabled, any reference to this local module would make Modal
    # attempt to import repository code in the isolated container.
    import hashlib
    import hmac
    import json
    import os
    import re
    import stat
    import subprocess
    import tempfile
    import uuid
    from pathlib import Path

    source_commit = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
    model_revision = "af44b45f2e35a493886929c6d786e563ec68364d"
    sparse_decoder_model_revision = "25e0d31ffbebe4b5a97464dd851910efc3002d96"
    dino_revision = "ea8dc2863c51be0a264bab82070e3e8836b02d51"
    base_image = (
        "docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04"
        "@sha256:5645fec64549cc35930eee9d85aafd2b0006c0c3f22632be5a1d85e2604e9749"
    )
    worker_path = Path("/opt/basalt/trellis2-worker.py")
    runtime_manifest_path = Path("/opt/basalt/trellis2-runtime-manifest.json")
    source_root = Path("/opt/basalt/trellis2-source")
    model_root = Path("/mnt/trellis2-model/snapshot")
    sparse_decoder_root = Path("/mnt/trellis2-sparse-decoder/snapshot")
    dino_root = Path("/mnt/trellis2-dinov3/snapshot")
    output_root = Path("/mnt/basalt-neural-output")
    maximum_request_bytes = 8 * 1024 * 1024
    maximum_reference_bytes = 64 * 1024 * 1024
    # Keep the complete serialized result below Modal's documented 100 MB
    # gRPC payload ceiling, including the worker report and serializer overhead.
    maximum_tensor_bytes = 2 * 1024 * 1024 * 1024
    maximum_report_bytes = 2 * 1024 * 1024
    subprocess_timeout_seconds = 600
    sha256_pattern = re.compile(r"^[a-f0-9]{64}$")
    output_key_pattern = re.compile(r"^[a-f0-9]{64}(?:--attempt-[a-f0-9]{16,64})?$")

    def checked(condition: bool, message: str) -> None:
        if not condition:
            raise ValueError(message)

    def canonical(value: object) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    def identity(value: object) -> str:
        return hashlib.sha256(canonical(value)).hexdigest()

    def checked_hash(value: object, label: str) -> str:
        checked(isinstance(value, str) and sha256_pattern.fullmatch(value) is not None, f"{label} is invalid")
        return value

    def decoded(raw: bytes, maximum: int, label: str) -> dict[str, object]:
        checked(isinstance(raw, bytes), f"{label} must be bytes")
        checked(0 < len(raw) <= maximum, f"{label} exceeds its byte bound")
        value = json.loads(raw.decode("utf-8"))
        checked(isinstance(value, dict), f"{label} must be a JSON object")
        checked(raw.rstrip(b"\n") == canonical(value), f"{label} must be canonical JSON")
        return value

    def regular_file(path: Path, maximum: int, label: str) -> bytes:
        resolved = path.resolve(strict=True)
        checked(resolved == path.absolute(), f"{label} path must be canonical")
        metadata = os.lstat(resolved)
        checked(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
        checked(
            0 < metadata.st_size <= maximum,
            f"{label} exceeds its byte bound ({metadata.st_size} > {maximum})",
        )
        return resolved.read_bytes()

    checked(
        execution_flag == "RUN_ONE_QUALIFIED_BASALT_TRELLIS2_ASSET",
        "execution literal is absent or invalid",
    )
    retained_gate = os.environ.get("BASALT_TRELLIS2_PAID_RUN_AUTHORIZATION", "")
    checked(len(retained_gate) >= 32, "Modal execution-gate Secret is absent")
    checked_hash(execution_gate_commitment, "execution gate commitment")
    checked(
        hmac.compare_digest(
            execution_gate_commitment,
            hashlib.sha256(retained_gate.encode("utf-8")).hexdigest(),
        ),
        "local and Modal execution-gate commitments differ",
    )

    request = decoded(request_bytes, maximum_request_bytes, "generation request")
    runtime_qualification = decoded(
        runtime_qualification_bytes,
        maximum_request_bytes,
        "runtime qualification",
    )
    request_hash = checked_hash(request.get("hash"), "generation request hash")
    checked(
        identity({key: value for key, value in request.items() if key != "hash"}) == request_hash,
        "generation request identity is invalid",
    )
    checked(request.get("sourceCommit") == source_commit, "generation source commit differs")
    checked(request.get("modelRevision") == model_revision, "generation model revision differs")
    qualification_hash = checked_hash(
        runtime_qualification.get("hash"),
        "runtime qualification hash",
    )
    checked(
        identity(
            {
                key: value
                for key, value in runtime_qualification.items()
                if key != "hash"
            }
        )
        == qualification_hash,
        "runtime qualification identity is invalid",
    )
    checked(
        runtime_qualification.get("kind") == "Trellis2RuntimeQualification"
        and runtime_qualification.get("contract") == "basalt-trellis2-runtime-qualification",
        "runtime qualification type differs",
    )
    checked(
        set(runtime_qualification)
        == {
            "kind",
            "contract",
            "neuralQualificationHash",
            "providerDeclarationHash",
            "modalImageId",
            "runtimeImageHash",
            "workerImplementationHash",
            "volumeSnapshotHashes",
            "dependencyInventoryHash",
            "hardwareEvidenceHash",
            "rightsEvidenceHash",
            "dinoV3TermsSnapshotHash",
            "modelTermsSnapshotHash",
            "modelIdentityHash",
            "egressPolicyHash",
            "inputPolicyHash",
            "hash",
        },
        "runtime qualification shape differs",
    )
    for hash_key in (
        "neuralQualificationHash",
        "providerDeclarationHash",
        "runtimeImageHash",
        "workerImplementationHash",
        "dependencyInventoryHash",
        "hardwareEvidenceHash",
        "rightsEvidenceHash",
        "dinoV3TermsSnapshotHash",
        "modelTermsSnapshotHash",
        "modelIdentityHash",
        "egressPolicyHash",
        "inputPolicyHash",
    ):
        checked_hash(runtime_qualification.get(hash_key), f"runtime qualification {hash_key}")
    checked(
        request.get("runtimeQualificationHash") == qualification_hash,
        "request does not bind the supplied runtime qualification",
    )
    checked(
        request.get("neuralQualificationHash")
        == runtime_qualification.get("neuralQualificationHash"),
        "request does not bind the neural qualification",
    )
    checked(
        request.get("providerDeclarationHash")
        == runtime_qualification.get("providerDeclarationHash"),
        "request does not bind the provider declaration",
    )
    checked(
        isinstance(output_key, str)
        and output_key_pattern.fullmatch(output_key) is not None
        and (output_key == request_hash or output_key.startswith(f"{request_hash}--attempt-")),
        "output key does not identify the exact request attempt",
    )
    runtime_modal_image_id = os.environ.get("MODAL_IMAGE_ID", "")
    checked(
        runtime_modal_image_id.startswith("im-")
        and len(runtime_modal_image_id) > 3
        and runtime_modal_image_id[3:].isalnum(),
        "Modal did not expose an exact runtime image ID",
    )
    request_reference = request.get("reference")
    checked(isinstance(request_reference, dict), "request reference is absent")
    reference_artifact = request_reference.get("artifact")
    checked(isinstance(reference_artifact, dict), "request reference artifact is absent")
    checked(reference_artifact.get("mediaType") == "image/png", "request reference is not PNG")
    checked(0 < len(reference_bytes) <= maximum_reference_bytes, "reference exceeds its byte bound")
    checked(reference_artifact.get("bytes") == len(reference_bytes), "reference byte count differs")
    checked(
        reference_artifact.get("artifactHash") == hashlib.sha256(reference_bytes).hexdigest(),
        "reference bytes differ from request identity",
    )

    manifest = decoded(
        regular_file(runtime_manifest_path, maximum_report_bytes, "runtime manifest"),
        maximum_report_bytes,
        "runtime manifest",
    )
    expected_manifest_keys = {
        "kind",
        "contract",
        "baseImage",
        "python",
        "torch",
        "sourceCommits",
        "modelArtifacts",
        "workerImplementationHash",
        "oVoxelRuntimePatchSha256",
        "dependencyInventoryHash",
        "dependencyInventory",
        "nativeExtensionInventoryHash",
        "nativeExtensions",
        "moduleResolutionProbe",
        "runtimePolicy",
        "hash",
    }
    checked(set(manifest) == expected_manifest_keys, "runtime manifest shape is invalid")
    checked(manifest["kind"] == "Trellis2ModalRuntimeImage", "runtime manifest kind is invalid")
    checked(manifest["contract"] == "basalt-trellis2-modal-runtime-image", "runtime manifest contract is invalid")
    checked(manifest["baseImage"] == base_image, "runtime base image differs")
    checked(manifest.get("sourceCommits", {}).get("trellis2") == source_commit, "runtime source commit differs")
    model_artifacts = manifest.get("modelArtifacts")
    checked(isinstance(model_artifacts, dict), "runtime model artifact inventory is absent")
    checked(
        model_artifacts.get("trellis2", {}).get("revision") == model_revision,
        "runtime model revision differs",
    )
    checked(
        model_artifacts.get("sparseDecoder", {}).get("revision")
        == sparse_decoder_model_revision,
        "runtime sparse-decoder revision differs",
    )
    checked(
        model_artifacts.get("dinoV3", {}).get("revision") == dino_revision,
        "runtime DINOv3 revision differs",
    )
    worker_hash = checked_hash(
        manifest["workerImplementationHash"], "runtime worker implementation hash"
    )
    checked_hash(manifest["dependencyInventoryHash"], "runtime dependency inventory hash")
    manifest_hash = checked_hash(manifest["hash"], "runtime manifest hash")
    checked(
        identity({key: value for key, value in manifest.items() if key != "hash"}) == manifest_hash,
        "runtime manifest identity is invalid",
    )
    request_binding = request.get("runtimeBinding")
    checked(isinstance(request_binding, dict), "request runtime binding is absent")
    checked(
        runtime_qualification.get("modalImageId") == runtime_modal_image_id,
        "runtime qualification Modal image differs",
    )
    checked(
        runtime_qualification.get("runtimeImageHash") == manifest_hash,
        "runtime qualification runtime image differs",
    )
    checked(
        runtime_qualification.get("workerImplementationHash") == worker_hash,
        "runtime qualification worker differs",
    )
    volume_snapshot_hashes = runtime_qualification.get("volumeSnapshotHashes")
    expected_snapshot_hashes = sorted(
        artifact["snapshotSealHash"] for artifact in model_artifacts.values()
    )
    checked(
        volume_snapshot_hashes == expected_snapshot_hashes,
        "runtime qualification volume snapshots differ",
    )
    qualification_dependency_hash = checked_hash(
        runtime_qualification.get("dependencyInventoryHash"),
        "qualification dependency inventory hash",
    )
    checked(
        qualification_dependency_hash == manifest["dependencyInventoryHash"],
        "qualification dependency inventory differs from the runtime manifest",
    )
    checked(
        request_binding.get("modalImageId") == runtime_modal_image_id,
        "request Modal image ID differs from the executing container",
    )
    checked(request_binding.get("runtimeImageHash") == manifest_hash, "request runtime image hash differs")
    checked(
        request_binding.get("dependencyInventoryHash") == qualification_dependency_hash,
        "request dependency inventory differs",
    )
    checked(
        request_binding.get("workerImplementationHash") == worker_hash,
        "request worker implementation hash differs",
    )
    for binding_key in (
        "modalImageId",
        "runtimeImageHash",
        "workerImplementationHash",
        "dependencyInventoryHash",
        "dinoV3TermsSnapshotHash",
        "modelIdentityHash",
        "termsSnapshotHash",
        "egressPolicyHash",
        "inputPolicyHash",
    ):
        qualification_key = (
            "modelTermsSnapshotHash" if binding_key == "termsSnapshotHash" else binding_key
        )
        checked(
            request_binding.get(binding_key) == runtime_qualification.get(qualification_key),
            f"request runtime binding {binding_key} differs from its qualification",
        )
    checked(
        hashlib.sha256(worker_path.read_bytes()).hexdigest() == worker_hash,
        "runtime worker bytes differ from the image manifest",
    )

    with tempfile.TemporaryDirectory(prefix="basalt-trellis2-modal-") as directory:
        root = Path(directory)
        request_path = root / "request.json"
        reference_path = root / "reference.png"
        tensor_path = root / "candidate.safetensors"
        report_path = root / "worker-result.json"
        request_path.write_bytes(request_bytes)
        reference_path.write_bytes(reference_bytes)
        environment = dict(os.environ)
        environment.pop("BASALT_TRELLIS2_PAID_RUN_AUTHORIZATION", None)
        environment.update(
            {
                "BASALT_TRELLIS2_RUNTIME_EGRESS": "denied",
                "BASALT_TRELLIS2_NETWORK_NAMESPACE": "denied",
                "BASALT_TRELLIS2_SOURCE_COMMIT": source_commit,
                "BASALT_TRELLIS2_MODAL_IMAGE_ID": runtime_modal_image_id,
                "BASALT_TRELLIS2_RUNTIME_IMAGE_HASH": manifest_hash,
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "DIFFUSERS_OFFLINE": "1",
            }
        )
        try:
            completed = subprocess.run(
                [
                    str(worker_path),
                    "--execute",
                    str(request_path),
                    str(reference_path),
                    str(source_root),
                    str(model_root),
                    str(sparse_decoder_root),
                    str(dino_root),
                    str(tensor_path),
                    str(report_path),
                    worker_hash,
                ],
                check=False,
                capture_output=True,
                env=environment,
                timeout=subprocess_timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            stderr = error.stderr or b""
            stdout = error.stdout or b""
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", errors="replace")
            stages = f"{stdout}\n{stderr}"[-16_384:]
            raise TimeoutError(
                f"TRELLIS.2 worker exceeded {subprocess_timeout_seconds}s; retained output: {stages}"
            ) from error
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace")[-4096:]
            raise RuntimeError(f"TRELLIS.2 worker failed with exit {completed.returncode}: {detail}")
        tensor_bytes = regular_file(tensor_path, maximum_tensor_bytes, "tensor result")
        report_bytes = regular_file(report_path, maximum_report_bytes, "worker report")
        report = decoded(report_bytes, maximum_report_bytes, "worker report")
        report_hash = checked_hash(report.get("hash"), "worker report hash")
        checked(
            identity({key: value for key, value in report.items() if key != "hash"}) == report_hash,
            "worker report identity is invalid",
        )
        checked(report.get("contract") == "basalt-trellis2-worker-result", "worker report contract differs")
        checked(
            report.get("requestHash") == request.get("neuralRequestHash"),
            "worker report neural request differs",
        )
        checked(report.get("workerRequestHash") == request_hash, "worker report request differs")
        execution_binding = report.get("executionBinding")
        checked(isinstance(execution_binding, dict), "worker execution binding is absent")
        checked(
            execution_binding.get("modalImageId") == runtime_modal_image_id,
            "worker Modal image differs",
        )
        checked(execution_binding.get("runtimeImageHash") == manifest_hash, "worker runtime image differs")
        checked(
            execution_binding.get("workerImplementationHash") == worker_hash,
            "worker implementation hash differs",
        )
        checked(
            execution_binding.get("dependencyInventoryHash") == qualification_dependency_hash,
            "worker dependency inventory differs",
        )
        output = report.get("output")
        checked(isinstance(output, dict), "worker output report is absent")
        checked(output.get("mediaType") == "application/x-safetensors", "worker media type differs")
        checked(output.get("bytes") == len(tensor_bytes), "worker tensor byte count differs")
        tensor_hash = hashlib.sha256(tensor_bytes).hexdigest()
        checked(output.get("sha256") == tensor_hash, "worker tensor hash differs")
        runtime = report.get("runtime")
        checked(
            isinstance(runtime, dict)
            and runtime.get("networkNamespace") == "denied"
            and runtime.get("networkAttempted") is False
            and runtime.get("downloads") is False,
            "worker runtime isolation evidence is invalid",
        )
        remote_material = {
            "kind": "Trellis2RemoteOutputHandoff",
            "contract": "basalt-trellis2-remote-output-handoff",
            "requestHash": request_hash,
            "modalImageId": runtime_modal_image_id,
            "runtimeImageHash": manifest_hash,
            "outputVolume": "basalt-neural-output",
            "outputKey": output_key,
            "tensorPath": f"{output_key}/candidate.safetensors",
            "workerReportPath": f"{output_key}/worker-result.json",
            "workerReportHash": report_hash,
            "tensorSha256": tensor_hash,
            "tensorBytes": len(tensor_bytes),
            "workerReportBytes": len(report_bytes),
            "remoteInvocationOccurred": True,
        }
        remote_handoff = {**remote_material, "hash": identity(remote_material)}
        pending_root = output_root / f".{output_key}.pending-{uuid.uuid4().hex}"
        final_root = output_root / output_key
        checked(output_root.is_dir(), "neural output volume is absent")
        checked(not final_root.exists(), "this exact remote output already exists")
        pending_root.mkdir(mode=0o700)
        try:
            (pending_root / "candidate.safetensors").write_bytes(tensor_bytes)
            (pending_root / "worker-result.json").write_bytes(report_bytes)
            (pending_root / "remote-handoff.json").write_bytes(canonical(remote_handoff) + b"\n")
            pending_root.rename(final_root)
            OUTPUT_VOLUME.commit()
        except BaseException:
            for child in pending_root.glob("*"):
                child.unlink(missing_ok=True)
            pending_root.rmdir()
            raise
        return remote_handoff


def write_absent(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            path.unlink(missing_ok=True)
        finally:
            raise


def read_output_volume_file(path: str, maximum_bytes: int, label: str) -> bytes:
    require(
        re.fullmatch(
            r"[a-f0-9]{64}(?:--attempt-[a-f0-9]{16,64})?/(?:candidate\.safetensors|worker-result\.json|remote-handoff\.json)",
            path,
        )
        is not None,
        f"{label} path is invalid",
    )
    payload = bytearray()
    for chunk in OUTPUT_VOLUME.read_file(path):
        require(isinstance(chunk, bytes), f"{label} volume chunk is invalid")
        payload.extend(chunk)
        require(
            len(payload) <= maximum_bytes,
            f"{label} exceeds its byte bound ({len(payload)} > {maximum_bytes})",
        )
    require(len(payload) > 0, f"{label} is absent")
    return bytes(payload)


def claim_modal_attempt(
    output_root_value: str,
    request: dict[str, Any],
    new_attempt_override: str,
) -> tuple[Path, str | None]:
    output_root = Path(output_root_value).resolve(strict=True)
    require(stat.S_ISDIR(os.lstat(output_root).st_mode), "output root must be a directory")
    request_hash = require_sha256(request.get("hash"), "generation request hash")
    override = new_attempt_override
    if override:
        require(
            NEW_ATTEMPT_OVERRIDE_PATTERN.fullmatch(override) is not None,
            "new-attempt override must be 16 to 64 lowercase hexadecimal characters",
        )
    attempt_name = request_hash if not override else f"{request_hash}--attempt-{override}"
    job_root = output_root / attempt_name
    try:
        job_root.mkdir(mode=0o700)
    except FileExistsError as error:
        raise ValueError(
            "this exact paid attempt is already claimed; inspect its retained state before "
            "setting a fresh BASALT_TRELLIS2_NEW_ATTEMPT_OVERRIDE"
        ) from error
    material = {
        "kind": "Trellis2ModalAttemptClaim",
        "contract": "basalt-trellis2-modal-attempt-claim",
        "requestHash": request_hash,
        "attemptOverride": override or None,
        "state": "remote_result_unknown",
        "replayPolicy": "fail_closed",
    }
    claim = {**material, "hash": content_hash(material)}
    try:
        write_absent(job_root / "attempt-claim.json", canonical_bytes(claim) + b"\n")
    except BaseException:
        job_root.rmdir()
        raise
    return job_root, override or None


def retain_modal_handoff(
    job_root: Path,
    request: dict[str, Any],
    result: dict[str, Any],
) -> Path:
    require(job_root.is_absolute(), "claimed attempt directory must be absolute")
    require(stat.S_ISDIR(os.lstat(job_root).st_mode), "claimed attempt must be a directory")
    require((job_root / "attempt-claim.json").is_file(), "paid attempt claim is absent")
    request_hash = require_sha256(request.get("hash"), "generation request hash")
    require(
        set(result)
        == {
            "kind",
            "contract",
            "requestHash",
            "modalImageId",
            "runtimeImageHash",
            "outputVolume",
            "outputKey",
            "tensorPath",
            "workerReportPath",
            "workerReportHash",
            "tensorSha256",
            "tensorBytes",
            "workerReportBytes",
            "remoteInvocationOccurred",
            "hash",
        },
        "Modal result handoff shape differs",
    )
    require(result.get("kind") == "Trellis2RemoteOutputHandoff", "Modal result kind differs")
    require(result.get("contract") == REMOTE_HANDOFF_CONTRACT, "Modal result contract differs")
    remote_hash = require_sha256(result.get("hash"), "Modal result hash")
    require(
        content_hash({key: value for key, value in result.items() if key != "hash"}) == remote_hash,
        "Modal result identity is invalid",
    )
    require(result.get("requestHash") == request_hash, "Modal result request differs")
    output_key = job_root.name
    require(result.get("outputVolume") == OUTPUT_VOLUME_NAME, "Modal output volume differs")
    require(result.get("outputKey") == output_key, "Modal output key differs")
    expected_tensor_path = f"{output_key}/candidate.safetensors"
    expected_report_path = f"{output_key}/worker-result.json"
    require(result.get("tensorPath") == expected_tensor_path, "Modal tensor path differs")
    require(result.get("workerReportPath") == expected_report_path, "Modal report path differs")
    require(result.get("remoteInvocationOccurred") is True, "Modal result lacks remote execution evidence")
    retained_remote = read_output_volume_file(
        f"{output_key}/remote-handoff.json", MAX_REPORT_BYTES, "remote handoff"
    )
    require(
        retained_remote.rstrip(b"\n") == canonical_bytes(result),
        "retained remote handoff differs from the Modal response",
    )
    tensor_bytes = read_output_volume_file(expected_tensor_path, MAX_TENSOR_BYTES, "tensor result")
    report_bytes = read_output_volume_file(expected_report_path, MAX_REPORT_BYTES, "worker report")
    require(result.get("tensorBytes") == len(tensor_bytes), "Modal tensor byte count differs")
    require(result.get("workerReportBytes") == len(report_bytes), "Modal report byte count differs")
    report = validate_worker_outputs(
        request,
        {
            "modalImageId": result.get("modalImageId"),
            "hash": result.get("runtimeImageHash"),
            "workerImplementationHash": request["runtimeBinding"]["workerImplementationHash"],
            "dependencyInventoryHash": request["runtimeBinding"]["dependencyInventoryHash"],
        },
        tensor_bytes,
        report_bytes,
    )
    require(result.get("workerReportHash") == report["hash"], "Modal worker report hash differs")
    require(result.get("tensorSha256") == report["output"]["sha256"], "Modal tensor hash differs")
    require(
        result.get("modalImageId") == RUNTIME_IMAGE_ID
        and result.get("modalImageId") == request["runtimeBinding"]["modalImageId"],
        "Modal result image ID differs from the configured request",
    )
    write_absent(job_root / "candidate.safetensors", tensor_bytes)
    write_absent(job_root / "worker-result.json", report_bytes)
    material = {
        "kind": "Trellis2ModalHandoff",
        "contract": HANDOFF_CONTRACT,
        "requestHash": request_hash,
        "modalApp": APP_NAME,
        "modalImageId": result["modalImageId"],
        "runtimeImageHash": result["runtimeImageHash"],
        "modelVolume": MODEL_VOLUME_NAME,
        "sparseDecoderVolume": SPARSE_DECODER_VOLUME_NAME,
        "dinoV3Volume": DINOV3_VOLUME_NAME,
        "outputVolume": OUTPUT_VOLUME_NAME,
        "remoteOutputKey": output_key,
        "remoteTensorPath": expected_tensor_path,
        "remoteWorkerReportPath": expected_report_path,
        "remoteHandoffHash": remote_hash,
        "workerReportHash": report["hash"],
        "tensorSha256": report["output"]["sha256"],
        "tensorBytes": len(tensor_bytes),
        "hostAdmission": "retainTrellis2WorkerCandidate",
        "remoteInvocationOccurred": True,
    }
    handoff = {**material, "hash": content_hash(material)}
    write_absent(job_root / "modal-handoff.json", canonical_bytes(handoff) + b"\n")
    return job_root


@app.local_entrypoint()
def main(
    request: str = "",
    runtime_qualification: str = "",
    reference: str = "",
    output_root: str = "",
    execution_flag: str = "",
    new_attempt_override: str = "",
) -> None:
    if execution_flag != EXECUTION_LITERAL:
        print(canonical_bytes(local_contract()).decode("utf-8"))
        return
    require(
        request != ""
        and runtime_qualification != ""
        and reference != ""
        and output_root != "",
        "request, runtime qualification, reference, and output paths are required",
    )
    execution_gate = os.environ.get(LOCAL_GATE_ENV, "")
    require(len(execution_gate) >= 32, f"{LOCAL_GATE_ENV} must be exported outside the repository")
    execution_gate_commitment = hashlib.sha256(execution_gate.encode("utf-8")).hexdigest()
    del execution_gate
    request_bytes = read_regular_file(request, MAX_REQUEST_BYTES, "generation request")
    runtime_qualification_bytes = read_regular_file(
        runtime_qualification,
        MAX_REQUEST_BYTES,
        "runtime qualification",
    )
    reference_bytes = read_regular_file(reference, MAX_REFERENCE_BYTES, "reference")
    request_value = decode_canonical_json(request_bytes, MAX_REQUEST_BYTES, "generation request")
    qualification_value = decode_canonical_json(
        runtime_qualification_bytes,
        MAX_REQUEST_BYTES,
        "runtime qualification",
    )
    require(
        request_value.get("runtimeQualificationHash") == qualification_value.get("hash"),
        "generation request does not bind the supplied runtime qualification",
    )
    validate_reference(request_value, reference_bytes)
    claimed_root, _override = claim_modal_attempt(
        output_root,
        request_value,
        new_attempt_override,
    )
    result = execute_qualified_asset.remote(
        request_bytes,
        runtime_qualification_bytes,
        reference_bytes,
        claimed_root.name,
        execution_flag,
        execution_gate_commitment,
    )
    retained = retain_modal_handoff(claimed_root, request_value, result)
    print(str(retained))
