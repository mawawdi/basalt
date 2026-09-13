#!/usr/bin/env python3
"""Bounded local evidence worker for the catalog qualification pilot.

The worker emits hypotheses and feature evidence only. It never writes semantic
commitments, dispositions, or catalog entries, and it never grants compiler
authority. One learned model is resident at a time to keep 16 GB development
machines responsive.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import os
import resource
import sys
import time
from pathlib import Path
from typing import Any, Iterable

MAX_JOB_BYTES = 64 * 1024 * 1024
MAX_SOURCES = 10_000
MAX_VIEWS = 12
TOP_BY_FACET = {
    "affordance": 6,
    "denotation": 8,
    "realization_form": 4,
    "state": 8,
    "surface_treatment": 5,
}
GENERIC_NAME_TOKENS = {
    "asset",
    "env",
    "environment",
    "geo",
    "lod",
    "low",
    "mesh",
    "model",
    "poly",
    "prop",
    "sm",
    "static",
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(value: bytes | str) -> str:
    material = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(material).hexdigest()


def bounded_json(path: Path) -> Any:
    status = path.lstat()
    if path.is_symlink() or not path.is_file() or status.st_size > MAX_JOB_BYTES:
        raise ValueError(f"Refusing unsafe or oversized input: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def within(root: Path, raw: str) -> Path:
    path = (root / raw).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"Evidence path escapes the workspace: {raw}")
    status = path.lstat()
    if path.is_symlink() or not path.is_file() or status.st_size > 64 * 1024 * 1024:
        raise ValueError(f"Evidence is not a bounded regular file: {raw}")
    return path


def verified_evidence(root: Path, raw: str, expected_hash: str) -> Path:
    path = within(root, raw)
    if digest(path.read_bytes()) != expected_hash:
        raise ValueError(f"Evidence bytes differ from the sealed hash: {raw}")
    return path


def normalize(vector: Any) -> Any:
    import torch

    return torch.nn.functional.normalize(vector.float(), dim=-1)


def quantize(vector: Iterable[float]) -> dict[str, Any]:
    values = [float(value) for value in vector]
    maximum = max(abs(value) for value in values)
    if not math.isfinite(maximum) or maximum <= 0:
        raise ValueError("Cannot quantize a zero or non-finite feature vector")
    scale = maximum / 32767.0
    return {
        "scaleMillionths": max(1, round(scale * 1_000_000)),
        "values": [max(-32767, min(32767, round(value / scale))) for value in values],
    }


def feature_payload(vectors: Any, view_ids: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any], int]:
    import torch

    unit = normalize(vectors).cpu()
    aggregate = normalize(unit.mean(dim=0, keepdim=True))[0]
    disagreement = max(0.0, max(1.0 - float(torch.dot(view, aggregate)) for view in unit))
    return (
        [
            {"viewId": view_id, "feature": quantize(vector.tolist())}
            for view_id, vector in zip(view_ids, unit, strict=True)
        ],
        quantize(aggregate.tolist()),
        min(2_000_000, round(disagreement * 1_000_000)),
    )


def tokens(value: str) -> list[str]:
    normalized = "".join(character.lower() if character.isalnum() else " " for character in value)
    return [
        token
        for token in normalized.split()
        if token and token not in GENERIC_NAME_TOKENS and not token.isdigit()
    ]


def lexical_score(name_tokens: list[str], candidate: dict[str, Any]) -> float:
    candidate_tokens = candidate["labelTokens"]
    if not name_tokens or not candidate_tokens:
        return 0.0
    left = set(name_tokens)
    right = set(candidate_tokens)
    overlap = len(left & right) / max(1, len(right))
    jaccard = len(left & right) / max(1, len(left | right))
    sequence = difflib.SequenceMatcher(None, " ".join(name_tokens), " ".join(candidate_tokens)).ratio()
    phrase = 1.0 if " ".join(candidate_tokens) in " ".join(name_tokens) else 0.0
    return min(1.0, 0.45 * overlap + 0.20 * jaccard + 0.20 * sequence + 0.15 * phrase)


def top_scores(candidates: list[dict[str, Any]], scores: list[float]) -> list[dict[str, Any]]:
    grouped: dict[str, list[tuple[dict[str, Any], float]]] = {}
    for candidate, score in zip(candidates, scores, strict=True):
        grouped.setdefault(candidate["assertionKind"], []).append((candidate, score))
    selected: list[dict[str, Any]] = []
    for facet, values in grouped.items():
        values.sort(key=lambda entry: (-entry[1], entry[0]["valueKey"]))
        for candidate, score in values[: TOP_BY_FACET[facet]]:
            selected.append(
                {
                    "value": candidate["value"],
                    "scoreMillionths": max(0, min(1_000_000, round(score * 1_000_000))),
                }
            )
    selected.sort(key=lambda entry: value_key(entry["value"]))
    return selected


def value_key(value: dict[str, Any]) -> str:
    facet = value["assertionKind"]
    if facet == "denotation":
        return f"denotation:{value['concept']['conceptId']}:{value['concept']['commitmentHash']}"
    if facet == "realization_form":
        return f"realization_form:{value['realizationForm']}"
    if facet == "state":
        return f"state:{value['stateDimensionId']}:{value['stateValueId']}"
    if facet == "affordance":
        return f"affordance:{value['affordanceId']}"
    if facet == "surface_treatment":
        return f"surface_treatment:{value['surfaceTreatmentId']}"
    raise ValueError(f"Unknown facet {facet}")


def channel_output(
    *,
    evidence_source: str,
    adapter_id: str,
    adapter_hash: str,
    model_hash: str,
    dependency_group: str,
    prompt_hash: str,
    normalizer_hash: str,
    normalization: str,
    facet_scores: list[dict[str, Any]],
) -> dict[str, Any]:
    denotation_scores = [
        entry["scoreMillionths"]
        for entry in facet_scores
        if entry["value"]["assertionKind"] == "denotation"
    ]
    novelty = 1_000_000 - max(denotation_scores, default=0)
    raw_output_hash = digest(canonical_json(facet_scores))
    return {
        "evidenceSource": evidence_source,
        "adapterId": adapter_id,
        "adapterImplementationHash": adapter_hash,
        "modelImplementationHash": model_hash,
        "dependencyGroupId": dependency_group,
        "promptHash": prompt_hash,
        "rawOutputHash": raw_output_hash,
        "normalizationImplementationHash": normalizer_hash,
        "scoreNormalization": normalization,
        "facetScores": facet_scores,
        "noveltyScoreMillionths": novelty,
        "diagnostics": [],
    }


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise ValueError(f"Refusing unsafe output replacement: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def model_declaration(config: dict[str, Any], implementation_hash: str) -> dict[str, Any]:
    return {**config, "implementationHash": implementation_hash}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    started = time.monotonic()
    root = Path.cwd().resolve()
    job_path = Path(arguments.job).resolve()
    output_path = Path(arguments.output).resolve()
    if root not in job_path.parents or root not in output_path.parents:
        raise ValueError("Pilot job and output must remain inside the workspace")
    job = bounded_json(job_path)
    if job.get("kind") != "CatalogPilotWorkerJob":
        raise ValueError("Unexpected pilot job kind")
    if len(job.get("items", [])) > MAX_SOURCES:
        raise ValueError("Pilot exceeds the bounded source limit")
    job_material = {key: value for key, value in job.items() if key != "hash"}
    if digest(canonical_json(job_material)) != job.get("hash"):
        raise ValueError("Pilot job hash mismatch")

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HOME", str(root / ".basalt" / "model-cache"))
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    import torch
    import torchvision
    import transformers
    from huggingface_hub import snapshot_download
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModel, AutoProcessor

    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    torch.use_deterministic_algorithms(True)
    torch.set_float32_matmul_precision("highest")
    if torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    device = (
        "cuda"
        if torch.cuda.is_available()
        else "mps"
        if torch.backends.mps.is_available()
        else "cpu"
    )
    model_by_purpose = {entry["purpose"]: entry for entry in job["models"]}
    siglip_config = model_by_purpose["multiview_semantics_and_appearance"]
    dino_config = model_by_purpose["multiview_shape"]
    name_config = model_by_purpose["source_name_hint"]
    offline = os.environ.get("HF_HUB_OFFLINE") == "1"
    access_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    siglip_location = snapshot_download(
        repo_id=siglip_config["repository"],
        revision=siglip_config["revision"],
        token=access_token,
        local_files_only=offline,
    )
    dino_location = snapshot_download(
        repo_id=dino_config["repository"],
        revision=dino_config["revision"],
        token=access_token,
        local_files_only=offline,
    )
    worker_hash = digest(Path(__file__).read_bytes())
    if (
        name_config.get("source") != "basalt"
        or name_config.get("repository") != "workers/catalog-admission/pilot.py"
        or name_config.get("revision") != worker_hash
    ):
        raise ValueError("Source-name model declaration does not bind this exact worker")
    normalizer_hash = digest("catalog-pilot-score-normalizer:softmax-and-lexical")
    if job.get("normalizerImplementationHash") != normalizer_hash:
        raise ValueError("Pilot job binds a different score normalizer")
    aggregate_hash = digest("catalog-pilot-multiview-mean-unit-vector")
    siglip_preprocess_hash = digest(
        canonical_json({"model": siglip_config, "channel": "rgb", "views": MAX_VIEWS})
    )
    dino_preprocess_hash = digest(
        canonical_json(
            {
                "model": dino_config,
                "channel": "normalized_depth",
                "views": MAX_VIEWS,
                "height": 384,
                "width": 384,
            }
        )
    )
    name_model_hash = digest(
        canonical_json(
            {
                "model": name_config,
                "python": sys.version.split()[0],
                "algorithm": "token_overlap_jaccard_sequence_phrase",
            }
        )
    )
    name_adapter_hash = digest(worker_hash + ":source_name_lexicon")

    candidates = job["candidates"]
    name_items: dict[str, dict[str, Any]] = {}
    for item in job["items"]:
        name_tokens = tokens(" ".join(item["sourceNames"]))
        raw_scores = [lexical_score(name_tokens, candidate) for candidate in candidates]
        scores = top_scores(candidates, raw_scores)
        name_items[item["sourceContentHash"]] = channel_output(
            evidence_source="name",
            adapter_id="source_name_lexicon",
            adapter_hash=name_adapter_hash,
            model_hash=name_model_hash,
            dependency_group="source_name",
            prompt_hash=job["promptTemplateHash"],
            normalizer_hash=normalizer_hash,
            normalization="lexical_similarity",
            facet_scores=scores,
        )

    print(json.dumps({"stage": "siglip2", "sources": len(job["items"])}), flush=True)
    siglip_processor = AutoProcessor.from_pretrained(
        siglip_location,
        local_files_only=True,
        use_fast=False,
    )
    siglip_model = AutoModel.from_pretrained(
        siglip_location,
        local_files_only=True,
        attn_implementation="eager",
    ).to(device)
    siglip_model.eval()
    text_sequence_length = int(siglip_model.config.text_config.max_position_embeddings)
    siglip_model_hash = digest(
        canonical_json(
            {
                "repository": siglip_config["repository"],
                "revision": siglip_config["revision"],
                "transformers": transformers.__version__,
                "torch": torch.__version__,
                "modelClass": type(siglip_model).__name__,
                "processorClass": type(siglip_processor).__name__,
                "dtype": "float32",
                "deviceBackend": device,
                "deterministicAlgorithms": True,
                "attentionImplementation": "eager",
                "processorMode": "slow_explicit",
                "textSequenceLength": text_sequence_length,
            }
        )
    )
    siglip_adapter_hash = digest(worker_hash + ":siglip2_multiview")
    text_inputs = siglip_processor(
        text=[entry["prompt"] for entry in candidates],
        padding="max_length",
        truncation=True,
        max_length=text_sequence_length,
        return_tensors="pt",
    )
    text_inputs = {key: value.to(device) for key, value in text_inputs.items()}
    with torch.inference_mode():
        text_features = normalize(siglip_model.get_text_features(**text_inputs))
    visual_items: dict[str, dict[str, Any]] = {}
    appearance_features: dict[str, dict[str, Any]] = {}
    facet_indices: dict[str, list[int]] = {}
    for index, candidate in enumerate(candidates):
        facet_indices.setdefault(candidate["assertionKind"], []).append(index)
    for item_index, item in enumerate(job["items"]):
        images = [
            Image.open(
                verified_evidence(root, view["rgbRelativePath"], view["rgbHash"])
            ).convert("RGB")
            for view in item["views"]
        ]
        image_inputs = siglip_processor(images=images, return_tensors="pt")
        image_inputs = {key: value.to(device) for key, value in image_inputs.items()}
        with torch.inference_mode():
            image_features = normalize(siglip_model.get_image_features(**image_inputs))
            similarities = image_features @ text_features.T
        aggregate_scores = torch.zeros(len(candidates), dtype=torch.float32)
        for indices in facet_indices.values():
            facet_logits = similarities[:, indices] / 0.07
            aggregate_scores[indices] = torch.softmax(facet_logits, dim=-1).mean(dim=0).cpu()
        scores = top_scores(candidates, aggregate_scores.tolist())
        visual_items[item["sourceContentHash"]] = channel_output(
            evidence_source="visual",
            adapter_id="siglip2_multiview",
            adapter_hash=siglip_adapter_hash,
            model_hash=siglip_model_hash,
            dependency_group="visual_siglip2",
            prompt_hash=job["promptTemplateHash"],
            normalizer_hash=normalizer_hash,
            normalization="softmax_per_facet",
            facet_scores=scores,
        )
        per_view, aggregate, disagreement = feature_payload(
            image_features, [view["viewId"] for view in item["views"]]
        )
        appearance_features[item["sourceContentHash"]] = {
            "channel": "appearance",
            "modelImplementationHash": siglip_model_hash,
            "preprocessingImplementationHash": siglip_preprocess_hash,
            "aggregationImplementationHash": aggregate_hash,
            "perView": per_view,
            "aggregate": aggregate,
            "maximumViewDisagreementMillionths": disagreement,
        }
        for image in images:
            image.close()
        if item_index % 8 == 7 or item_index + 1 == len(job["items"]):
            print(json.dumps({"stage": "siglip2", "completed": item_index + 1}), flush=True)
    del text_features, siglip_model, siglip_processor
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()

    print(
        json.dumps(
            {
                "stage": "shape_backbone",
                "model": dino_config["modelId"],
                "sources": len(job["items"]),
            }
        ),
        flush=True,
    )
    dino_processor = AutoImageProcessor.from_pretrained(
        dino_location,
        local_files_only=True,
        use_fast=True,
    )
    dino_model = AutoModel.from_pretrained(
        dino_location,
        local_files_only=True,
        attn_implementation="eager",
    ).to(device)
    dino_model.eval()
    dino_model_hash = digest(
        canonical_json(
            {
                "repository": dino_config["repository"],
                "revision": dino_config["revision"],
                "transformers": transformers.__version__,
                "torch": torch.__version__,
                "torchvision": torchvision.__version__,
                "modelClass": type(dino_model).__name__,
                "processorClass": type(dino_processor).__name__,
                "dtype": "float32",
                "deviceBackend": device,
                "deterministicAlgorithms": True,
                "attentionImplementation": "eager",
                "processorMode": "fast_explicit",
            }
        )
    )
    shape_features: dict[str, dict[str, Any]] = {}
    for item_index, item in enumerate(job["items"]):
        images = [
            Image.open(
                verified_evidence(
                    root,
                    view["normalizedDepthRelativePath"],
                    view["normalizedDepthHash"],
                )
            ).convert("RGB")
            for view in item["views"]
        ]
        image_inputs = dino_processor(
            images=images,
            return_tensors="pt",
            size={"height": 384, "width": 384},
        )
        image_inputs = {key: value.to(device) for key, value in image_inputs.items()}
        with torch.inference_mode():
            outputs = dino_model(**image_inputs)
            vectors = getattr(outputs, "pooler_output", None)
            if vectors is None:
                vectors = outputs.last_hidden_state[:, 0, :]
        per_view, aggregate, disagreement = feature_payload(
            vectors, [view["viewId"] for view in item["views"]]
        )
        shape_features[item["sourceContentHash"]] = {
            "channel": "shape",
            "modelImplementationHash": dino_model_hash,
            "preprocessingImplementationHash": dino_preprocess_hash,
            "aggregationImplementationHash": aggregate_hash,
            "perView": per_view,
            "aggregate": aggregate,
            "maximumViewDisagreementMillionths": disagreement,
        }
        for image in images:
            image.close()
        if item_index % 8 == 7 or item_index + 1 == len(job["items"]):
            print(
                json.dumps({"stage": "shape_backbone", "completed": item_index + 1}),
                flush=True,
            )

    models = [
        model_declaration(dino_config, dino_model_hash),
        model_declaration(siglip_config, siglip_model_hash),
        model_declaration(name_config, name_model_hash),
    ]
    models.sort(key=lambda entry: entry["modelId"])
    items: list[dict[str, Any]] = []
    render_hashes = {entry["sourceContentHash"]: entry["renderEvidenceHash"] for entry in job["items"]}
    for source_hash in sorted(render_hashes):
        items.append(
            {
                "sourceContentHash": source_hash,
                "renderEvidenceHash": render_hashes[source_hash],
                "hypotheses": [name_items[source_hash], visual_items[source_hash]],
                "features": [appearance_features[source_hash], shape_features[source_hash]],
            }
        )
    material = {
        "kind": "CatalogPilotWorkerOutput",
        "pilotPlanHash": job["pilotPlanHash"],
        "jobHash": job["hash"],
        "models": models,
        "items": items,
        "diagnostics": [],
    }
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform != "darwin":
        peak *= 1024
    result = {
        **material,
        "resultHash": digest(canonical_json(material)),
        "execution": {
            "executor": os.environ.get("BASALT_EXECUTION_ADAPTER", "local"),
            "device": device,
            "accelerator": os.environ.get("BASALT_GPU_KIND", device),
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
            "peakResidentBytes": int(peak),
            "processedSourceCount": len(items),
        },
    }
    atomic_json(output_path, result)
    print(json.dumps({"completed": len(items), "resultHash": result["resultHash"]}), flush=True)


if __name__ == "__main__":
    main()
