#!/usr/bin/env python3
"""One-shot Modal evaluation runner for Qwen Image Edit 2511 composition."""

from __future__ import annotations

import argparse
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
from typing import Any


APP_NAME = "basalt-qwen-image-edit-2511-evaluation"
CONTRACT_ABI = "basalt-qwen-image-edit-2511-modal-evaluation@1"
REMOTE_HANDOFF_ABI = "basalt-reference-image-remote-output-handoff@1"
LOCAL_HANDOFF_ABI = "basalt-reference-image-modal-handoff@1"
EXECUTION_LITERAL = "RUN_ONE_BASALT_QWEN_IMAGE_EDIT_2511_EVALUATION_SMOKE"
LOCAL_GATE_ENV = "BASALT_REFERENCE_IMAGE_EVALUATION_AUTHORIZATION"
MODAL_GATE_SECRET_NAME = "basalt-reference-image-evaluation-gate"
IMAGE_ID_ENV = "BASALT_QWEN_IMAGE_EDIT_2511_MODAL_IMAGE_ID"
GPU_KIND = "A100-80GB"
QWEN_SOURCE_COMMIT = "6b5e1f5cec987d404be5ac6657db3b9aacb56a89"
QWEN_MODEL_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
QWEN_SOURCE_VOLUME_NAME = f"basalt-qwen-image-source-{QWEN_SOURCE_COMMIT[:16]}"
QWEN_MODEL_VOLUME_NAME = f"basalt-qwen-image-edit-2511-model-{QWEN_MODEL_REVISION[:16]}"
OUTPUT_VOLUME_NAME = "basalt-neural-output"
QWEN_SOURCE_ROOT = "/mnt/basalt-neural-input/qwen-image-source"
QWEN_MODEL_ROOT = "/mnt/basalt-neural-input/qwen-image-edit-2511-model"
OUTPUT_ROOT = "/mnt/basalt-neural-output"
RUNTIME_MANIFEST = "/opt/basalt/qwen-runtime-manifest.json"
WORKER = "/opt/basalt/reference-image-worker.py"
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 256 * 1024 * 1024
MODAL_IMAGE_ID = re.compile(r"^im-[A-Za-z0-9]+$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
OUTPUT_KEY = re.compile(r"^[a-f0-9]{64}--evaluation-[a-f0-9]{16}$")


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


def read_regular(path_value: str | Path, maximum: int, label: str) -> bytes:
    path = Path(path_value)
    resolved = path.resolve(strict=True)
    require(resolved == path.absolute(), f"{label} path must be canonical")
    metadata = os.lstat(resolved)
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
    require(0 < metadata.st_size <= maximum, f"{label} exceeds its byte bound")
    return resolved.read_bytes()


def decode_canonical(payload: bytes, label: str) -> dict[str, Any]:
    value = json.loads(payload.decode("utf-8"))
    require(isinstance(value, dict), f"{label} must be a JSON object")
    require(payload.rstrip(b"\n") == canonical_bytes(value), f"{label} must be canonical JSON")
    value_hash = value.get("hash")
    require(isinstance(value_hash, str) and SHA256.fullmatch(value_hash) is not None, f"{label} hash is invalid")
    require(
        content_hash({key: entry for key, entry in value.items() if key != "hash"}) == value_hash,
        f"{label} identity differs",
    )
    return value


def validate_inputs(
    request_bytes: bytes,
    authorization_bytes: bytes,
    context_bytes: bytes,
    protected_mask_bytes: bytes,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    request = decode_canonical(request_bytes, "request")
    authorization = decode_canonical(authorization_bytes, "authorization")
    require(request.get("abi") == "basalt-reference-image-worker-request@5", "request ABI differs")
    require(request.get("producerId") == "qwen_image_edit_2511", "request producer differs")
    require(request.get("route") == "region_composition", "request route differs")
    require(request.get("executionScope") == "evaluation_smoke", "request scope differs")
    require(
        authorization.get("abi") == "basalt-reference-image-evaluation-smoke-authorization@1",
        "authorization ABI differs",
    )
    require(authorization.get("requestHash") == request["hash"], "authorization request differs")
    require(authorization.get("producerId") == request["producerId"], "authorization producer differs")
    require(authorization.get("route") == request["route"], "authorization route differs")
    require(authorization.get("attemptId") == request["attemptId"], "authorization attempt differs")
    payload = request.get("payload")
    require(isinstance(payload, dict), "request payload is absent")
    for artifact, data, label in (
        (payload.get("contextRender"), context_bytes, "context"),
        (payload.get("protectedPixelMask"), protected_mask_bytes, "protected mask"),
    ):
        require(isinstance(artifact, dict), f"{label} artifact is absent")
        require(artifact.get("bytes") == len(data), f"{label} byte count differs")
        require(artifact.get("artifactHash") == hashlib.sha256(data).hexdigest(), f"{label} hash differs")
    output_key = f"{request['hash']}--evaluation-{authorization['hash'][:16]}"
    require(OUTPUT_KEY.fullmatch(output_key) is not None, "output key is invalid")
    return request, authorization, output_key


def write_absent(path: Path, payload: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def local_contract() -> dict[str, Any]:
    material = {
        "kind": "ReferenceImageModalEvaluationContract",
        "abi": CONTRACT_ABI,
        "status": "incomplete",
        "code": "remote_evaluation_not_invoked",
        "producerId": "qwen_image_edit_2511",
        "sourceCommit": QWEN_SOURCE_COMMIT,
        "modelRevision": QWEN_MODEL_REVISION,
        "modalImageIdConfigured": MODAL_IMAGE_ID.fullmatch(os.environ.get(IMAGE_ID_ENV, "")) is not None,
        "sourceVolume": QWEN_SOURCE_VOLUME_NAME,
        "modelVolume": QWEN_MODEL_VOLUME_NAME,
        "outputVolume": OUTPUT_VOLUME_NAME,
        "executionLiteral": EXECUTION_LITERAL,
        "evaluationOnly": True,
        "remoteInvocationOccurred": False,
        "gpuAllocated": False,
        "modelWillRun": False,
    }
    return {**material, "hash": content_hash(material)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("direct execution supports only --local-probe; use `modal run` for evaluation")
    print(canonical_bytes(local_contract()).decode("utf-8"))
    raise SystemExit(0)


import modal  # type: ignore[import-not-found]  # noqa: E402
import sys  # noqa: E402
from modal._vendor import cloudpickle  # type: ignore[import-not-found]  # noqa: E402


runtime_image_id = os.environ.get(IMAGE_ID_ENV, "")
require(MODAL_IMAGE_ID.fullmatch(runtime_image_id) is not None, f"{IMAGE_ID_ENV} is invalid")
RUNTIME_IMAGE = modal.Image.from_id(runtime_image_id)
QWEN_SOURCE_VOLUME = modal.Volume.from_name(QWEN_SOURCE_VOLUME_NAME, create_if_missing=False)
QWEN_MODEL_VOLUME = modal.Volume.from_name(QWEN_MODEL_VOLUME_NAME, create_if_missing=False)
OUTPUT_VOLUME = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
EXECUTION_GATE = modal.Secret.from_name(MODAL_GATE_SECRET_NAME, required_keys=[LOCAL_GATE_ENV])
app = modal.App(APP_NAME, include_source=False)

# `include_source=False` is intentional: the qualified inference worker is
# already sealed inside the immutable image. Carry this thin Modal transport by
# value so remote deserialization never imports the host-only `modal_qwen`
# module. This also covers every helper referenced by the serialized callable.
cloudpickle.register_pickle_by_value(sys.modules[__name__])


@app.function(
    serialized=True,
    image=RUNTIME_IMAGE,
    gpu=GPU_KIND,
    cpu=(4.0, 8.0),
    memory=(48 * 1024, 96 * 1024),
    volumes={
        QWEN_SOURCE_ROOT: QWEN_SOURCE_VOLUME.with_mount_options(read_only=True),
        QWEN_MODEL_ROOT: QWEN_MODEL_VOLUME.with_mount_options(read_only=True),
        OUTPUT_ROOT: OUTPUT_VOLUME,
    },
    secrets=[EXECUTION_GATE],
    min_containers=0,
    max_containers=1,
    buffer_containers=0,
    scaledown_window=60,
    retries=0,
    timeout=900,
    startup_timeout=180,
    block_network=True,
    restrict_modal_access=True,
    single_use_containers=True,
    include_source=False,
)
@modal.concurrent(max_inputs=1)
def execute_evaluation_smoke(
    request_bytes: bytes,
    authorization_bytes: bytes,
    context_bytes: bytes,
    protected_mask_bytes: bytes,
    execution_literal: str,
    gate_commitment: str,
) -> dict[str, Any]:
    require(execution_literal == EXECUTION_LITERAL, "execution literal differs")
    retained_gate = os.environ.get(LOCAL_GATE_ENV, "")
    require(len(retained_gate) >= 32, "execution gate is absent")
    require(
        hmac.compare_digest(
            gate_commitment,
            hashlib.sha256(retained_gate.encode("utf-8")).hexdigest(),
        ),
        "execution gate commitment differs",
    )
    request, authorization, output_key = validate_inputs(
        request_bytes, authorization_bytes, context_bytes, protected_mask_bytes
    )
    output_root = Path(OUTPUT_ROOT)
    require(output_root.is_dir(), "output Volume is absent")
    final_root = output_root / output_key
    require(not final_root.exists(), "this one-shot evaluation output already exists")
    with tempfile.TemporaryDirectory(prefix="basalt-qwen-evaluation-") as temporary:
        work = Path(temporary)
        request_path = work / "request.json"
        authorization_path = work / "authorization.json"
        context_path = work / "context.png"
        mask_path = work / "protected-mask.png"
        output_path = work / "output.png"
        model_output_path = work / "model-output.png"
        receipt_path = work / "worker-receipt.json"
        request_path.write_bytes(request_bytes)
        authorization_path.write_bytes(authorization_bytes)
        context_path.write_bytes(context_bytes)
        mask_path.write_bytes(protected_mask_bytes)
        environment = {
            **os.environ,
            "DIFFUSERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "BASALT_REFERENCE_IMAGE_RUNTIME_MANIFEST": RUNTIME_MANIFEST,
        }
        subprocess.run(
            [
                "python",
                WORKER,
                "--execute-evaluation-smoke",
                str(request_path),
                str(authorization_path),
                str(context_path),
                str(mask_path),
                str(output_path),
                str(model_output_path),
                str(receipt_path),
            ],
            check=True,
            env=environment,
            timeout=890,
        )
        output_bytes = output_path.read_bytes()
        model_output_bytes = model_output_path.read_bytes()
        receipt_bytes = receipt_path.read_bytes()
        receipt = decode_canonical(receipt_bytes, "worker receipt")
        require(receipt.get("requestHash") == request["hash"], "worker receipt request differs")
        require(
            receipt.get("evaluationAuthorizationHash") == authorization["hash"],
            "worker receipt authorization differs",
        )
        files = {
            "authorization.json": authorization_bytes,
            "model-output.png": model_output_bytes,
            "output.png": output_bytes,
            "worker-receipt.json": receipt_bytes,
        }
        remote_material = {
            "kind": "ReferenceImageRemoteOutputHandoff",
            "abi": REMOTE_HANDOFF_ABI,
            "producerId": "qwen_image_edit_2511",
            "requestHash": request["hash"],
            "authorizationHash": authorization["hash"],
            "modalImageId": runtime_image_id,
            "runtimeImageHash": request["executionBinding"]["runtimeImageHash"],
            "outputVolume": OUTPUT_VOLUME_NAME,
            "outputKey": output_key,
            "files": {
                name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
                for name, data in sorted(files.items())
            },
            "workerReceiptHash": receipt["hash"],
            "remoteInvocationOccurred": True,
        }
        remote = {**remote_material, "hash": content_hash(remote_material)}
        files["remote-handoff.json"] = canonical_bytes(remote) + b"\n"
        pending = output_root / f".{output_key}.pending-{uuid.uuid4().hex}"
        pending.mkdir(mode=0o700)
        try:
            for name, data in files.items():
                write_absent(pending / name, data)
            pending.rename(final_root)
        except BaseException:
            for child in pending.glob("*"):
                child.unlink(missing_ok=True)
            pending.rmdir()
            raise
        # Publish the atomic directory before the local entrypoint attempts a
        # bounded Volume read. Modal does not expose `reload()` from a local
        # entrypoint, and container-exit auto-commit happens too late here.
        OUTPUT_VOLUME.commit()
        return remote


def read_volume_file(path: str, maximum: int, label: str) -> bytes:
    require(
        re.fullmatch(
            r"[a-f0-9]{64}--evaluation-[a-f0-9]{16}/(?:authorization\.json|model-output\.png|output\.png|remote-handoff\.json|worker-receipt\.json)",
            path,
        )
        is not None,
        f"{label} path is invalid",
    )
    payload = bytearray()
    for chunk in OUTPUT_VOLUME.read_file(path):
        payload.extend(chunk)
        require(len(payload) <= maximum, f"{label} exceeds its byte bound")
    require(payload, f"{label} is absent")
    return bytes(payload)


@app.local_entrypoint()
def main(
    request: str = "",
    authorization: str = "",
    context: str = "",
    protected_mask: str = "",
    output_root: str = "",
    execution_literal: str = "",
) -> None:
    if execution_literal != EXECUTION_LITERAL:
        print(canonical_bytes(local_contract()).decode("utf-8"))
        return
    gate = os.environ.get(LOCAL_GATE_ENV, "")
    require(len(gate) >= 32, f"{LOCAL_GATE_ENV} must be exported outside the repository")
    gate_commitment = hashlib.sha256(gate.encode("utf-8")).hexdigest()
    del gate
    request_bytes = read_regular(request, MAX_JSON_BYTES, "request")
    authorization_bytes = read_regular(authorization, MAX_JSON_BYTES, "authorization")
    context_bytes = read_regular(context, MAX_IMAGE_BYTES, "context")
    protected_bytes = read_regular(protected_mask, MAX_IMAGE_BYTES, "protected mask")
    request_value, authorization_value, output_key = validate_inputs(
        request_bytes, authorization_bytes, context_bytes, protected_bytes
    )
    local_root = Path(output_root).resolve(strict=True)
    require(stat.S_ISDIR(os.lstat(local_root).st_mode), "local output root must be a directory")
    claimed = local_root / output_key
    claimed.mkdir(mode=0o700)
    claim_material = {
        "kind": "ReferenceImageEvaluationAttemptClaim",
        "abi": "basalt-reference-image-evaluation-attempt-claim@1",
        "requestHash": request_value["hash"],
        "authorizationHash": authorization_value["hash"],
        "state": "remote_result_unknown",
        "replayPolicy": "fail_closed",
    }
    write_absent(claimed / "attempt-claim.json", canonical_bytes({**claim_material, "hash": content_hash(claim_material)}) + b"\n")
    result = execute_evaluation_smoke.remote(
        request_bytes,
        authorization_bytes,
        context_bytes,
        protected_bytes,
        execution_literal,
        gate_commitment,
    )
    require(result.get("outputKey") == output_key, "remote output key differs")
    require(result.get("modalImageId") == runtime_image_id, "remote Modal image differs")
    result_hash = result.get("hash")
    require(
        isinstance(result_hash, str)
        and content_hash({key: value for key, value in result.items() if key != "hash"}) == result_hash,
        "remote handoff identity differs",
    )
    for name, record in result["files"].items():
        maximum = MAX_IMAGE_BYTES if name.endswith(".png") else MAX_JSON_BYTES
        data = read_volume_file(f"{output_key}/{name}", maximum, name)
        require(record == {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}, f"{name} differs")
        write_absent(claimed / name, data)
    retained_remote = read_volume_file(f"{output_key}/remote-handoff.json", MAX_JSON_BYTES, "remote handoff")
    require(retained_remote.rstrip(b"\n") == canonical_bytes(result), "retained remote handoff differs")
    write_absent(claimed / "remote-handoff.json", retained_remote)
    local_material = {
        "kind": "ReferenceImageModalHandoff",
        "abi": LOCAL_HANDOFF_ABI,
        "producerId": "qwen_image_edit_2511",
        "requestHash": request_value["hash"],
        "authorizationHash": authorization_value["hash"],
        "modalImageId": runtime_image_id,
        "runtimeImageHash": result["runtimeImageHash"],
        "outputVolume": OUTPUT_VOLUME_NAME,
        "remoteOutputKey": output_key,
        "remoteHandoffHash": result["hash"],
        "workerReceiptHash": result["workerReceiptHash"],
        "remoteInvocationOccurred": True,
    }
    write_absent(
        claimed / "modal-handoff.json",
        canonical_bytes({**local_material, "hash": content_hash(local_material)}) + b"\n",
    )
    print(str(claimed))
