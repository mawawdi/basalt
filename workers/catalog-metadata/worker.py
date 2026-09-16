#!/usr/bin/env python3
"""Provider adapter for Basalt catalog metadata, retrieval, and validation.

The worker consumes content-addressed, provider-neutral jobs. Its outputs are
review evidence only: this process cannot write semantic commitments, catalog
entries, admitted assertions, or source dispositions.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import io
import json
import math
import os
import resource
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

MAX_JOB_BYTES = 64 * 1024 * 1024
MAX_EVIDENCE_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_ITEMS = 8
MAX_VIEWS = 12
MAX_CONTEXT_CANDIDATES = 32
IMAGE_LONG_EDGE = 384
MAX_EVIDENCE_FILES = 192
MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_PREPROCESSED_PIXELS = MAX_EVIDENCE_FILES * IMAGE_LONG_EDGE * IMAGE_LONG_EDGE
VLM_MAX_MODEL_TOKENS = 8_192
VLM_MAX_OUTPUT_TOKENS = 4_096
VLM_GPU_MEMORY_UTILIZATION = 0.96

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


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


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


def digest(value: bytes | str) -> str:
    material = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(material).hexdigest()


def artifact_hash(value: dict[str, Any], hash_field: str = "hash") -> str:
    return digest(canonical_json({key: entry for key, entry in value.items() if key != hash_field}))


def bounded_json(path: Path) -> Any:
    status = path.lstat()
    if path.is_symlink() or not path.is_file() or status.st_size <= 0 or status.st_size > MAX_JOB_BYTES:
        raise ValueError(f"Refusing unsafe or oversized input: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_structured_output(raw: str) -> dict[str, Any]:
    value = json.loads(raw, strict=False)
    if not isinstance(value, dict):
        raise ValueError("Structured model output must be a JSON object")
    return value


def bounded_evidence(root: Path, raw: str, expected_hash: str, expected_size: int) -> Path:
    candidate = (root / raw).resolve(strict=True)
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Evidence path escapes the workspace: {raw}")
    status = candidate.lstat()
    if candidate.is_symlink() or not candidate.is_file() or status.st_size <= 0 or status.st_size > MAX_EVIDENCE_BYTES:
        raise ValueError(f"Evidence is not a bounded regular file: {raw}")
    if status.st_size != expected_size:
        raise ValueError(f"Evidence size differs from the sealed input budget: {raw}")
    if digest(candidate.read_bytes()) != expected_hash:
        raise ValueError(f"Evidence bytes differ from the sealed hash: {raw}")
    return candidate


def atomic_json(path: Path, value: Any) -> None:
    payload = (canonical_json(value) + "\n").encode("utf-8")
    if not payload or len(payload) > MAX_OUTPUT_BYTES:
        raise ValueError("Worker output exceeds its byte bound")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise ValueError(f"Refusing unsafe output replacement: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def checkpoint(path: Path, kind: str, job_hash: str) -> dict[str, Any] | None:
    if not path.exists():
        return None
    value = bounded_json(path)
    if (
        value.get("kind") != kind
        or value.get("jobHash") != job_hash
        or artifact_hash(value, "resultHash") != value.get("resultHash")
    ):
        raise ValueError("Existing worker checkpoint has invalid identity")
    return value


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "absent"


def peak_resident_bytes() -> int:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform != "darwin":
        peak *= 1024
    return int(peak)


def configure_runtime(root: Path) -> None:
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HOME", str(root / ".basalt" / "model-cache"))
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("MKL_NUM_THREADS", "4")
    try:
        import torch

        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        torch.set_num_interop_threads(1)
        torch.set_float32_matmul_precision("highest")
    except ImportError:
        pass


def model_snapshot(model: dict[str, Any]) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(
        repo_id=model["repository"],
        revision=model["sourceCommitHash"],
        token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN"),
        local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
    )


def runtime_identity(worker_hash: str, model: dict[str, Any], adapter: str) -> dict[str, str]:
    runtime = {
        "python": sys.version.split()[0],
        "torch": package_version("torch"),
        "transformers": package_version("transformers"),
        "vllm": package_version("vllm"),
        "pillow": package_version("Pillow"),
        "adapter": adapter,
        "device": "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES", "") != "" else "local",
        "vlmMaxModelTokens": VLM_MAX_MODEL_TOKENS,
        "vlmMaxOutputTokens": VLM_MAX_OUTPUT_TOKENS,
        "vlmGpuMemoryUtilizationMillionths": round(VLM_GPU_MEMORY_UTILIZATION * 1_000_000),
    }
    return {
        "adapterImplementationHash": digest(f"{worker_hash}:{adapter}"),
        "workerImplementationHash": worker_hash,
        "runtimeImplementationHash": digest(canonical_json(runtime)),
        "modelImplementationHash": digest(canonical_json({"model": model, "runtime": runtime})),
        "modelId": model["modelId"],
        "modelCommitHash": model["sourceCommitHash"],
    }


def result_with_hash(kind: str, job_hash: str, runtime: dict[str, str], items: list[dict[str, Any]]) -> dict[str, Any]:
    material = {"kind": kind, "jobHash": job_hash, "runtime": runtime, "items": sorted(items, key=lambda item: item["requestHash"])}
    return {**material, "resultHash": digest(canonical_json(material))}


def embedding_result(job_hash: str, receipts: list[dict[str, Any]]) -> dict[str, Any]:
    material = {
        "kind": "CatalogEmbeddingWorkerOutput",
        "jobHash": job_hash,
        "receipts": sorted(receipts, key=lambda item: (item["sourceContentHash"], item["purpose"])),
    }
    return {**material, "resultHash": digest(canonical_json(material))}


def query_result(
    job_hash: str,
    model_implementation_hash: str,
    preprocessing_implementation_hash: str,
    items: list[dict[str, Any]],
    gpu_milliseconds: int,
) -> dict[str, Any]:
    material = {
        "kind": "CatalogQueryEmbeddingWorkerOutput",
        "jobHash": job_hash,
        "modelImplementationHash": model_implementation_hash,
        "preprocessingImplementationHash": preprocessing_implementation_hash,
        "gpuMilliseconds": gpu_milliseconds,
        "items": sorted(items, key=lambda item: item["queryHash"]),
    }
    return {**material, "resultHash": digest(canonical_json(material))}


def resized_rgb(path: Path):
    from PIL import Image

    with Image.open(path) as source:
        image = source.convert("RGB")
        width, height = image.size
        scale = min(1.0, IMAGE_LONG_EDGE / max(width, height))
        if scale < 1.0:
            image = image.resize(
                (max(1, round(width * scale)), max(1, round(height * scale))),
                Image.Resampling.LANCZOS,
            )
        return image.copy()


def image_data_uri(image: Any) -> str:
    output = io.BytesIO()
    image.save(output, format="PNG", compress_level=9, optimize=False)
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def prepare_rgb_views(
    root: Path, views: list[dict[str, Any]], allowed_counts: tuple[int, ...]
) -> tuple[list[Any], int]:
    if len(views) not in allowed_counts:
        expected = " or ".join(str(value) for value in allowed_counts)
        raise ValueError(f"Worker request requires exactly {expected} RGB views")
    images = [
        resized_rgb(
            bounded_evidence(root, view["rgbRelativePath"], view["rgbHash"], view["rgbSizeBytes"])
        )
        for view in views
    ]
    return images, sum(image.width * image.height for image in images)


def load_vllm(model: dict[str, Any], output_schema: dict[str, Any]):
    from vllm import LLM, SamplingParams
    from vllm.sampling_params import StructuredOutputsParams

    location = model_snapshot(model)
    llm = LLM(
        model=location,
        dtype="bfloat16",
        enforce_eager=True,
        seed=0,
        trust_remote_code=False,
        max_model_len=VLM_MAX_MODEL_TOKENS,
        gpu_memory_utilization=VLM_GPU_MEMORY_UTILIZATION,
        limit_mm_per_prompt={"image": MAX_CONTEXT_CANDIDATES},
    )
    sampling = SamplingParams(
        temperature=0.0,
        top_p=1.0,
        repetition_penalty=1.05,
        max_tokens=VLM_MAX_OUTPUT_TOKENS,
        seed=0,
        structured_outputs=StructuredOutputsParams(json=output_schema),
    )
    return llm, sampling


def generate_structured(
    llm: Any, sampling: Any, prompt: str, images: list[Any]
) -> tuple[str, int, int, str]:
    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": image_data_uri(image)}} for image in images
    ]
    content.append({"type": "text", "text": prompt})
    outputs = llm.chat(
        messages=[{"role": "user", "content": content}],
        sampling_params=sampling,
        use_tqdm=False,
    )
    output = outputs[0]
    completion = output.outputs[0]
    return (
        completion.text,
        len(output.prompt_token_ids),
        len(completion.token_ids),
        completion.finish_reason or "unknown",
    )


def metadata_prompt(template: str, item: dict[str, Any]) -> str:
    request = item["request"]
    hint = ""
    if request["evidenceMode"] == "visual_and_name":
        names = [
            observation["originalFilename"]
            for observation in item["sourceNameHint"]["observations"]
        ]
        hint = (
            "\nWeak original-basename hints follow. They may be wrong and are not semantic "
            f"authority: {canonical_json(names)}"
        )
    return (
        template
        + f"\nInspect all {len(item['views'])} views as observations of one source asset. "
        + "Describe only visible facts.\nExact decimal-meter measurement summary: "
        + canonical_json(request["metricSummary"])
        + "\nA lower_extrema support method proves only Y-up bottom alignment and intentionally "
        + "reports zero planar contact area; it does not prove intended placement or stability."
        + hint
        + "\nReturn exactly the constrained JSON object. Abstain field-by-field when evidence is insufficient."
    )


def validation_prompt(template: str, item: dict[str, Any]) -> str:
    request = item["request"]
    candidate = (
        item["metadataReceipt"]["metadata"]
        if item.get("metadataReceipt") is not None
        else {"status": "absent", "reason": "candidate has no metadata enrichment"}
    )
    metric = request["candidate"]["metricSummary"]
    target = request.get("query") or request.get("requirement")
    return (
        template
        + "\nCandidate metadata (non-authoritative): "
        + canonical_json(candidate)
        + "\nMeasured facts: "
        + canonical_json(metric)
        + "\nA lower_extrema support method proves only Y-up bottom alignment and intentionally "
        + "reports zero planar contact area; it does not prove intended placement or stability."
        + "\nRequested target: "
        + canonical_json(target)
        + "\nUse only the renders and measured facts. Do not infer hidden affordances, sockets, "
        + "collision behavior, internal structure, or structural semantics. Return uncertain when "
        + "those facts would be needed. Filenames are intentionally unavailable."
    )


def context_prompt(template: str, job: dict[str, Any]) -> str:
    request = job["request"]
    names_by_source = {
        entry["sourceContentHash"]: [
            observation["originalFilename"]
            for observation in entry.get("sourceNameHint", {}).get("observations", [])
        ]
        for entry in job["candidateEvidence"]
    }
    candidates = []
    for candidate in request["candidates"]:
        candidates.append(
            {
                "sourceContentHash": candidate["sourceContentHash"],
                "metricSummary": candidate["metricSummary"],
                "parts": candidate["parts"],
                "sockets": candidate["sockets"],
                "weakOriginalBasenames": names_by_source[candidate["sourceContentHash"]],
            }
        )
    return (
        template
        + "\nCandidate evidence appears in the same canonical order as the contact-sheet images."
        + "\nMeasured candidate records: "
        + canonical_json(candidates)
        + "\nAttributed assembly evidence: "
        + canonical_json(request["attributedAssemblyEvidence"])
        + "\nA lower_extrema support method proves only Y-up bottom alignment and intentionally "
        + "reports zero planar contact area; it does not prove intended placement or stability. "
        + "\nPack, archive, and directory identity are unavailable. Basenames are weak hints only. "
        + "Cite only hashes present in the supplied evidence and abstain when isolated geometry "
        + "or attributed context does not establish an intended role. Return exactly the constrained JSON object."
    )


def process_metadata(root: Path, job: dict[str, Any], output_path: Path, worker_hash: str) -> None:
    model = job["model"]
    runtime = runtime_identity(worker_hash, model, "qwen3_vl_open_metadata")
    existing = checkpoint(output_path, "CatalogMetadataWorkerOutput", job["hash"])
    items: list[dict[str, Any]] = (
        list(existing["items"])
        if existing is not None and existing.get("runtime") == runtime
        else []
    )
    completed = {item["requestHash"] for item in items}
    pending = [item for item in job["items"] if item["request"]["hash"] not in completed]
    if not pending:
        return
    llm, sampling = load_vllm(model, job["outputSchema"])
    for item in pending:
        started = time.monotonic()
        request = item["request"]
        images: list[Any] = []
        raw = ""
        input_tokens = 0
        output_tokens = 0
        try:
            images, pixels = prepare_rgb_views(root, item["views"], (4, 12))
            prompt = metadata_prompt(job["promptTemplate"], item)
            raw, input_tokens, output_tokens, finish_reason = generate_structured(
                llm, sampling, prompt, images
            )
            if finish_reason == "length":
                raise ValueError(
                    f"Structured output exhausted its {VLM_MAX_OUTPUT_TOKENS}-token budget"
                )
            metadata = parse_structured_output(raw)
            receipt = {
                "requestHash": request["hash"],
                "status": "eligible",
                "promptHash": digest(prompt),
                "rawOutputHash": digest(raw),
                "metadata": metadata,
                "diagnostics": [],
                "resourceUsage": {
                    "inputImageCount": len(images),
                    "inputPixels": pixels,
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                    "peakResidentBytes": peak_resident_bytes(),
                    "gpuMilliseconds": round((time.monotonic() - started) * 1000),
                },
            }
        except Exception as error:  # noqa: BLE001 - failure is evidence, not a crash
            receipt = {
                "requestHash": request["hash"],
                "status": "incomplete",
                "promptHash": digest(metadata_prompt(job["promptTemplate"], item)),
                **({"rawOutputHash": digest(raw)} if raw else {}),
                "diagnostics": [f"{type(error).__name__}: {error}"],
                "resourceUsage": {
                    "inputImageCount": len(images),
                    "inputPixels": sum(image.width * image.height for image in images),
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                    "peakResidentBytes": peak_resident_bytes(),
                    "gpuMilliseconds": round((time.monotonic() - started) * 1000),
                },
            }
        finally:
            for image in images:
                image.close()
        items.append(receipt)
        atomic_json(output_path, result_with_hash("CatalogMetadataWorkerOutput", job["hash"], runtime, items))
        print(canonical_json({"stage": "metadata", "completed": len(items), "total": len(job["items"])}), flush=True)


def process_validation(root: Path, job: dict[str, Any], output_path: Path, worker_hash: str) -> None:
    model = job["model"]
    runtime = runtime_identity(worker_hash, model, "qwen3_vl_requirement_validation")
    existing = checkpoint(output_path, "CatalogValidationWorkerOutput", job["hash"])
    items: list[dict[str, Any]] = (
        list(existing["items"])
        if existing is not None and existing.get("runtime") == runtime
        else []
    )
    completed = {item["requestHash"] for item in items}
    pending = [item for item in job["items"] if item["request"]["hash"] not in completed]
    if not pending:
        return
    llm, sampling = load_vllm(model, job["outputSchema"])
    for item in pending:
        started = time.monotonic()
        request = item["request"]
        images: list[Any] = []
        raw = ""
        input_tokens = 0
        output_tokens = 0
        try:
            images, pixels = prepare_rgb_views(root, item["views"], (12,))
            prompt = validation_prompt(job["promptTemplate"], item)
            raw, input_tokens, output_tokens, finish_reason = generate_structured(
                llm, sampling, prompt, images
            )
            if finish_reason == "length":
                raise ValueError(
                    f"Structured output exhausted its {VLM_MAX_OUTPUT_TOKENS}-token budget"
                )
            validation = parse_structured_output(raw)
            receipt = {
                "requestHash": request["hash"],
                "status": "eligible",
                "promptHash": digest(prompt),
                "rawOutputHash": digest(raw),
                "validation": validation,
                "diagnostics": [],
                "resourceUsage": {
                    "inputImageCount": len(images),
                    "inputPixels": pixels,
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                    "peakResidentBytes": peak_resident_bytes(),
                    "gpuMilliseconds": round((time.monotonic() - started) * 1000),
                },
            }
        except Exception as error:  # noqa: BLE001
            receipt = {
                "requestHash": request["hash"],
                "status": "incomplete",
                "promptHash": digest(validation_prompt(job["promptTemplate"], item)),
                **({"rawOutputHash": digest(raw)} if raw else {}),
                "diagnostics": [f"{type(error).__name__}: {error}"],
                "resourceUsage": {
                    "inputImageCount": len(images),
                    "inputPixels": sum(image.width * image.height for image in images),
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                    "peakResidentBytes": peak_resident_bytes(),
                    "gpuMilliseconds": round((time.monotonic() - started) * 1000),
                },
            }
        finally:
            for image in images:
                image.close()
        items.append(receipt)
        atomic_json(output_path, result_with_hash("CatalogValidationWorkerOutput", job["hash"], runtime, items))
        print(canonical_json({"stage": "validation", "completed": len(items), "total": len(job["items"])}), flush=True)


def process_context(root: Path, job: dict[str, Any], output_path: Path, worker_hash: str) -> None:
    model = job["model"]
    runtime = runtime_identity(worker_hash, model, "qwen3_vl_assembly_context")
    existing = checkpoint(output_path, "CatalogContextWorkerOutput", job["hash"])
    if (
        existing is not None
        and existing.get("runtime") == runtime
        and existing.get("requestHash") == job["request"]["hash"]
        and existing.get("status") == "eligible"
    ):
        return
    started = time.monotonic()
    images: list[Any] = []
    raw = ""
    input_tokens = 0
    output_tokens = 0
    prompt = context_prompt(job["promptTemplate"], job)
    try:
        for evidence in job["candidateEvidence"]:
            images.append(
                resized_rgb(
                    bounded_evidence(
                        root,
                        evidence["contactSheetRelativePath"],
                        evidence["contactSheetContentHash"],
                        evidence["contactSheetSizeBytes"],
                    )
                )
            )
        pixels = sum(image.width * image.height for image in images)
        llm, sampling = load_vllm(model, job["outputSchema"])
        raw, input_tokens, output_tokens, finish_reason = generate_structured(
            llm, sampling, prompt, images
        )
        if finish_reason == "length":
            raise ValueError(
                f"Structured output exhausted its {VLM_MAX_OUTPUT_TOKENS}-token budget"
            )
        material = {
            "kind": "CatalogContextWorkerOutput",
            "jobHash": job["hash"],
            "runtime": runtime,
            "requestHash": job["request"]["hash"],
            "status": "eligible",
            "promptHash": digest(prompt),
            "rawOutputHash": digest(raw),
            "hypothesis": parse_structured_output(raw),
            "diagnostics": [],
            "resourceUsage": {
                "inputImageCount": len(images),
                "inputPixels": pixels,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                "peakResidentBytes": peak_resident_bytes(),
                "gpuMilliseconds": round((time.monotonic() - started) * 1000),
            },
        }
    except Exception as error:  # noqa: BLE001
        material = {
            "kind": "CatalogContextWorkerOutput",
            "jobHash": job["hash"],
            "runtime": runtime,
            "requestHash": job["request"]["hash"],
            "status": "incomplete",
            "promptHash": digest(prompt),
            **({"rawOutputHash": digest(raw)} if raw else {}),
            "diagnostics": [f"{type(error).__name__}: {error}"],
            "resourceUsage": {
                "inputImageCount": len(images),
                "inputPixels": sum(image.width * image.height for image in images),
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
                "peakResidentBytes": peak_resident_bytes(),
                "gpuMilliseconds": round((time.monotonic() - started) * 1000),
            },
        }
    finally:
        for image in images:
            image.close()
    atomic_json(output_path, {**material, "resultHash": digest(canonical_json(material))})
    print(
        canonical_json(
            {
                "stage": "context",
                "completed": 1,
                "total": 1,
                "status": material["status"],
            }
        ),
        flush=True,
    )


def normalize(vector: Any) -> Any:
    import torch

    return torch.nn.functional.normalize(vector.float(), dim=-1)


def quantize(vector: Iterable[float]) -> dict[str, Any]:
    values = [float(value) for value in vector]
    maximum = max(abs(value) for value in values)
    if not math.isfinite(maximum) or maximum <= 0:
        raise ValueError("Cannot quantize a zero or non-finite vector")
    scale = maximum / 32767.0
    return {
        "scaleMillionths": max(1, round(scale * 1_000_000)),
        "values": [max(-32767, min(32767, round(value / scale))) for value in values],
    }


def aggregate_vectors(vectors: Any, view_ids: list[str]) -> tuple[dict[str, Any], str, int]:
    import torch

    unit = normalize(vectors).cpu()
    aggregate = normalize(unit.mean(dim=0, keepdim=True))[0]
    disagreement = max(0.0, max(1.0 - float(torch.dot(view, aggregate)) for view in unit))
    per_view = [
        {"viewId": view_id, "vector": quantize(vector.tolist())}
        for view_id, vector in zip(view_ids, unit, strict=True)
    ]
    return quantize(aggregate.tolist()), digest(canonical_json(per_view)), min(2_000_000, round(disagreement * 1_000_000))


def embedding_purposes(model: dict[str, Any]) -> list[str]:
    capabilities = model.get("capabilities")
    if not isinstance(capabilities, list):
        raise ValueError("Catalog model declaration requires capabilities")
    return sorted(
        capability
        for capability in capabilities
        if capability in ("image_text_retrieval", "shape_similarity")
    )


def embedding_purpose(model: dict[str, Any]) -> str:
    purposes = embedding_purposes(model)
    if len(purposes) != 1:
        raise ValueError("Embedding model must declare exactly one embedding capability")
    return purposes[0]


def load_retrieval_model(model: dict[str, Any], purpose: str):
    import torch
    from transformers import AutoImageProcessor, AutoModel, AutoProcessor

    location = model_snapshot(model)
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    if embedding_purpose(model) != purpose:
        raise ValueError("Embedding model capability does not match the requested purpose")
    if purpose == "image_text_retrieval":
        processor = AutoProcessor.from_pretrained(location, local_files_only=True, use_fast=True)
    else:
        processor = AutoImageProcessor.from_pretrained(location, local_files_only=True, use_fast=True)
    network = AutoModel.from_pretrained(location, local_files_only=True, attn_implementation="eager").to(device)
    network.eval()
    return processor, network, device


def embedding_identity(worker_hash: str, model: dict[str, Any], network: Any, processor: Any, channel: str) -> tuple[str, str, str]:
    implementation = digest(
        canonical_json(
            {
                "model": model,
                "workerImplementationHash": worker_hash,
                "networkClass": type(network).__name__,
                "processorClass": type(processor).__name__,
                "torch": package_version("torch"),
                "transformers": package_version("transformers"),
                "dtype": "float32",
            }
        )
    )
    preprocessing = digest(canonical_json({"model": model, "channel": channel, "views": MAX_VIEWS, "longEdge": IMAGE_LONG_EDGE}))
    aggregation = digest("unit-normalize:mean:unit-normalize:int16-le")
    return implementation, preprocessing, aggregation


def process_embeddings(root: Path, job: dict[str, Any], output_path: Path, worker_hash: str) -> None:
    import torch
    from PIL import Image

    existing = checkpoint(output_path, "CatalogEmbeddingWorkerOutput", job["hash"])
    receipts: list[dict[str, Any]] = list(existing["receipts"]) if existing is not None else []
    models = {embedding_purpose(model): model for model in job["models"]}
    for purpose in job["purposes"]:
        channel = "rgb" if purpose == "image_text_retrieval" else "normalizedDepth"
        model = models[purpose]
        processor, network, device = load_retrieval_model(model, purpose)
        implementation, preprocessing, aggregation = embedding_identity(worker_hash, model, network, processor, channel)
        receipts = [
            receipt
            for receipt in receipts
            if receipt["purpose"] != purpose
            or (
                receipt["modelImplementationHash"] == implementation
                and receipt["preprocessingImplementationHash"] == preprocessing
                and receipt["aggregationImplementationHash"] == aggregation
            )
        ]
        completed = {
            receipt["sourceContentHash"]
            for receipt in receipts
            if receipt["purpose"] == purpose
        }
        for item in job["items"]:
            if item["sourceContentHash"] in completed:
                continue
            started = time.monotonic()
            images = []
            try:
                for view in item["views"]:
                    if channel == "rgb":
                        images.append(
                            resized_rgb(
                                bounded_evidence(
                                    root,
                                    view["rgbRelativePath"],
                                    view["rgbHash"],
                                    view["rgbSizeBytes"],
                                )
                            )
                        )
                    else:
                        path = bounded_evidence(
                            root,
                            view["normalizedDepthRelativePath"],
                            view["normalizedDepthHash"],
                            view["normalizedDepthSizeBytes"],
                        )
                        with Image.open(path) as source:
                            images.append(source.convert("RGB").resize((IMAGE_LONG_EDGE, IMAGE_LONG_EDGE), Image.Resampling.LANCZOS))
                inputs = processor(images=images, return_tensors="pt")
                inputs = {key: value.to(device) for key, value in inputs.items()}
                with torch.inference_mode():
                    if purpose == "image_text_retrieval":
                        vectors = network.get_image_features(**inputs)
                    else:
                        output = network(**inputs)
                        vectors = getattr(output, "pooler_output", None)
                        if vectors is None:
                            vectors = output.last_hidden_state[:, 0, :]
                aggregate, per_view_hash, disagreement = aggregate_vectors(vectors, [view["viewId"] for view in item["views"]])
                receipts.append(
                    {
                        "sourceContentHash": item["sourceContentHash"],
                        "renderEvidenceHash": item["renderEvidenceHash"],
                        "purpose": purpose,
                        "modelId": model["modelId"],
                        "modelCommitHash": model["sourceCommitHash"],
                        "modelImplementationHash": implementation,
                        "preprocessingImplementationHash": preprocessing,
                        "aggregationImplementationHash": aggregation,
                        "perViewEvidenceHash": per_view_hash,
                        "aggregate": aggregate,
                        "maximumViewDisagreementMillionths": disagreement,
                        "gpuMilliseconds": round((time.monotonic() - started) * 1000),
                    }
                )
                atomic_json(output_path, embedding_result(job["hash"], receipts))
                print(canonical_json({"stage": purpose, "completedReceipts": len(receipts)}), flush=True)
            finally:
                for image in images:
                    image.close()
        del network, processor
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "mps":
            torch.mps.empty_cache()


def process_query_embeddings(job: dict[str, Any], output_path: Path, worker_hash: str) -> None:
    import torch

    started = time.monotonic()
    model = job["model"]
    processor, network, device = load_retrieval_model(model, "image_text_retrieval")
    implementation, preprocessing, _aggregation = embedding_identity(worker_hash, model, network, processor, "text")
    texts = [item["text"] for item in job["queries"]]
    maximum = int(network.config.text_config.max_position_embeddings)
    inputs = processor(text=texts, padding="max_length", truncation=True, max_length=maximum, return_tensors="pt")
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        vectors = normalize(network.get_text_features(**inputs)).cpu()
    items = [
        {"queryHash": item["queryHash"], "vector": quantize(vector.tolist())}
        for item, vector in zip(job["queries"], vectors, strict=True)
    ]
    atomic_json(
        output_path,
        query_result(
            job["hash"],
            implementation,
            preprocessing,
            items,
            round((time.monotonic() - started) * 1000),
        ),
    )


def validate_worker_input_budget(job: dict[str, Any]) -> None:
    kind = job.get("kind")
    if kind == "CatalogQueryEmbeddingWorkerJob":
        if embedding_purpose(job.get("model", {})) != "image_text_retrieval":
            raise ValueError("Query embedding requires an image-text retrieval model")
        return
    if kind == "CatalogContextWorkerJob":
        candidates = job.get("candidateEvidence", [])
        if not 2 <= len(candidates) <= MAX_CONTEXT_CANDIDATES:
            raise ValueError("Context candidate count is outside its bounded range")
        sizes = [entry["contactSheetSizeBytes"] for entry in candidates]
        expected = {
            "candidateCount": len(candidates),
            "evidenceFileCount": len(candidates),
            "evidenceBytes": sum(sizes),
            "preprocessedPixelCeiling": len(candidates) * IMAGE_LONG_EDGE * IMAGE_LONG_EDGE,
        }
        if job.get("inputBudget") != expected:
            raise ValueError("Context worker input budget differs from its sealed evidence")
        if expected["evidenceBytes"] > MAX_EVIDENCE_TOTAL_BYTES:
            raise ValueError("Context worker evidence exceeds its aggregate byte bound")
        return
    items = job.get("items", [])
    if not 1 <= len(items) <= MAX_ITEMS:
        raise ValueError("Worker shard asset count is outside its bounded range")
    embedding_job = kind == "CatalogEmbeddingWorkerJob"
    purposes: list[str] = []
    if embedding_job:
        raw_purposes = job.get("purposes")
        if (
            not isinstance(raw_purposes, list)
            or raw_purposes != sorted(set(raw_purposes))
            or not 1 <= len(raw_purposes) <= 2
            or any(
                purpose not in ("image_text_retrieval", "shape_similarity")
                for purpose in raw_purposes
            )
        ):
            raise ValueError("Embedding purposes must be a non-empty canonical set")
        purposes = raw_purposes
        models = job.get("models")
        if not isinstance(models, list) or len(models) != len(purposes):
            raise ValueError("Embedding jobs require one model per requested purpose")
        model_purposes = sorted(embedding_purpose(model) for model in models)
        if model_purposes != purposes:
            raise ValueError("Embedding models do not match the requested purposes")
    sizes: list[int] = []
    for item in items:
        views = item.get("views", [])
        allowed_view_counts = (MAX_VIEWS,) if kind != "CatalogMetadataWorkerJob" else (4, MAX_VIEWS)
        if len(views) not in allowed_view_counts:
            raise ValueError("Worker asset binds an unsupported canonical view count")
        for view in views:
            rgb_fields = ("rgbRelativePath", "rgbHash", "rgbSizeBytes")
            depth_fields = (
                "normalizedDepthRelativePath",
                "normalizedDepthHash",
                "normalizedDepthSizeBytes",
            )
            rgb_field_count = sum(field in view for field in rgb_fields)
            depth_field_count = sum(field in view for field in depth_fields)
            if rgb_field_count not in (0, len(rgb_fields)):
                raise ValueError("Embedding RGB evidence fields are incomplete")
            if depth_field_count not in (0, len(depth_fields)):
                raise ValueError("Embedding depth evidence fields are incomplete")
            has_rgb = rgb_field_count == len(rgb_fields)
            has_depth = depth_field_count == len(depth_fields)
            if embedding_job:
                if has_rgb != ("image_text_retrieval" in purposes):
                    raise ValueError(
                        "Embedding RGB evidence does not match the requested purposes"
                    )
                if has_depth != ("shape_similarity" in purposes):
                    raise ValueError(
                        "Embedding depth evidence does not match the requested purposes"
                    )
            elif not has_rgb or has_depth:
                raise ValueError("Non-embedding workers require RGB-only view evidence")
            if has_rgb:
                sizes.append(view["rgbSizeBytes"])
            if has_depth:
                sizes.append(view["normalizedDepthSizeBytes"])
    expected = {
        "assetCount": len(items),
        "evidenceFileCount": len(sizes),
        "evidenceBytes": sum(sizes),
        "preprocessedPixelCeiling": len(sizes) * IMAGE_LONG_EDGE * IMAGE_LONG_EDGE,
    }
    if job.get("inputBudget") != expected:
        raise ValueError("Worker input budget differs from its sealed evidence")
    if expected["evidenceFileCount"] > MAX_EVIDENCE_FILES:
        raise ValueError("Worker shard exceeds its evidence file-count bound")
    if expected["evidenceBytes"] > MAX_EVIDENCE_TOTAL_BYTES:
        raise ValueError("Worker shard exceeds its aggregate evidence-byte bound")
    if expected["preprocessedPixelCeiling"] > MAX_PREPROCESSED_PIXELS:
        raise ValueError("Worker shard exceeds its preprocessed-pixel bound")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job")
    parser.add_argument("--output")
    parser.add_argument("--validate-job", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        views = [
            {
                "rgbRelativePath": f"view-{index}.png",
                "rgbHash": "0" * 64,
                "rgbSizeBytes": 1,
                "viewId": f"low_{index:02d}",
            }
            for index in range(MAX_VIEWS)
        ]
        job = {
            "kind": "CatalogMetadataWorkerJob",
            "items": [{"views": views}],
            "inputBudget": {
                "assetCount": 1,
                "evidenceFileCount": MAX_VIEWS,
                "evidenceBytes": MAX_VIEWS,
                "preprocessedPixelCeiling": MAX_VIEWS * IMAGE_LONG_EDGE * IMAGE_LONG_EDGE,
            },
        }
        validate_worker_input_budget(job)
        normalized = parse_structured_output('{"text":"line\u0001break"}')
        if normalized != {"text": "line\u0001break"}:
            raise ValueError("Structured output control-character normalization failed")
        print(canonical_json({"status": "eligible", "tested": "bounded_worker_contract"}))
        return
    if not arguments.job or (not arguments.validate_job and not arguments.output):
        parser.error(
            "--job and --output are required unless --self-test or --validate-job is used"
        )
    root = Path.cwd().resolve()
    job_path = Path(arguments.job).resolve()
    output_path = Path(arguments.output).resolve() if arguments.output else None
    if root not in job_path.parents or (
        output_path is not None and root not in output_path.parents
    ):
        raise ValueError("Worker job and output must remain inside the workspace")
    job = bounded_json(job_path)
    if typescript_artifact_hash(job_path) != job.get("hash"):
        raise ValueError("Worker job hash mismatch")
    validate_worker_input_budget(job)
    worker_hash = digest(Path(__file__).read_bytes())
    if job.get("workerImplementationHash") != worker_hash:
        raise ValueError("Worker job does not bind this exact implementation")
    if arguments.validate_job:
        print(
            canonical_json(
                {
                    "status": "eligible",
                    "kind": job.get("kind"),
                    "jobHash": job["hash"],
                    "purposes": job.get("purposes", []),
                }
            )
        )
        return
    configure_runtime(root)
    kind = job.get("kind")
    if kind == "CatalogMetadataWorkerJob":
        assert output_path is not None
        process_metadata(root, job, output_path, worker_hash)
    elif kind == "CatalogContextWorkerJob":
        assert output_path is not None
        process_context(root, job, output_path, worker_hash)
    elif kind == "CatalogValidationWorkerJob":
        assert output_path is not None
        process_validation(root, job, output_path, worker_hash)
    elif kind == "CatalogEmbeddingWorkerJob":
        assert output_path is not None
        process_embeddings(root, job, output_path, worker_hash)
    elif kind == "CatalogQueryEmbeddingWorkerJob":
        assert output_path is not None
        process_query_embeddings(job, output_path, worker_hash)
    else:
        raise ValueError(f"Unsupported catalog metadata job kind: {kind}")


if __name__ == "__main__":
    main()
