#!/usr/bin/env python3
"""Modal execution adapter for the catalog qualification pilot.

The catalog job and worker output remain provider-neutral JSON artifacts. This
module only transports the exact selected evidence to a bounded, single-GPU
worker. Credentials are process environment inputs and never enter either
artifact.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath
from typing import Any

import modal


APP_NAME = "basalt-catalog-qualification-pilot"
EVIDENCE_VOLUME_NAME = "basalt-catalog-pilot"
MODEL_VOLUME_NAME = "basalt-catalog-model-cache"
EVIDENCE_ROOT = Path("/mnt/catalog-pilot")
MODEL_ROOT = Path("/mnt/catalog-models")
REMOTE_WORKER = Path("/root/pilot.py")
MAX_JOB_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_EVIDENCE_BYTES = 64 * 1024 * 1024
MAX_FILES = 25_000


def require_environment(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"Required execution credential {name} is not configured")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(value: bytes | str) -> str:
    material = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(material).hexdigest()


def bounded_regular_file(root: Path, raw: str, maximum_bytes: int) -> Path:
    candidate = (root / raw).resolve(strict=True)
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Path escapes the workspace: {raw}")
    metadata = os.lstat(candidate)
    if not stat.S_ISREG(metadata.st_mode) or candidate.is_symlink():
        raise ValueError(f"Path is not a regular no-follow file: {raw}")
    if metadata.st_size <= 0 or metadata.st_size > maximum_bytes:
        raise ValueError(f"File exceeds its bounded size: {raw}")
    return candidate


def safe_relative_path(raw: str) -> str:
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Remote path is not workspace-relative: {raw}")
    return path.as_posix()


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise ValueError(f"Refusing unsafe output replacement: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


PILOT_WORKER = Path(__file__).with_name("pilot.py")
IMAGE = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "torch==2.9.1",
        "torchvision==0.24.1",
        "transformers==4.57.3",
        "huggingface-hub==0.36.0",
        "safetensors==0.7.0",
        "Pillow==11.3.0",
        "sentencepiece==0.2.1",
    )
    .add_local_file(PILOT_WORKER, str(REMOTE_WORKER), copy=True)
)
EVIDENCE_VOLUME = modal.Volume.from_name(EVIDENCE_VOLUME_NAME, create_if_missing=True)
MODEL_VOLUME = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
HUGGING_FACE_TOKEN = require_environment("HUGGINGFACE_TOKEN")
HUGGING_FACE_SECRET = modal.Secret.from_dict(
    {
        "HF_TOKEN": HUGGING_FACE_TOKEN,
        "HUGGINGFACE_TOKEN": HUGGING_FACE_TOKEN,
        "HF_HOME": str(MODEL_ROOT),
    }
)
# Modal mounts only this entrypoint file for a file-backed function. The corpus
# remains outside the source mount and crosses the boundary through the volume.
app = modal.App(APP_NAME, include_source=True)


@app.function(
    image=IMAGE,
    gpu="L40S",
    cpu=4.0,
    memory=32 * 1024,
    volumes={str(EVIDENCE_ROOT): EVIDENCE_VOLUME, str(MODEL_ROOT): MODEL_VOLUME},
    secrets=[HUGGING_FACE_SECRET],
    min_containers=0,
    max_containers=1,
    buffer_containers=0,
    scaledown_window=60,
    retries=0,
    timeout=60 * 60,
    startup_timeout=10 * 60,
    single_use_containers=True,
    include_source=True,
)
def execute(job_hash: str, job_relative_path: str, output_relative_path: str) -> dict[str, Any]:
    """Execute one exact job and return only a verified output descriptor."""
    import subprocess
    from huggingface_hub import snapshot_download

    if len(job_hash) != 64 or any(character not in "0123456789abcdef" for character in job_hash):
        raise ValueError("Pilot job hash is invalid")
    job_relative_path = safe_relative_path(job_relative_path)
    output_relative_path = safe_relative_path(output_relative_path)
    workspace = EVIDENCE_ROOT / "runs" / job_hash / "workspace"
    job_path = workspace / job_relative_path
    output_path = workspace / output_relative_path
    job = json.loads(job_path.read_text(encoding="utf-8"))
    material = {key: value for key, value in job.items() if key != "hash"}
    if job.get("hash") != job_hash or digest(canonical_json(material)) != job_hash:
        raise ValueError("Remote pilot job identity is invalid")
    for model in job.get("models", []):
        if model.get("source") != "huggingface":
            continue
        snapshot_download(
            repo_id=model["repository"],
            revision=model["revision"],
            token=os.environ["HF_TOKEN"],
        )
    MODEL_VOLUME.commit()
    environment = {
        **os.environ,
        "HF_HOME": str(MODEL_ROOT),
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_OFFLINE": "1",
        "BASALT_EXECUTION_ADAPTER": "modal",
        "BASALT_GPU_KIND": "L40S",
    }
    subprocess.run(
        [
            "python3",
            str(REMOTE_WORKER),
            "--job",
            str(job_path),
            "--output",
            str(output_path),
        ],
        cwd=workspace,
        env=environment,
        check=True,
        timeout=55 * 60,
    )
    payload = output_path.read_bytes()
    if not payload or len(payload) > MAX_OUTPUT_BYTES:
        raise ValueError("Pilot worker output exceeds its transport bound")
    EVIDENCE_VOLUME.commit()
    MODEL_VOLUME.commit()
    return {
        "kind": "CatalogPilotModalExecution",
        "jobHash": job_hash,
        "outputRelativePath": output_relative_path,
        "outputBytes": len(payload),
        "outputBytesHash": digest(payload),
        "gpu": "L40S",
        "maxContainers": 1,
    }


@app.local_entrypoint()
def main(job: str, output: str) -> None:
    root = Path.cwd().resolve()
    job_path = bounded_regular_file(root, job, MAX_JOB_BYTES)
    output_path = (root / output).resolve()
    if output_path != root and root not in output_path.parents:
        raise ValueError("Pilot output escapes the workspace")
    job_value = json.loads(job_path.read_text(encoding="utf-8"))
    material = {key: value for key, value in job_value.items() if key != "hash"}
    job_hash = job_value.get("hash")
    if not isinstance(job_hash, str) or digest(canonical_json(material)) != job_hash:
        raise ValueError("Local pilot job identity is invalid")
    job_relative_path = job_path.relative_to(root).as_posix()
    output_relative_path = output_path.relative_to(root).as_posix()
    evidence_paths = {job_relative_path}
    for item in job_value.get("items", []):
        for view in item.get("views", []):
            evidence_paths.add(safe_relative_path(view["rgbRelativePath"]))
            evidence_paths.add(safe_relative_path(view["normalizedDepthRelativePath"]))
    if len(evidence_paths) > MAX_FILES:
        raise ValueError("Pilot evidence exceeds its file-count bound")
    remote_workspace = f"/runs/{job_hash}/workspace"
    print(
        canonical_json(
            {
                "stage": "modal_upload",
                "files": len(evidence_paths),
                "jobHash": job_hash,
            }
        ),
        flush=True,
    )
    with EVIDENCE_VOLUME.batch_upload(force=True) as upload:
        for relative_path in sorted(evidence_paths):
            local_path = bounded_regular_file(root, relative_path, MAX_EVIDENCE_BYTES)
            upload.put_file(str(local_path), f"{remote_workspace}/{relative_path}")
    descriptor = execute.remote(job_hash, job_relative_path, output_relative_path)
    remote_output = f"runs/{job_hash}/workspace/{output_relative_path}"
    payload = b"".join(EVIDENCE_VOLUME.read_file(remote_output))
    if (
        len(payload) != descriptor["outputBytes"]
        or digest(payload) != descriptor["outputBytesHash"]
    ):
        raise ValueError("Downloaded Modal result differs from its execution descriptor")
    atomic_write(output_path, payload)
    EVIDENCE_VOLUME.remove_file(f"runs/{job_hash}", recursive=True)
    print(canonical_json({**descriptor, "stage": "modal_complete"}), flush=True)
