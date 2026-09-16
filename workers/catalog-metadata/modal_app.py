#!/usr/bin/env python3
"""Modal transport for bounded catalog-metadata worker jobs.

Modal is execution infrastructure only. Jobs and outputs remain provider-neutral,
content-addressed JSON and never contain credentials or Modal identifiers.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

import modal

APP_NAME = "basalt-catalog-metadata"
EVIDENCE_ROOT = Path("/mnt/catalog-metadata")
MODEL_ROOT = Path("/mnt/catalog-models")
REMOTE_WORKER = Path("/opt/basalt/catalog-metadata-worker.py")
MAX_JOB_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_EVIDENCE_BYTES = 64 * 1024 * 1024
MAX_EVIDENCE_FILES = 192
MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_TRANSPORT_BYTES = 128 * 1024 * 1024

TYPESCRIPT_ARTIFACT_HASH_PROGRAM = r"""
const crypto = require("node:crypto");
const fs = require("node:fs");
const [path, excludedKey] = process.argv.slice(1);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
delete value[excludedKey];
const normalize = (entry) => {
  if (Array.isArray(entry)) return entry.map(normalize);
  if (entry !== null && typeof entry === "object") {
    return Object.fromEntries(
      Object.keys(entry).sort().filter((key) => entry[key] !== undefined)
        .map((key) => [key, normalize(entry[key])]),
    );
  }
  return entry;
};
process.stdout.write(
  crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex"),
);
"""


def required_environment(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"Required execution credential {name} is not configured")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(value: bytes | str) -> str:
    material = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(material).hexdigest()


def typescript_artifact_hash(path: Path, excluded_key: str = "hash") -> str:
    result = subprocess.run(
        ["node", "-e", TYPESCRIPT_ARTIFACT_HASH_PROGRAM, str(path), excluded_key],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    value = result.stdout.strip()
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError("TypeScript artifact hash helper returned an invalid digest")
    return value


def safe_relative_path(raw: str) -> str:
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Path is not workspace-relative: {raw}")
    return path.as_posix()


def bounded_regular_file(root: Path, raw: str, maximum_bytes: int) -> Path:
    candidate = (root / raw).resolve(strict=True)
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Path escapes the workspace: {raw}")
    metadata = os.lstat(candidate)
    if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"Path is not a regular no-follow file: {raw}")
    if metadata.st_size <= 0 or metadata.st_size > maximum_bytes:
        raise ValueError(f"File exceeds its bounded size: {raw}")
    return candidate


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise ValueError(f"Refusing unsafe output replacement: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


WORKER_SOURCE = Path(__file__).with_name("worker.py")
IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("nodejs")
    .pip_install(
        "vllm==0.11.0",
        "transformers==4.57.3",
        "huggingface-hub==0.36.0",
        "safetensors==0.7.0",
        "Pillow==11.3.0",
        "sentencepiece==0.2.1",
    )
    .add_local_file(WORKER_SOURCE, str(REMOTE_WORKER), copy=True)
)
EVIDENCE_VOLUME = modal.Volume.from_name("basalt-catalog-metadata", create_if_missing=True)
MODEL_VOLUME = modal.Volume.from_name("basalt-catalog-model-cache", create_if_missing=True)
HF_SECRET = modal.Secret.from_dict(
    {
        "HF_TOKEN": required_environment("HUGGINGFACE_TOKEN"),
        "HUGGINGFACE_TOKEN": required_environment("HUGGINGFACE_TOKEN"),
        "HF_HOME": str(MODEL_ROOT),
    }
)
app = modal.App(APP_NAME, include_source=True)


def execute_remote(job_hash: str, job_relative_path: str, output_relative_path: str, accelerator: str) -> dict[str, Any]:
    if len(job_hash) != 64 or any(character not in "0123456789abcdef" for character in job_hash):
        raise ValueError("Catalog metadata job hash is invalid")
    job_relative_path = safe_relative_path(job_relative_path)
    output_relative_path = safe_relative_path(output_relative_path)
    workspace = EVIDENCE_ROOT / "runs" / job_hash / "workspace"
    job_path = workspace / job_relative_path
    output_path = workspace / output_relative_path
    job = json.loads(job_path.read_text(encoding="utf-8"))
    if job.get("hash") != job_hash or typescript_artifact_hash(job_path) != job_hash:
        raise ValueError("Remote catalog metadata job identity is invalid")
    environment = {
        **os.environ,
        "HF_HOME": str(MODEL_ROOT),
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONDONTWRITEBYTECODE": "1",
        "BASALT_EXECUTION_ADAPTER": "modal",
        "BASALT_GPU_KIND": accelerator,
        "OMP_NUM_THREADS": "4",
        "MKL_NUM_THREADS": "4",
    }
    try:
        subprocess.run(
            ["python3", str(REMOTE_WORKER), "--job", str(job_path), "--output", str(output_path)],
            cwd=workspace,
            env=environment,
            check=True,
            timeout=110 * 60,
        )
    finally:
        # A failed shard may still contain valid per-item checkpoints. Persist them so
        # the identical content-addressed job can continue rather than restart.
        EVIDENCE_VOLUME.commit()
        MODEL_VOLUME.commit()
    payload = output_path.read_bytes()
    if not payload or len(payload) > MAX_OUTPUT_BYTES:
        raise ValueError("Catalog metadata worker output exceeds its transport bound")
    return {
        "jobHash": job_hash,
        "outputRelativePath": output_relative_path,
        "outputBytes": len(payload),
        "outputBytesHash": digest(payload),
    }


FUNCTION_OPTIONS = {
    "image": IMAGE,
    "cpu": 4.0,
    "memory": 64 * 1024,
    "volumes": {str(EVIDENCE_ROOT): EVIDENCE_VOLUME, str(MODEL_ROOT): MODEL_VOLUME},
    "secrets": [HF_SECRET],
    "min_containers": 0,
    "max_containers": 1,
    "buffer_containers": 0,
    "scaledown_window": 2,
    "retries": 0,
    "timeout": 2 * 60 * 60,
    "startup_timeout": 20 * 60,
    "single_use_containers": True,
    "include_source": True,
}


@app.function(**FUNCTION_OPTIONS)
def execute_gpu(
    job_hash: str,
    job_relative_path: str,
    output_relative_path: str,
    accelerator: str,
) -> dict[str, Any]:
    return execute_remote(job_hash, job_relative_path, output_relative_path, accelerator)


def evidence_paths(job: dict[str, Any], job_relative_path: str) -> list[str]:
    paths: set[str] = set()
    for item in job.get("items", []):
        for view in item.get("views", []):
            if "rgbRelativePath" in view:
                paths.add(safe_relative_path(view["rgbRelativePath"]))
            if "normalizedDepthRelativePath" in view:
                paths.add(safe_relative_path(view["normalizedDepthRelativePath"]))
    for candidate in job.get("candidateEvidence", []):
        if "contactSheetRelativePath" in candidate:
            paths.add(safe_relative_path(candidate["contactSheetRelativePath"]))
    result = sorted(paths)
    if len(result) > MAX_EVIDENCE_FILES:
        raise ValueError("Catalog metadata job exceeds its evidence file-count bound")
    return [job_relative_path, *result]


def expected_evidence_sizes(job: dict[str, Any]) -> dict[str, int]:
    result: dict[str, int] = {}
    for item in job.get("items", []):
        for view in item.get("views", []):
            for path_field, size_field in (
                ("rgbRelativePath", "rgbSizeBytes"),
                ("normalizedDepthRelativePath", "normalizedDepthSizeBytes"),
            ):
                if path_field not in view:
                    continue
                path = safe_relative_path(view[path_field])
                size = view[size_field]
                previous = result.get(path)
                if previous is not None and previous != size:
                    raise ValueError(f"Conflicting sealed sizes for evidence path: {path}")
                result[path] = size
    for candidate in job.get("candidateEvidence", []):
        if "contactSheetRelativePath" not in candidate:
            continue
        path = safe_relative_path(candidate["contactSheetRelativePath"])
        size = candidate["contactSheetSizeBytes"]
        previous = result.get(path)
        if previous is not None and previous != size:
            raise ValueError(f"Conflicting sealed sizes for evidence path: {path}")
        result[path] = size
    return result


def requested_accelerator(job: dict[str, Any]) -> str:
    model = job.get("model")
    if isinstance(model, dict):
        return model["accelerator"]
    models = job.get("models", [])
    accelerators = {entry["accelerator"] for entry in models}
    if len(accelerators) == 1:
        accelerator = next(iter(accelerators))
        if accelerator in ("L40S", "A100-80GB"):
            return accelerator
    raise ValueError("One worker job must target exactly one declared accelerator")


@app.local_entrypoint()
def main(job: str, output: str) -> None:
    root = Path.cwd().resolve()
    job_path = bounded_regular_file(root, job, MAX_JOB_BYTES)
    output_path = (root / output).resolve()
    if output_path != root and root not in output_path.parents:
        raise ValueError("Catalog metadata output escapes the workspace")
    job_value = json.loads(job_path.read_text(encoding="utf-8"))
    job_hash = job_value.get("hash")
    if not isinstance(job_hash, str) or typescript_artifact_hash(job_path) != job_hash:
        raise ValueError("Local catalog metadata job identity is invalid")
    job_relative_path = job_path.relative_to(root).as_posix()
    output_relative_path = output_path.relative_to(root).as_posix()
    paths = evidence_paths(job_value, job_relative_path)
    local_evidence = [bounded_regular_file(root, path, MAX_EVIDENCE_BYTES) for path in paths]
    expected_sizes = expected_evidence_sizes(job_value)
    for path, local_path in zip(paths[1:], local_evidence[1:], strict=True):
        if local_path.stat().st_size != expected_sizes[path]:
            raise ValueError(f"Evidence size differs from its sealed input budget: {path}")
    unique_evidence_bytes = sum(path.stat().st_size for path in local_evidence[1:])
    budget = job_value.get("inputBudget")
    if budget is not None:
        if budget["evidenceFileCount"] > MAX_EVIDENCE_FILES:
            raise ValueError("Catalog metadata shard exceeds its evidence file-count bound")
        if budget["evidenceBytes"] > MAX_EVIDENCE_TOTAL_BYTES:
            raise ValueError("Catalog metadata shard exceeds its evidence-byte bound")
        if unique_evidence_bytes > budget["evidenceBytes"]:
            raise ValueError("Catalog metadata shard references unbudgeted evidence bytes")
    total_bytes = sum(path.stat().st_size for path in local_evidence)
    if total_bytes > MAX_TRANSPORT_BYTES:
        raise ValueError("Catalog metadata shard exceeds its aggregate transport-byte bound")
    remote_workspace = f"/runs/{job_hash}/workspace"
    print(canonical_json({"stage": "modal_upload", "files": len(paths), "jobHash": job_hash}), flush=True)
    with EVIDENCE_VOLUME.batch_upload(force=True) as upload:
        for relative_path, local_path in zip(paths, local_evidence, strict=True):
            upload.put_file(str(local_path), f"{remote_workspace}/{relative_path}")
    accelerator = requested_accelerator(job_value)
    # One dynamically configured function plus single-use containers prevents the
    # L40S and A100 routes from retaining independent warm GPU pools. Calls are
    # synchronous, so this entrypoint can own at most one GPU container globally.
    descriptor = execute_gpu.with_options(
        gpu=accelerator,
        max_containers=1,
        buffer_containers=0,
        scaledown_window=2,
    ).remote(
        job_hash,
        job_relative_path,
        output_relative_path,
        accelerator,
    )
    remote_output = f"runs/{job_hash}/workspace/{output_relative_path}"
    payload = b"".join(EVIDENCE_VOLUME.read_file(remote_output))
    if len(payload) != descriptor["outputBytes"] or digest(payload) != descriptor["outputBytesHash"]:
        raise ValueError("Downloaded Modal result differs from its execution descriptor")
    atomic_write(output_path, payload)
    EVIDENCE_VOLUME.remove_file(f"runs/{job_hash}", recursive=True)
    print(canonical_json({"stage": "modal_complete", **descriptor}), flush=True)
