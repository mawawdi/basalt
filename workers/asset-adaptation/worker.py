"""Fixed, offline asset adaptation worker.

The host supplies one sealed invocation and immutable source files in a private
workspace.  This worker never imports project Python, evaluates source code, or
uses the network.  It converts GLB nodes and the qualified route-neutral
safetensors mesh bundle into canonical, identity-node GLBs and renders the
three fixed Basalt admission views.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import re
import struct
import sys
from array import array
from functools import lru_cache
from typing import Any

import bpy
import numpy as np
from mathutils import Matrix, Vector


WORKER_ID = "basalt-fixed-asset-adaptation-worker"
WORKER_REVISION = "2026-09-10.8"
INVOCATION_ABI = "basalt-fixed-asset-adaptation-invocation@10"
REPORT_ABI = "basalt-fixed-asset-adaptation-report@11"
TENSOR_SCHEMA_HASH = "8adbe6b55bf5e96e351108775faa0bf08d0e0b30bdf1173cb1d836bedcf1c6de"
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_GENERATED_TEXTURE_PIXELS = 4_194_304
MAX_COLLISION_SUPPORT_PATCHES_PER_PART = 32
MAX_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE = 16_384
MAX_ASSET_CONTACT_PATCHES_PER_PART = 32
MAX_ASSET_CONTACT_PATCHES_PER_CANDIDATE = 16_384
IDENTITY = Matrix.Identity(4)
# glTF Y-up (x, y, z) -> Blender Z-up (x, -z, y).
GLTF_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
PREVIEW_VIEWS = (
    ("hero_three_quarter", Vector((1.0, -1.15, 0.68)), 2.35, 55),
    ("opposite_three_quarter", Vector((-1.0, 1.15, 0.58)), 2.35, 55),
    ("top", Vector((0.52, -0.62, 1.72)), 2.55, 58),
)
class AdaptationFailure(RuntimeError):
    pass


def fail(message: str) -> None:
    raise AdaptationFailure(message)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(path: pathlib.Path, maximum: int = MAX_JSON_BYTES) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        fail("Invocation must be an absolute regular file")
    if path.stat().st_size <= 0 or path.stat().st_size > maximum:
        fail("Invocation exceeds its byte policy")
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdaptationFailure("Invocation is not valid JSON") from error
    expected = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if raw != expected + b"\n":
        fail("Invocation JSON is not canonical")
    if not isinstance(value, dict):
        fail("Invocation root must be an object")
    return value


def write_json(path: pathlib.Path, value: Any) -> None:
    if path.exists():
        fail("Worker output already exists")
    path.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_repair_context(value: Any) -> None:
    if value is None:
        return
    required = {
        "kind",
        "abi",
        "action",
        "requestHash",
        "qualificationHash",
        "repairInvocationHash",
        "issueFingerprint",
        "documentHash",
        "anchorHash",
        "sceneHash",
        "observationHashes",
        "currentPreparedAssetHash",
        "currentSourceCandidateHash",
        "currentSourceFingerprint",
        "currentVisualFingerprint",
    }
    hash_fields = required - {"kind", "abi", "action", "observationHashes"}
    observations = value.get("observationHashes") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("kind") != "BasaltAssetRepairContext"
        or value.get("abi") != "basalt-asset-repair@1"
        or value.get("action") not in ("replace_candidate", "refinish")
        or any(not re.fullmatch(r"[a-f0-9]{64}", str(value.get(field, ""))) for field in hash_fields)
        or not isinstance(observations, list)
        or len(observations) > 32
        or observations != sorted(set(observations))
        or any(not re.fullmatch(r"[a-f0-9]{64}", str(item)) for item in observations)
    ):
        fail("Asset repair authority is invalid")


def validate_style_contract(style: Any) -> dict[str, Any]:
    if not isinstance(style, dict):
        fail("Adaptation style contract is absent")
    required = {
        "id",
        "shapeLanguage",
        "silhouetteHierarchy",
        "detailScale",
        "edgeTreatment",
        "materialLanguage",
        "texelDensity",
        "surfaceVariation",
        "wearPolicy",
        "lightingIntent",
        "antiGoals",
        "palette",
        "hash",
    }
    if set(style) != required or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", str(style.get("id", ""))):
        fail("Adaptation style contract shape or identity is invalid")
    if not re.fullmatch(r"[a-f0-9]{64}", str(style.get("hash", ""))):
        fail("Adaptation style contract hash is invalid")
    for field in ("silhouetteHierarchy", "detailScale"):
        hierarchy = style.get(field)
        if (
            not isinstance(hierarchy, list)
            or not 1 <= len(hierarchy) <= 8
            or any(
                not isinstance(entry, dict)
                or set(entry) != {"level", "guidance"}
                or not isinstance(entry.get("level"), str)
                or not 1 <= len(entry["level"].strip()) <= 160
                or not isinstance(entry.get("guidance"), str)
                or not 1 <= len(entry["guidance"].strip()) <= 1024
                for entry in hierarchy
            )
            or len({entry["level"] for entry in hierarchy}) != len(hierarchy)
        ):
            fail(f"Adaptation style {field} authority is invalid")
    texel = style.get("texelDensity")
    if (
        not isinstance(texel, dict)
        or set(texel) != {
            "minimumPixelsPerStud",
            "targetPixelsPerStud",
            "maximumPixelsPerStud",
        }
        or any(not finite_number(texel.get(key)) or float(texel[key]) <= 0 for key in texel)
        or not float(texel["minimumPixelsPerStud"])
        <= float(texel["targetPixelsPerStud"])
        <= float(texel["maximumPixelsPerStud"])
    ):
        fail("Adaptation style texel-density authority is invalid")
    variation = style.get("surfaceVariation")
    if (
        not isinstance(variation, dict)
        or set(variation) != {"scaleStuds", "intensity", "guidance"}
        or not finite_number(variation.get("scaleStuds"))
        or float(variation["scaleStuds"]) <= 0
        or not finite_number(variation.get("intensity"))
        or not 0 <= float(variation["intensity"]) <= 1
        or not isinstance(variation.get("guidance"), str)
        or not variation["guidance"].strip()
    ):
        fail("Adaptation surface-variation authority is invalid")
    wear = style.get("wearPolicy")
    if (
        not isinstance(wear, dict)
        or set(wear) != {"amount", "placement", "exclusions"}
        or not finite_number(wear.get("amount"))
        or not 0 <= float(wear["amount"]) <= 1
        or not isinstance(wear.get("placement"), str)
        or not wear["placement"].strip()
        or not isinstance(wear.get("exclusions"), list)
        or any(not isinstance(value, str) or not value.strip() for value in wear["exclusions"])
    ):
        fail("Adaptation wear-policy authority is invalid")
    palette = style.get("palette")
    if not isinstance(palette, list) or not palette or len(palette) > 32:
        fail("Adaptation style palette is absent or unbounded")
    identifiers: set[str] = set()
    for entry in palette:
        if (
            not isinstance(entry, dict)
            or set(entry) not in (
                {"id", "name", "color", "metallic", "roughness"},
                {"id", "name", "color", "metallic", "roughness", "emissive"},
            )
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", str(entry.get("id", "")))
            or not isinstance(entry.get("name"), str)
            or not entry["name"].strip()
            or not re.fullmatch(r"#[0-9a-fA-F]{6}", str(entry.get("color", "")))
            or ("emissive" in entry and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(entry["emissive"])))
            or not finite_number(entry.get("roughness"))
            or not finite_number(entry.get("metallic"))
            or not 0 <= float(entry["roughness"]) <= 1
            or not 0 <= float(entry["metallic"]) <= 1
            or entry["id"] in identifiers
        ):
            fail("Adaptation style palette entry is invalid")
        identifiers.add(entry["id"])
    return style


def declared_palette_entry(
    style: dict[str, Any], role: dict[str, Any]
) -> dict[str, Any] | None:
    policy = role.get("materialAdaptation")
    if not isinstance(policy, dict) or policy.get("kind") not in (
        "preserve_source",
        "harmonize",
        "synthesize",
    ):
        fail("Material role adaptation policy is invalid")
    if policy["kind"] == "preserve_source":
        if set(policy) != {"kind"}:
            fail("Source-preservation policy contains undeclared fields")
        return None
    if policy["kind"] == "synthesize":
        if set(policy) != {"kind", "graph"}:
            fail("Synthesized material policy shape is invalid")
        validate_material_graph(style, policy.get("graph"))
        return None
    if set(policy) != {"kind", "paletteEntryId", "strength"}:
        fail("Material adaptation policy shape is invalid")
    if (
        not finite_number(policy.get("strength"))
        or not 0 <= float(policy["strength"]) <= 1
    ):
        fail("Material harmonization strength is invalid")
    palette = next(
        (entry for entry in style["palette"] if entry["id"] == policy.get("paletteEntryId")),
        None,
    )
    if palette is None:
        fail("Material adaptation names an absent style palette entry")
    return palette


def graph_integer(value: Any, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def graph_interval(value: Any) -> bool:
    return finite_number(value) and 0 <= float(value) <= 1


def validate_graph_frequency(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"u", "v"}
        or any(not graph_integer(value.get(axis), 1, 256) for axis in ("u", "v"))
    ):
        fail("Procedural material tile frequency is invalid")


def validate_graph_color(
    style_entries: dict[str, dict[str, Any]], value: Any
) -> None:
    if not isinstance(value, dict) or value.get("kind") not in ("literal", "palette"):
        fail("Procedural material color source is invalid")
    if value["kind"] == "literal":
        if set(value) != {"kind", "color"} or not re.fullmatch(
            r"#[0-9a-fA-F]{6}", str(value.get("color", ""))
        ):
            fail("Procedural material literal color is invalid")
        return
    if (
        set(value) != {"kind", "paletteEntryId", "channel"}
        or value.get("channel") not in ("base_color", "emissive")
        or value.get("paletteEntryId") not in style_entries
        or (
            value.get("channel") == "emissive"
            and "emissive" not in style_entries[value["paletteEntryId"]]
        )
    ):
        fail("Procedural material palette color authority is invalid")


def material_graph_node_type(node: dict[str, Any]) -> str:
    if node.get("kind") in (
        "surface_coordinates",
        "coordinate_transform",
        "polar_coordinates",
    ):
        return "coordinate"
    return (
        "color"
        if node.get("kind") in ("color_constant", "color_ramp", "color_mix")
        else "scalar"
    )


def material_graph_node_references(node: dict[str, Any]) -> list[tuple[str, str]]:
    kind = node["kind"]
    if kind in (
        "wave",
        "checker",
        "brick",
        "noise",
        "cellular",
        "motif",
        "coordinate_gradient",
    ):
        return [(node["coordinateNodeId"], "coordinate")]
    if kind in ("coordinate_transform", "polar_coordinates"):
        return [(node["inputNodeId"], "coordinate")]
    if kind == "scalar_math":
        return [(node["leftNodeId"], "scalar"), (node["rightNodeId"], "scalar")]
    if kind == "scalar_mix":
        return [
            (node["firstNodeId"], "scalar"),
            (node["secondNodeId"], "scalar"),
            (node["factorNodeId"], "scalar"),
        ]
    if kind in ("remap", "smoothstep", "invert", "color_ramp"):
        return [(node["inputNodeId"], "scalar")]
    if kind == "quantize":
        result = [(node["inputNodeId"], "scalar")]
        if "ditherNodeId" in node:
            result.append((node["ditherNodeId"], "scalar"))
        return result
    if kind == "color_mix":
        return [
            (node["baseNodeId"], "color"),
            (node["layerNodeId"], "color"),
            (node["factorNodeId"], "scalar"),
        ]
    return []


def material_graph_evaluation_cost(graph: dict[str, Any]) -> int:
    result = 0
    for node in graph["nodes"]:
        kind = node["kind"]
        if kind == "noise":
            result += int(node["octaves"]) * 4
            if "domainWarp" in node:
                result += int(node["domainWarp"]["octaves"]) * 8
        elif kind == "cellular":
            result += 18
        elif kind in ("brick", "motif"):
            result += 4
        elif kind == "surface_coordinates":
            result += 8 if node["projection"]["kind"] == "triplanar" else 1
        elif kind == "coordinate_transform":
            result += 3
        elif kind == "polar_coordinates":
            result += 4
        elif kind == "color_ramp":
            result += len(node["stops"])
        else:
            result += 1
    return result


def material_graph_palette_entry_ids(graph: dict[str, Any]) -> list[str]:
    identifiers: set[str] = set()
    for node in graph["nodes"]:
        if node["kind"] == "palette_property":
            identifiers.add(node["paletteEntryId"])
        color_values = (
            [node["value"]]
            if node["kind"] == "color_constant"
            else [stop["color"] for stop in node["stops"]]
            if node["kind"] == "color_ramp"
            else []
        )
        for value in color_values:
            if value["kind"] == "palette":
                identifiers.add(value["paletteEntryId"])
    return sorted(identifiers)


def material_graph_context_sources(graph: dict[str, Any]) -> list[str]:
    return sorted(
        {
            node["source"]
            for node in graph["nodes"]
            if node["kind"] == "context_field"
        }
    )


def material_graph_uses_triplanar_coordinates(graph: dict[str, Any]) -> bool:
    return any(
        node["kind"] == "surface_coordinates"
        and node["projection"]["kind"] == "triplanar"
        for node in graph["nodes"]
    )


def material_graph_lowering_report(
    graph: dict[str, Any], profile: dict[str, float | int], role: dict[str, Any]
) -> dict[str, Any]:
    context_sources = material_graph_context_sources(graph)
    channels = ["base_color_opacity", "occlusion_roughness_metallic"]
    losses = [
        "procedural_state_baked_to_raster_textures",
        "scalar_channels_quantized_and_packed",
    ]
    if graph["outputs"]["normal"]["kind"] == "height_gradient":
        channels.append("tangent_space_normal")
        losses.append("height_displacement_reduced_to_tangent_normal")
    if "emissiveNodeId" in graph["outputs"]:
        channels.append("emissive")
    if context_sources:
        losses.append("context_fields_frozen_to_adapted_mesh")
    if material_graph_uses_triplanar_coordinates(graph):
        losses.append("triplanar_projection_baked_to_uv0")
    if role["opacity"]["kind"] == "opaque":
        losses.append("opacity_output_discarded_by_opaque_role")
    return {
        "target": graph["robloxLowering"]["target"],
        "textureChannels": channels,
        "texelDensity": {
            "authority": graph["texelDensity"]["authority"],
            "targetScale": float(graph["texelDensity"]["targetScale"]),
            "uPixelsPerStud": float(profile["uPixelsPerStud"]),
            "vPixelsPerStud": float(profile["vPixelsPerStud"]),
        },
        "bakedContextFields": context_sources,
        "losses": sorted(losses),
    }


def validate_material_graph(style: dict[str, Any], graph: Any) -> dict[str, Any]:
    if (
        not isinstance(graph, dict)
        or set(graph) != {
            "kind",
            "abi",
            "seed",
            "texelDensity",
            "robloxLowering",
            "nodes",
            "outputs",
            "hash",
        }
        or graph.get("kind") != "ProceduralMaterialGraph"
        or graph.get("abi") != "basalt-procedural-material-graph@2"
        or not graph_integer(graph.get("seed"), 0, 2_147_483_647)
        or not re.fullmatch(r"[a-f0-9]{64}", str(graph.get("hash", "")))
    ):
        fail("Procedural material graph shape or identity is invalid")
    material = {key: value for key, value in graph.items() if key != "hash"}
    encoded = json.dumps(
        material, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    if hashlib.sha256(encoded).hexdigest() != graph["hash"]:
        fail("Procedural material graph identity is invalid")
    texel_density = graph.get("texelDensity")
    if (
        not isinstance(texel_density, dict)
        or set(texel_density) != {"authority", "targetScale"}
        or texel_density.get("authority") != "style_contract"
        or not finite_number(texel_density.get("targetScale"))
        or not 0.25 <= float(texel_density["targetScale"]) <= 4
    ):
        fail("Procedural material texel-density authority is invalid")
    effective_density = float(style["texelDensity"]["targetPixelsPerStud"]) * float(
        texel_density["targetScale"]
    )
    if not (
        float(style["texelDensity"]["minimumPixelsPerStud"])
        <= effective_density
        <= float(style["texelDensity"]["maximumPixelsPerStud"])
    ):
        fail("Procedural material target density leaves the style-authorized interval")
    if graph.get("robloxLowering") != {
        "target": "surface_appearance",
        "proceduralState": "bake_to_textures",
        "lossPolicy": "record_exact",
    }:
        fail("Procedural material Roblox lowering policy is invalid")
    nodes = graph.get("nodes")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 96:
        fail("Procedural material node inventory is invalid")
    identifiers = [node.get("id") for node in nodes if isinstance(node, dict)]
    if (
        len(identifiers) != len(nodes)
        or any(
            not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", str(identifier))
            for identifier in identifiers
        )
        or identifiers != sorted(set(identifiers))
    ):
        fail("Procedural material nodes must be unique and canonical")
    style_entries = {entry["id"]: entry for entry in style["palette"]}
    scalar_simple = {"scalar_constant", "invert", "palette_property", "context_field"}
    supported = scalar_simple | {
        "wave",
        "checker",
        "brick",
        "noise",
        "cellular",
        "motif",
        "scalar_math",
        "scalar_mix",
        "remap",
        "smoothstep",
        "quantize",
        "color_constant",
        "color_ramp",
        "color_mix",
        "surface_coordinates",
        "coordinate_transform",
        "polar_coordinates",
        "coordinate_gradient",
    }
    for node in nodes:
        kind = node.get("kind")
        if kind not in supported:
            fail("Procedural material node kind is unsupported")
        if kind == "scalar_constant":
            valid = set(node) == {"id", "kind", "value"} and finite_number(
                node.get("value")
            ) and -16 <= float(node["value"]) <= 16
        elif kind == "wave":
            cycles = node.get("cycles")
            valid = (
                set(node)
                == {
                    "id",
                    "kind",
                    "waveform",
                    "coordinateNodeId",
                    "cycles",
                    "phase",
                    "dutyCycle",
                    "softness",
                }
                and node.get("waveform") in ("sine", "triangle", "saw", "square")
                and isinstance(cycles, dict)
                and set(cycles) == {"u", "v"}
                and all(graph_integer(cycles.get(axis), -256, 256) for axis in ("u", "v"))
                and (cycles["u"] != 0 or cycles["v"] != 0)
                and finite_number(node.get("phase"))
                and -1024 <= float(node["phase"]) <= 1024
                and graph_interval(node.get("dutyCycle"))
                and 0 < float(node["dutyCycle"]) < 1
                and graph_interval(node.get("softness"))
            )
        elif kind in ("checker", "brick", "noise", "cellular", "motif"):
            validate_graph_frequency(node.get("cells"))
            valid = True
            if kind == "checker":
                offset = node.get("offset")
                valid = (
                    set(node) == {"id", "kind", "coordinateNodeId", "cells", "offset", "softness"}
                    and isinstance(offset, dict)
                    and set(offset) == {"u", "v"}
                    and all(finite_number(offset.get(axis)) and -1024 <= float(offset[axis]) <= 1024 for axis in ("u", "v"))
                    and graph_interval(node.get("softness"))
                )
            elif kind == "brick":
                valid = (
                    set(node) == {"id", "kind", "coordinateNodeId", "cells", "rowOffset", "mortarFraction", "edgeSoftness"}
                    and graph_interval(node.get("rowOffset"))
                    and finite_number(node.get("mortarFraction"))
                    and 0 <= float(node["mortarFraction"]) <= 0.45
                    and graph_interval(node.get("edgeSoftness"))
                )
            elif kind == "noise":
                warp = node.get("domainWarp")
                valid = (
                    set(node) in (
                        {"id", "kind", "coordinateNodeId", "basis", "cells", "octaves", "lacunarity", "gain", "seedOffset"},
                        {"id", "kind", "coordinateNodeId", "basis", "cells", "octaves", "lacunarity", "gain", "seedOffset", "domainWarp"},
                    )
                    and node.get("basis") in ("value_fbm", "billow_fbm", "ridged_fbm")
                    and graph_integer(node.get("octaves"), 1, 8)
                    and graph_integer(node.get("lacunarity"), 2, 4)
                    and graph_interval(node.get("gain"))
                    and graph_integer(node.get("seedOffset"), 0, 65_535)
                )
                if warp is not None:
                    valid = valid and isinstance(warp, dict) and set(warp) == {"cells", "amplitude", "octaves"}
                    if isinstance(warp, dict):
                        validate_graph_frequency(warp.get("cells"))
                        valid = valid and finite_number(warp.get("amplitude")) and 0 <= float(warp["amplitude"]) <= 0.5 and graph_integer(warp.get("octaves"), 1, 4)
            elif kind == "cellular":
                valid = (
                    set(node) == {"id", "kind", "coordinateNodeId", "cells", "metric", "output", "jitter", "seedOffset"}
                    and node.get("metric") in ("euclidean", "manhattan")
                    and node.get("output") in ("distance", "edge_distance", "cell_value")
                    and graph_interval(node.get("jitter"))
                    and graph_integer(node.get("seedOffset"), 0, 65_535)
                )
            else:
                center = node.get("center")
                size = node.get("size")
                valid = (
                    set(node) == {"id", "kind", "coordinateNodeId", "shape", "cells", "center", "size", "rotationDegrees", "edgeSoftness"}
                    and node.get("shape") in ("ellipse", "box", "diamond")
                    and isinstance(center, dict)
                    and set(center) == {"u", "v"}
                    and all(graph_interval(center.get(axis)) for axis in ("u", "v"))
                    and isinstance(size, dict)
                    and set(size) == {"u", "v"}
                    and all(finite_number(size.get(axis)) and 0 < float(size[axis]) <= 1 for axis in ("u", "v"))
                    and finite_number(node.get("rotationDegrees"))
                    and -360 <= float(node["rotationDegrees"]) <= 360
                    and graph_interval(node.get("edgeSoftness"))
                )
        elif kind == "surface_coordinates":
            projection = node.get("projection")
            valid = (
                set(node) == {"id", "kind", "projection"}
                and isinstance(projection, dict)
                and projection.get("kind") in ("uv0", "triplanar")
            )
            if isinstance(projection, dict) and projection.get("kind") == "uv0":
                valid = valid and set(projection) == {"kind"}
            elif isinstance(projection, dict) and projection.get("kind") == "triplanar":
                scale = projection.get("scaleStuds")
                valid = (
                    valid
                    and set(projection) == {"kind", "scaleStuds", "blendExponent"}
                    and isinstance(scale, dict)
                    and set(scale) == {"u", "v"}
                    and all(
                        finite_number(scale.get(axis))
                        and 0 < float(scale[axis]) <= 100_000
                        for axis in ("u", "v")
                    )
                    and finite_number(projection.get("blendExponent"))
                    and 1 <= float(projection["blendExponent"]) <= 32
                )
        elif kind == "coordinate_transform":
            translation = node.get("translation")
            scale = node.get("scale")
            pivot = node.get("pivot")
            valid = (
                set(node) == {"id", "kind", "inputNodeId", "translation", "rotationDegrees", "scale", "pivot", "wrap"}
                and all(
                    isinstance(value, dict)
                    and set(value) == {"u", "v"}
                    for value in (translation, scale, pivot)
                )
                and all(finite_number(translation.get(axis)) and -16 <= float(translation[axis]) <= 16 for axis in ("u", "v"))
                and all(finite_number(pivot.get(axis)) and -16 <= float(pivot[axis]) <= 16 for axis in ("u", "v"))
                and all(finite_number(scale.get(axis)) and 0 < float(scale[axis]) <= 256 for axis in ("u", "v"))
                and finite_number(node.get("rotationDegrees"))
                and -360 <= float(node["rotationDegrees"]) <= 360
                and node.get("wrap") in ("repeat", "mirror")
            )
        elif kind == "polar_coordinates":
            center = node.get("center")
            valid = (
                set(node) == {"id", "kind", "inputNodeId", "center", "radialScale", "angularOffset"}
                and isinstance(center, dict)
                and set(center) == {"u", "v"}
                and all(finite_number(center.get(axis)) and -16 <= float(center[axis]) <= 16 for axis in ("u", "v"))
                and finite_number(node.get("radialScale"))
                and 0 < float(node["radialScale"]) <= 256
                and finite_number(node.get("angularOffset"))
                and -1024 <= float(node["angularOffset"]) <= 1024
            )
        elif kind == "coordinate_gradient":
            valid = (
                set(node) == {"id", "kind", "coordinateNodeId", "axis", "low", "high", "clamp", "invert"}
                and node.get("axis") in ("u", "v")
                and all(finite_number(node.get(field)) and -16 <= float(node[field]) <= 16 for field in ("low", "high"))
                and float(node["low"]) < float(node["high"])
                and isinstance(node.get("clamp"), bool)
                and isinstance(node.get("invert"), bool)
            )
        elif kind == "scalar_math":
            valid = set(node) == {"id", "kind", "operation", "leftNodeId", "rightNodeId"} and node.get("operation") in ("add", "subtract", "multiply", "minimum", "maximum")
        elif kind == "scalar_mix":
            valid = set(node) == {"id", "kind", "firstNodeId", "secondNodeId", "factorNodeId"}
        elif kind == "remap":
            valid = (
                set(node) == {"id", "kind", "inputNodeId", "inputMinimum", "inputMaximum", "outputMinimum", "outputMaximum", "clamp"}
                and all(finite_number(node.get(field)) and -16 <= float(node[field]) <= 16 for field in ("inputMinimum", "inputMaximum", "outputMinimum", "outputMaximum"))
                and float(node["inputMinimum"]) < float(node["inputMaximum"])
                and isinstance(node.get("clamp"), bool)
            )
        elif kind == "smoothstep":
            valid = (
                set(node) == {"id", "kind", "inputNodeId", "low", "high"}
                and all(finite_number(node.get(field)) and -16 <= float(node[field]) <= 16 for field in ("low", "high"))
                and float(node["low"]) < float(node["high"])
            )
        elif kind == "invert":
            valid = set(node) == {"id", "kind", "inputNodeId"}
        elif kind == "quantize":
            valid = (
                set(node) in (
                    {"id", "kind", "inputNodeId", "steps", "ditherStrength"},
                    {"id", "kind", "inputNodeId", "steps", "ditherNodeId", "ditherStrength"},
                )
                and graph_integer(node.get("steps"), 2, 64)
                and graph_interval(node.get("ditherStrength"))
            )
        elif kind == "palette_property":
            valid = (
                set(node) == {"id", "kind", "paletteEntryId", "property"}
                and node.get("paletteEntryId") in style_entries
                and node.get("property") in ("roughness", "metallic")
            )
        elif kind == "context_field":
            valid = (
                set(node) == {"id", "kind", "source", "invert"}
                and node.get("source")
                in (
                    "height_fraction",
                    "normal_x",
                    "normal_y",
                    "normal_z",
                    "upward_facing",
                    "slope",
                    "curvature",
                    "contact",
                    "edge_wear",
                )
                and isinstance(node.get("invert"), bool)
            )
        elif kind == "color_constant":
            valid = set(node) == {"id", "kind", "value"}
            validate_graph_color(style_entries, node.get("value"))
        elif kind == "color_ramp":
            stops = node.get("stops")
            valid = (
                set(node) == {"id", "kind", "inputNodeId", "interpolation", "stops"}
                and node.get("interpolation") in ("constant", "linear", "smooth")
                and isinstance(stops, list)
                and 2 <= len(stops) <= 16
            )
            if isinstance(stops, list):
                positions = []
                for stop in stops:
                    if not isinstance(stop, dict) or set(stop) != {"position", "color"} or not graph_interval(stop.get("position")):
                        valid = False
                        continue
                    positions.append(float(stop["position"]))
                    validate_graph_color(style_entries, stop.get("color"))
                valid = (
                    valid
                    and len(positions) == len(stops)
                    and positions[0] == 0
                    and positions[-1] == 1
                    and all(
                        positions[index - 1] < positions[index]
                        for index in range(1, len(positions))
                    )
                )
        else:
            valid = set(node) == {"id", "kind", "baseNodeId", "layerNodeId", "factorNodeId", "operation"} and node.get("operation") in ("mix", "multiply", "screen", "overlay", "add")
        if not valid:
            fail(f"Procedural material node is invalid: {kind}")
    by_id = {node["id"]: node for node in nodes}
    dependencies: dict[str, list[str]] = {}
    for node in nodes:
        references = material_graph_node_references(node)
        dependencies[node["id"]] = [identifier for identifier, _ in references]
        for identifier, expected_type in references:
            if identifier not in by_id or material_graph_node_type(by_id[identifier]) != expected_type:
                fail("Procedural material node reference is absent or mistyped")
    outputs = graph.get("outputs")
    required_outputs = {
        "baseColorNodeId",
        "roughnessNodeId",
        "metallicNodeId",
        "occlusionNodeId",
        "opacityNodeId",
        "normal",
    }
    if not isinstance(outputs, dict) or set(outputs) not in (
        required_outputs,
        required_outputs | {"emissiveNodeId"},
    ):
        fail("Procedural material outputs are invalid")
    for field, expected_type in (
        ("baseColorNodeId", "color"),
        ("roughnessNodeId", "scalar"),
        ("metallicNodeId", "scalar"),
        ("occlusionNodeId", "scalar"),
        ("opacityNodeId", "scalar"),
        ("emissiveNodeId", "color"),
    ):
        if field in outputs and (
            outputs[field] not in by_id
            or material_graph_node_type(by_id[outputs[field]]) != expected_type
        ):
            fail("Procedural material output reference is absent or mistyped")
    normal = outputs["normal"]
    if not isinstance(normal, dict) or normal.get("kind") not in ("flat", "height_gradient"):
        fail("Procedural material normal output is invalid")
    if normal["kind"] == "flat":
        if set(normal) != {"kind"}:
            fail("Flat procedural material normal output is invalid")
    elif (
        set(normal) != {"kind", "heightNodeId", "amplitudeStuds"}
        or normal.get("heightNodeId") not in by_id
        or material_graph_node_type(by_id[normal["heightNodeId"]]) != "scalar"
        or not finite_number(normal.get("amplitudeStuds"))
        or not 0 < float(normal["amplitudeStuds"]) <= 10
    ):
        fail("Height-gradient procedural material normal output is invalid")
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(identifier: str) -> None:
        if identifier in visiting:
            fail("Procedural material node graph contains a cycle")
        if identifier in visited:
            return
        visiting.add(identifier)
        for dependency in dependencies[identifier]:
            visit(dependency)
        visiting.remove(identifier)
        visited.add(identifier)

    for identifier in identifiers:
        visit(identifier)
    if material_graph_evaluation_cost(graph) > 384:
        fail("Procedural material graph exceeds its deterministic evaluation budget")
    return graph


def validate_shading_policy(role: dict[str, Any]) -> None:
    shading = role.get("shading")
    if (
        not isinstance(shading, dict)
        or set(shading) != {"surfaceNormals", "normalTexture"}
        or shading.get("surfaceNormals") not in ("preserve_source", "flat", "smooth")
    ):
        fail("Material role shading policy is invalid")
    normal = shading.get("normalTexture")
    if not isinstance(normal, dict) or normal.get("kind") not in (
        "preserve_source",
        "omit",
        "synthesize",
    ):
        fail("Material role normal-texture policy is invalid")
    if normal["kind"] in ("preserve_source", "omit"):
        if set(normal) != {"kind"}:
            fail("Normal-texture policy contains undeclared fields")
    elif set(normal) != {"kind", "strength"} or (
        not finite_number(normal.get("strength"))
        or not 0 <= float(normal["strength"]) <= 1
    ):
        fail("Synthesized normal-texture strength is invalid")


def validate_opacity_policy(role: dict[str, Any]) -> None:
    opacity = role.get("opacity")
    if not isinstance(opacity, dict) or opacity.get("kind") not in ("opaque", "mask", "blend"):
        fail("Material role opacity policy is invalid")
    if opacity["kind"] == "opaque":
        if set(opacity) != {"kind"}:
            fail("Opaque material policy contains undeclared fields")
        return
    if opacity["kind"] == "mask":
        if (
            set(opacity) != {"kind", "source", "cutoff"}
            or opacity.get("source") != "source_texture_or_attribute"
            or not finite_number(opacity.get("cutoff"))
            or not 0 <= float(opacity["cutoff"]) <= 1
        ):
            fail("Masked material policy is invalid")
        return
    source = opacity.get("source")
    if not isinstance(source, dict) or source.get("kind") not in (
        "source_texture_or_attribute",
        "constant",
    ):
        fail("Blended material alpha source is invalid")
    if source["kind"] == "source_texture_or_attribute":
        if set(source) != {"kind"}:
            fail("Texture-backed blend policy contains undeclared fields")
    elif (
        set(source) != {"kind", "alpha"}
        or not finite_number(source.get("alpha"))
        or not 0 <= float(source["alpha"]) < 1
    ):
        fail("Constant blend policy is invalid")


def validate_edge_treatment_policy(role: dict[str, Any]) -> None:
    edge = role.get("edgeTreatment")
    if not isinstance(edge, dict) or edge.get("kind") not in ("suppressed", "treated"):
        fail("Material role edge-treatment policy is invalid")
    if edge["kind"] == "suppressed":
        if set(edge) != {"kind", "reason"} or not isinstance(edge.get("reason"), str) or not edge["reason"].strip():
            fail("Suppressed edge-treatment policy is invalid")
        return
    if (
        set(edge) != {"kind", "profile", "widthStuds", "segments", "strength", "description"}
        or not isinstance(edge.get("profile"), str)
        or not edge["profile"].strip()
        or not finite_number(edge.get("widthStuds"))
        or float(edge["widthStuds"]) <= 0
        or not isinstance(edge.get("segments"), int)
        or isinstance(edge.get("segments"), bool)
        or not 1 <= int(edge["segments"]) <= 8
        or not finite_number(edge.get("strength"))
        or not 0 <= float(edge["strength"]) <= 1
        or not isinstance(edge.get("description"), str)
        or not edge["description"].strip()
    ):
        fail("Treated edge-treatment policy is invalid")


def material_finish_seed(invocation: dict[str, Any], role: dict[str, Any]) -> str:
    style = invocation["styleContract"]
    if role["materialAdaptation"]["kind"] == "synthesize":
        return f"{role['id']}:{role['materialAdaptation']['graph']['hash']}"
    repair = invocation.get("repair")
    repair_identity = repair["repairInvocationHash"] if isinstance(repair, dict) else "initial-adaptation"
    return (
        f"{role['id']}:"
        f"{json.dumps(role['materialAdaptation'], sort_keys=True, separators=(',', ':'))}:"
        f"{json.dumps(role['shading'], sort_keys=True, separators=(',', ':'))}:"
        f"{style['surfaceVariation']['scaleStuds']}:{style['surfaceVariation']['intensity']}:"
        f"{style['wearPolicy']['amount']}:"
        f"{repair_identity}"
    )


def texture_profile(
    style: dict[str, Any],
    role: dict[str, Any],
    maximum_edge: int,
    obj: bpy.types.Object | None = None,
    studs_per_unit: float | None = None,
    material_index: int | None = None,
) -> dict[str, float | int]:
    projection = role.get("projection")
    mode = projection.get("mode") if isinstance(projection, dict) else None
    if mode not in ("mesh_uv", "asset_planar", "asset_triplanar", "trim_hotspot"):
        fail("Material role has an unsupported projection mode")
    scale = projection.get("scaleStuds") if isinstance(projection, dict) else None
    if mode == "trim_hotspot":
        trim_sheet = projection.get("trimSheet")
        if not isinstance(trim_sheet, dict) or not isinstance(trim_sheet.get("bands"), list) or not trim_sheet.get("bands"):
            fail("Trim-hotspot projection requires a valid trim sheet specification with bands")
    else:
        if (
            not isinstance(scale, dict)
            or set(scale) != {"u", "v"}
            or any(not finite_number(scale.get(axis)) or float(scale[axis]) <= 0 for axis in ("u", "v"))
        ):
            fail("Material role has no valid metric projection scale")
    if mode == "asset_planar":
        frame = projection.get("frame")
        axes = {"+X", "-X", "+Y", "-Y", "+Z", "-Z"}
        if (
            not isinstance(frame, dict)
            or set(frame) != {"origin", "uAxis", "vAxis"}
            or frame.get("origin") != "canonical_asset_origin"
            or frame.get("uAxis") not in axes
            or frame.get("vAxis") not in axes
            or str(frame["uAxis"])[1:] == str(frame["vAxis"])[1:]
        ):
            fail("Asset-planar projection requires an orthogonal canonical frame")
    if mode == "asset_triplanar" and (
        set(projection) != {"mode", "scaleStuds", "blendExponent"}
        or not finite_number(projection.get("blendExponent"))
        or not 1 <= float(projection["blendExponent"]) <= 32
    ):
        fail("Asset-triplanar projection requires a bounded blend exponent")
    texel = style["texelDensity"]
    density_scale = (
        float(role["materialAdaptation"]["graph"]["texelDensity"]["targetScale"])
        if role["materialAdaptation"]["kind"] == "synthesize"
        else 1.0
    )
    target_pixels_per_stud = float(texel["targetPixelsPerStud"]) * density_scale
    if not (
        float(texel["minimumPixelsPerStud"])
        <= target_pixels_per_stud
        <= float(texel["maximumPixelsPerStud"])
    ):
        fail("Material target density leaves the style-authorized interval")

    def axis_profile(scale_studs: float) -> tuple[int, float]:
        target = target_pixels_per_stud * scale_studs
        dimension = min(maximum_edge, max(1, math.floor(target + 0.5)))
        density = dimension / scale_studs
        if (
            density + 1e-6 < float(texel["minimumPixelsPerStud"])
            or density - 1e-6 > float(texel["maximumPixelsPerStud"])
        ):
            fail(
                "Style texel density cannot be represented within the asset texture budget: "
                f"mode={mode}, material={material_index}, dimension={dimension}, "
                f"density={density:.9f}, interval="
                f"[{float(texel['minimumPixelsPerStud']):.9f},"
                f"{float(texel['maximumPixelsPerStud']):.9f}]"
            )
        return dimension, density

    if mode == "asset_planar":
        width, u_density = axis_profile(float(scale["u"]))
        height, v_density = axis_profile(float(scale["v"]))
    elif mode == "trim_hotspot":
        trim_spec = projection["trimSheet"]
        res = trim_spec.get("resolution", {"width": 2048, "height": 2048})
        width = min(maximum_edge, int(res.get("width", 2048)))
        height = min(maximum_edge, int(res.get("height", 2048)))
        u_density = float(trim_spec.get("targetTexelDensity", target_pixels_per_stud))
        v_density = u_density
    else:
        if obj is None or studs_per_unit is None or studs_per_unit <= 0:
            fail("Atlas texture sizing requires adapted geometry and its physical scale")
        measurement = material_uv_metrics(
            obj,
            material_index if material_index is not None else 0,
            "TextureProfile",
            1,
            1,
            studs_per_unit,
        )
        density = measurement["pixelsPerStud"]
        if density["p05"] <= 1e-12 or density["p95"] <= 1e-12:
            fail("Atlas texture sizing requires nondegenerate final UVs")
        minimum_dimension = max(
            1,
            math.ceil(float(texel["minimumPixelsPerStud"]) / density["p05"] - 1e-9),
        )
        requested = max(
            1,
            math.floor(target_pixels_per_stud / density["areaWeightedRms"] + 0.5),
        )
        if minimum_dimension > maximum_edge:
            fail(
                "Style texel density cannot be represented within the asset texture budget: "
                f"mode={mode}, material={material_index}, requiredMinimumEdge={minimum_dimension}, "
                f"deliveryMaximumEdge={maximum_edge}, "
                f"unitP05={density['p05']:.9f}, unitP95={density['p95']:.9f}, interval="
                f"[{float(texel['minimumPixelsPerStud']):.9f},"
                f"{float(texel['maximumPixelsPerStud']):.9f}]"
            )
        width = height = min(maximum_edge, max(minimum_dimension, requested))
        u_density = v_density = width * density["areaWeightedRms"]
        if u_density - 1e-6 > float(texel["maximumPixelsPerStud"]):
            fail(
                "Style texel density cannot be represented within the asset texture budget: "
                f"mode={mode}, material={material_index}, selectedEdge={width}, "
                f"areaWeightedRms={u_density:.9f}, maximum="
                f"{float(texel['maximumPixelsPerStud']):.9f}"
            )
    if width * height > MAX_GENERATED_TEXTURE_PIXELS:
        fail("Style texture profile exceeds the fixed adaptation work budget")
    return {
        "width": width,
        "height": height,
        "uPixelsPerStud": u_density,
        "vPixelsPerStud": v_density,
    }


def validate_invocation(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("kind") != "FixedAssetAdaptationInvocation" or value.get("abi") != INVOCATION_ABI:
        fail("Unsupported adaptation invocation")
    fields = {
        "kind",
        "abi",
        "sourceCandidateHash",
        "intentHash",
        "styleContract",
        "requiredTextureChannels",
        "delivery",
        "surfacePlacement",
        "materialRoles",
        "sources",
        "parts",
    }
    if set(value) not in (fields, fields | {"repair"}):
        fail("Adaptation invocation contains undeclared fields")
    validate_repair_context(value.get("repair"))
    sources = value.get("sources")
    parts = value.get("parts")
    delivery = value.get("delivery")
    roles = value.get("materialRoles")
    channels = value.get("requiredTextureChannels")
    surface_placement = value.get("surfacePlacement")
    style = validate_style_contract(value.get("styleContract"))
    if not isinstance(sources, list) or not sources or len(sources) > 512:
        fail("Adaptation requires a bounded source inventory")
    if not isinstance(parts, list) or not parts or len(parts) > 512:
        fail("Adaptation requires a bounded part inventory")
    if not isinstance(delivery, dict) or not isinstance(roles, list) or not roles:
        fail("Adaptation delivery or material policy is absent")
    if not isinstance(channels, list) or "base_color" not in channels:
        fail("Adaptation requires a base-color texture contract")
    if not isinstance(surface_placement, dict) or surface_placement.get("kind") not in (
        "none",
        "surface_contact",
    ):
        fail("Adaptation surface-placement contract is invalid")
    if surface_placement["kind"] == "none":
        if set(surface_placement) != {"kind"}:
            fail("No-contact surface placement contains undeclared fields")
    else:
        if set(surface_placement) != {
            "kind",
            "mode",
            "outwardNormal",
            "requiredSurfaceKinds",
        }:
            fail("Surface-contact placement contains undeclared fields")
        if surface_placement.get("mode") not in (
            "resting",
            "embedded",
            "attached",
            "suspended",
        ):
            fail("Surface-contact mode is invalid")
        normal = surface_placement.get("outwardNormal")
        if not isinstance(normal, dict) or set(normal) != {"x", "y", "z"}:
            fail("Surface-contact normal is invalid")
        components = [normal.get(axis) for axis in ("x", "y", "z")]
        if any(
            isinstance(component, bool)
            or not isinstance(component, (int, float))
            or not math.isfinite(float(component))
            for component in components
        ) or abs(math.sqrt(sum(float(component) ** 2 for component in components)) - 1) > 1e-3:
            fail("Surface-contact normal must be normalized")
        surface_kinds = surface_placement.get("requiredSurfaceKinds")
        allowed_surface_kinds = {"floor", "platform", "ramp", "roof", "ceiling", "wall", "terrain"}
        if (
            not isinstance(surface_kinds, list)
            or not surface_kinds
            or surface_kinds != sorted(set(surface_kinds))
            or any(kind not in allowed_surface_kinds for kind in surface_kinds)
        ):
            fail("Required placement-surface inventory is invalid")
    source_ids = {source.get("id") for source in sources if isinstance(source, dict)}
    if len(source_ids) != len(sources) or None in source_ids:
        fail("Source identifiers must be unique")
    role_ids = {role.get("id") for role in roles if isinstance(role, dict)}
    if len(role_ids) != len(roles) or None in role_ids:
        fail("Material role identifiers must be unique")
    maximum_edge = delivery.get("maximumTextureEdge")
    if not isinstance(maximum_edge, int) or isinstance(maximum_edge, bool) or not 1 <= maximum_edge <= 8192:
        fail("Adaptation texture budget is invalid")
    for role in roles:
        if not isinstance(role, dict):
            fail("Material role is invalid")
        declared_palette_entry(style, role)
        validate_shading_policy(role)
        validate_opacity_policy(role)
        validate_edge_treatment_policy(role)
        if role["materialAdaptation"]["kind"] == "synthesize":
            recipe_outputs = role["materialAdaptation"]["graph"]["outputs"]
            if (
                role["shading"]["normalTexture"]["kind"] == "synthesize"
                and recipe_outputs["normal"]["kind"] != "height_gradient"
            ):
                fail("Synthesized normal texture requires a height-gradient material output")
            if "emissive" in channels and "emissiveNodeId" not in recipe_outputs:
                fail("Required synthesized emissive texture has no material graph output")
        projection = role.get("projection")
        if not isinstance(projection, dict):
            fail("Material role projection is absent")
        mode = projection.get("mode")
        if mode not in ("mesh_uv", "asset_planar", "asset_triplanar", "trim_hotspot"):
            fail("Material role has an unsupported projection mode")
        if role["materialAdaptation"]["kind"] == "synthesize":
            graph = role["materialAdaptation"]["graph"]
            if mode in ("asset_planar", "trim_hotspot") and (
                material_graph_context_sources(graph)
                or material_graph_uses_triplanar_coordinates(graph)
            ):
                fail(
                    "Geometry-aware procedural fields require a unique UV atlas, not repeating planar UVs"
                )
        # Planar and trim tiling can be proved before geometry exists. Atlas modes are
        # sized only after the final adapted UV mapping and uniform scale exist.
        if mode in ("asset_planar", "trim_hotspot"):
            texture_profile(style, role, maximum_edge)
        else:
            # Validate the complete mode-specific shape without inventing area.
            if mode == "mesh_uv" and set(projection) != {"mode", "scaleStuds"}:
                fail("Mesh-UV projection contract is invalid")
            if mode == "asset_triplanar":
                # Reuse the common metric-scale validation while leaving atlas
                # sizing until the adapted geometry exists.
                texture_profile(
                    style,
                    {
                        **role,
                        "projection": {
                            "mode": "asset_planar",
                            "scaleStuds": projection.get("scaleStuds"),
                            "frame": {
                                "origin": "canonical_asset_origin",
                                "uAxis": "+X",
                                "vAxis": "+Y",
                            },
                        },
                    },
                    maximum_edge,
                )
                if (
                    set(projection) != {"mode", "scaleStuds", "blendExponent"}
                    or not finite_number(projection.get("blendExponent"))
                    or not 1 <= float(projection["blendExponent"]) <= 32
                ):
                    fail("Asset-triplanar projection contract is invalid")
    for source in sources:
        path = pathlib.Path(str(source.get("path", "")))
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            fail("Source path must be an absolute regular file")
        if path.stat().st_size <= 0 or path.stat().st_size > MAX_SOURCE_BYTES:
            fail("Source file exceeds its byte policy")
        if source.get("kind") not in ("glb_node", "prepared_mesh", "mesh_attribute_bundle"):
            fail("Unsupported source geometry kind")
    if any(
        not isinstance(part, dict)
        or part.get("sourceId") not in source_ids
        or part.get("materialRoleId") not in role_ids
        for part in parts
    ):
        fail("Part references absent source geometry or material policy")
    return value


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def column_major_matrix(values: list[float]) -> Matrix:
    if len(values) != 16 or any(not math.isfinite(float(value)) for value in values):
        fail("Source-to-canonical matrix is invalid")
    matrix = Matrix(tuple(tuple(float(values[column * 4 + row]) for column in range(4)) for row in range(4)))
    if abs(matrix.to_3x3().determinant()) < 1e-12:
        fail("Source-to-canonical matrix is singular")
    return matrix


def source_canonical_matrix(source: dict[str, Any]) -> Matrix:
    ownership = source.get("transformOwnership")
    if not isinstance(ownership, dict):
        fail("Source transform ownership is absent")
    if ownership.get("kind") == "already_baked":
        if ownership.get("coordinateFrame") != "gltf-y-up-asset-units":
            fail("Already-baked source uses the wrong coordinate frame")
        return IDENTITY.copy()
    if ownership.get("kind") != "requires_bake":
        fail("Unsupported source transform ownership")
    source_matrix = column_major_matrix(ownership.get("sourceToCanonicalMatrixColumnMajor", []))
    return GLTF_TO_BLENDER @ source_matrix @ GLTF_TO_BLENDER.inverted()


def tensor_source_to_blender_matrix(source: dict[str, Any]) -> Matrix:
    """Map raw tensor source coordinates directly into Blender coordinates."""
    ownership = source.get("transformOwnership")
    if not isinstance(ownership, dict):
        fail("Tensor transform ownership is absent")
    if ownership.get("kind") == "already_baked":
        if ownership.get("coordinateFrame") != "gltf-y-up-asset-units":
            fail("Already-baked tensor uses the wrong coordinate frame")
        return GLTF_TO_BLENDER.copy()
    if ownership.get("kind") != "requires_bake":
        fail("Unsupported tensor transform ownership")
    source_to_canonical = column_major_matrix(
        ownership.get("sourceToCanonicalMatrixColumnMajor", [])
    )
    return GLTF_TO_BLENDER @ source_to_canonical


def import_glb_source(source: dict[str, Any]) -> tuple[bpy.types.Object, dict[str, Any]]:
    result = bpy.ops.import_scene.gltf(filepath=source["path"], import_pack_images=True)
    if "FINISHED" not in result:
        fail(f"Blender rejected GLB source: {source['id']}")
    meshes = [item for item in bpy.context.scene.objects if item.type == "MESH"]
    target = next((item for item in meshes if item.name == source.get("nodeName")), None)
    if target is None:
        fail(f"GLB source node is absent or not a mesh: {source['id']}")
    return target, {"tensorAttributes": None}


def read_safetensors(source: dict[str, Any]) -> dict[str, np.ndarray]:
    if source.get("tensorSchemaHash") != TENSOR_SCHEMA_HASH:
        fail("Mesh-attribute tensor schema is unqualified")
    path = pathlib.Path(source["path"])
    file_size = path.stat().st_size
    if file_size < 10:
        fail("Safetensors source is truncated")
    with path.open("rb") as handle:
        header_size_bytes = handle.read(8)
        header_size = struct.unpack("<Q", header_size_bytes)[0]
        header_bytes = handle.read(header_size)
    if header_size <= 1 or header_size > min(16 * 1024 * 1024, file_size - 8):
        fail("Safetensors header exceeds its policy")
    try:
        header = json.loads(header_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdaptationFailure("Safetensors header is invalid") from error
    expected = {
        "positions": ("F32", 3),
        "triangle_indices": ("I32", 3),
        "base_color": ("F32", 3),
        "roughness": ("F32", 1),
        "metallic": ("F32", 1),
        "opacity": ("F32", 1),
        "normals": ("F32", 3),
    }
    names = {name for name in header if name != "__metadata__"}
    if names != set(expected):
        fail("Safetensors tensor inventory differs from the qualified schema")
    payload_offset = 8 + header_size
    payload_size = file_size - payload_offset
    tensors: dict[str, np.ndarray] = {}
    rows: dict[str, int] = {}
    spans: list[tuple[int, int]] = []
    for name, (dtype, columns) in expected.items():
        descriptor = header.get(name)
        if not isinstance(descriptor, dict) or descriptor.get("dtype") != dtype:
            fail(f"Safetensors dtype differs from the qualified schema: {name}")
        shape = descriptor.get("shape")
        offsets = descriptor.get("data_offsets")
        if (
            not isinstance(shape, list)
            or len(shape) != 2
            or not isinstance(shape[0], int)
            or shape[0] <= 0
            or shape[1] != columns
            or not isinstance(offsets, list)
            or len(offsets) != 2
            or any(not isinstance(offset, int) for offset in offsets)
        ):
            fail(f"Safetensors shape or offsets are invalid: {name}")
        start, end = offsets
        expected_bytes = shape[0] * columns * 4
        if start < 0 or end != start + expected_bytes or end > payload_size:
            fail(f"Safetensors byte range is invalid: {name}")
        spans.append((start, end))
        tensors[name] = np.memmap(
            path,
            dtype="<f4" if dtype == "F32" else "<i4",
            mode="r",
            offset=payload_offset + start,
            shape=(shape[0], columns),
            order="C",
        )
        rows[name] = shape[0]
    ordered_spans = sorted(spans)
    if (
        ordered_spans[0][0] != 0
        or ordered_spans[-1][1] != payload_size
        or any(left[1] != right[0] for left, right in zip(ordered_spans, ordered_spans[1:]))
    ):
        fail("Safetensors byte ranges must form one non-overlapping payload")
    vertex_count = rows["positions"]
    if vertex_count < 3 or any(rows[name] != vertex_count for name in expected if name != "triangle_indices"):
        fail("Safetensors vertex attribute counts differ")
    positions = tensors["positions"]
    triangles = tensors["triangle_indices"]
    chunk_rows = 1_000_000
    for start in range(0, vertex_count, chunk_rows):
        chunk = positions[start : start + chunk_rows]
        if not np.isfinite(chunk).all():
            fail("Safetensors positions contain nonfinite values")
    for start in range(0, rows["triangle_indices"], chunk_rows):
        chunk = triangles[start : start + chunk_rows]
        if (
            np.any(chunk < 0)
            or np.any(chunk >= vertex_count)
            or np.any(chunk[:, 0] == chunk[:, 1])
            or np.any(chunk[:, 0] == chunk[:, 2])
            or np.any(chunk[:, 1] == chunk[:, 2])
        ):
            fail("Safetensors triangle indices are invalid")
    for name in ("base_color", "roughness", "metallic", "opacity"):
        values = tensors[name]
        for start in range(0, vertex_count, chunk_rows):
            chunk = values[start : start + chunk_rows]
            if not np.isfinite(chunk).all() or np.any(chunk < 0) or np.any(chunk > 1):
                fail(f"Safetensors {name} values leave the qualified range")
    return tensors


def reduce_neural_tensor_bundle(
    tensors: dict[str, np.ndarray],
    target_triangles: int,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    """Reduce a very dense O-Voxel bundle before crossing into Blender.

    A TRELLIS mesh can contain millions of nearly coincident voxel vertices.
    Deterministic cell representatives preserve the coarse silhouette and
    material attributes while collapsing the redundant surface inventory in
    NumPy. Blender then handles only the bounded result and can spend its
    budget on normals, UVs and finishing instead of first simplifying raw
    neural topology.
    """
    positions = np.asarray(tensors["positions"])
    triangles = np.asarray(tensors["triangle_indices"])
    if triangles.shape[0] <= target_triangles:
        return tensors, {
            "applied": False,
            "inputTriangles": int(triangles.shape[0]),
            "outputTriangles": int(triangles.shape[0]),
            "targetTriangles": target_triangles,
        }
    resolution = max(24, int(round((target_triangles ** (1.0 / 3.0)) * 1.5)))
    minimum = np.min(positions, axis=0).astype(np.float64)
    extent = np.maximum(np.ptp(positions, axis=0).astype(np.float64), 1e-9)
    normalized = (positions.astype(np.float64) - minimum) / extent
    cells = np.clip((normalized * resolution).astype(np.int64), 0, resolution - 1)
    keys = cells[:, 0] + resolution * (cells[:, 1] + resolution * cells[:, 2])
    _, representative, inverse = np.unique(keys, return_inverse=True, return_index=True)
    reduced_triangles = inverse[triangles]
    non_degenerate = (
        (reduced_triangles[:, 0] != reduced_triangles[:, 1])
        & (reduced_triangles[:, 0] != reduced_triangles[:, 2])
        & (reduced_triangles[:, 1] != reduced_triangles[:, 2])
    )
    reduced_triangles = reduced_triangles[non_degenerate]
    if reduced_triangles.shape[0] > target_triangles:
        stride = int(math.ceil(reduced_triangles.shape[0] / target_triangles))
        reduced_triangles = reduced_triangles[::stride]
    reduced_triangles = np.ascontiguousarray(reduced_triangles.astype(np.int32, copy=False))
    used, remap = np.unique(reduced_triangles, return_inverse=True)
    reduced_triangles = remap.reshape(-1, 3).astype(np.int32, copy=False)
    reduced = {
        "positions": np.ascontiguousarray(positions[representative[used]], dtype=np.float32),
        "triangle_indices": reduced_triangles,
    }
    for name in ("base_color", "roughness", "metallic", "opacity", "normals"):
        reduced[name] = np.ascontiguousarray(tensors[name][representative[used]], dtype=np.float32)
    return reduced, {
        "applied": True,
        "inputTriangles": int(triangles.shape[0]),
        "outputTriangles": int(reduced_triangles.shape[0]),
        "inputVertices": int(positions.shape[0]),
        "outputVertices": int(reduced["positions"].shape[0]),
        "gridResolution": resolution,
        "targetTriangles": target_triangles,
    }


def import_tensor_source(
    source: dict[str, Any],
    max_triangles: int | None = None,
    expected_world_size: tuple[float, float, float] | None = None,
) -> tuple[bpy.types.Object, dict[str, Any]]:
    tensors = read_safetensors(source)
    source_positions = np.asarray(tensors["positions"], dtype=np.float64)
    source_extent = np.ptp(source_positions, axis=0)
    # TRELLIS uses an X-right/Y-forward/Z-up voxel frame.  The common
    # adapter's canonical glTF frame is X-right/Y-up/Z-forward, so the raw
    # extents arrive as (x, z, y) in delivery space.  Check proportions before
    # Blender spends time on UVs and previews.  A collapsed cube or slab is a
    # model failure; adapting it into a plausible height would only hide the
    # failure and put noisy geometry in the world.
    neural_shape_quality: dict[str, Any] | None = None
    if expected_world_size is not None:
        expected = np.asarray(expected_world_size, dtype=np.float64)
        observed_world = np.asarray(
            (source_extent[0], source_extent[2], source_extent[1]), dtype=np.float64
        )
        if (
            not np.isfinite(expected).all()
            or not np.isfinite(observed_world).all()
            or np.any(expected <= 1e-8)
            or np.any(observed_world <= 1e-8)
        ):
            fail("Neural source has degenerate delivery-space bounds")
        relative = observed_world / expected
        scale = float(np.median(relative))
        normalized = relative / max(scale, 1e-12)
        neural_shape_quality = {
            "expectedWorldSize": tuple(float(value) for value in expected),
            "observedWorldSize": tuple(float(value) for value in observed_world),
            "normalizedAxisRatios": tuple(float(value) for value in normalized),
            "minimumNormalizedAxisRatio": float(np.min(normalized)),
            "maximumNormalizedAxisRatio": float(np.max(normalized)),
            "policy": "minimum_axis_ratio_0.67_before_adaptation",
        }
        if float(np.min(normalized)) < 0.67:
            fail(
                "Neural source proportions collapsed before adaptation: "
                f"expectedWorldSize={tuple(float(value) for value in expected)} "
                f"observedWorldSize={tuple(float(value) for value in observed_world)}"
            )
    reduction = None
    if max_triangles is not None:
        tensors, reduction = reduce_neural_tensor_bundle(tensors, max_triangles)
    transform = tensor_source_to_blender_matrix(source)
    positions = tensors["positions"]
    triangles = tensors["triangle_indices"]
    vertex_count = int(positions.shape[0])
    triangle_count_value = int(triangles.shape[0])
    mesh = bpy.data.meshes.new(f"{source['id']}_Mesh")
    mesh.vertices.add(vertex_count)
    mesh.vertices.foreach_set("co", positions.reshape(-1))
    mesh.loops.add(triangle_count_value * 3)
    mesh.loops.foreach_set("vertex_index", triangles.reshape(-1))
    mesh.polygons.add(triangle_count_value)
    mesh.polygons.foreach_set(
        "loop_start",
        np.arange(0, triangle_count_value * 3, 3, dtype=np.int32),
    )
    mesh.polygons.foreach_set(
        "loop_total",
        np.full(triangle_count_value, 3, dtype=np.int32),
    )
    mesh.transform(transform)
    mesh.update(calc_edges=True)
    base_attribute = mesh.color_attributes.new(
        name="BasaltTensorBaseColor", type="FLOAT_COLOR", domain="POINT"
    )
    orm_attribute = mesh.color_attributes.new(
        name="BasaltTensorORM", type="FLOAT_COLOR", domain="POINT"
    )
    rgba = np.empty((vertex_count, 4), dtype=np.float32)
    rgba[:, :3] = tensors["base_color"]
    rgba[:, 3] = tensors["opacity"][:, 0]
    base_attribute.data.foreach_set("color", rgba.reshape(-1))
    rgba[:, 0] = 1.0
    rgba[:, 1] = tensors["roughness"][:, 0]
    rgba[:, 2] = tensors["metallic"][:, 0]
    rgba[:, 3] = 1.0
    orm_attribute.data.foreach_set("color", rgba.reshape(-1))
    obj = bpy.data.objects.new(source["id"], mesh)
    bpy.context.scene.collection.objects.link(obj)
    averages = {}
    for name in ("base_color", "roughness", "metallic", "opacity"):
        values = tensors[name]
        averages[name] = tuple(float(value) for value in np.mean(values, axis=0, dtype=np.float64))
    evidence: dict[str, Any] = {
        "tensorAttributes": {"averages": averages, "sampleCount": vertex_count}
    }
    if neural_shape_quality is not None:
        evidence["neuralShapeQuality"] = neural_shape_quality
    if reduction is not None:
        evidence["neuralTensorReduction"] = reduction
    return obj, evidence


def column_major_point(matrix: Matrix, point: Vector) -> Vector:
    value = matrix @ point.to_4d()
    return Vector((value.x / value.w, value.y / value.w, value.z / value.w))


def evaluated_baked_mesh(obj: bpy.types.Object, extra_transform: Matrix) -> bpy.types.Object:
    dependency_graph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(dependency_graph)
    mesh = bpy.data.meshes.new_from_object(
        evaluated, preserve_all_data_layers=True, depsgraph=dependency_graph
    )
    mesh.transform(extra_transform @ obj.matrix_world)
    result = bpy.data.objects.new(obj.name, mesh)
    bpy.context.scene.collection.objects.link(result)
    result.matrix_world = IDENTITY
    for item in list(bpy.context.scene.objects):
        if item != result:
            bpy.data.objects.remove(item, do_unlink=True)
    return result


def activate(obj: bpy.types.Object, edit: bool = False) -> None:
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if edit:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")


def triangle_count(obj: bpy.types.Object) -> int:
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def clean_geometry(obj: bpy.types.Object) -> dict[str, Any]:
    before_vertices = len(obj.data.vertices)
    before_triangles = triangle_count(obj)
    activate(obj, edit=True)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=1e-6)
    bpy.ops.mesh.dissolve_degenerate(threshold=1e-10)
    bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=True)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    if not obj.data.polygons or not obj.data.vertices:
        fail("Adaptation removed all source geometry")
    if any(
        not all(math.isfinite(float(component)) for component in vertex.co)
        for vertex in obj.data.vertices
    ):
        fail("Source geometry contains nonfinite positions")
    triangulate = obj.modifiers.new("BasaltCanonicalTriangulate", "TRIANGULATE")
    triangulate.quad_method = "BEAUTY"
    triangulate.ngon_method = "BEAUTY"
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    obj.data.validate(verbose=False, clean_customdata=False)
    obj.data.update(calc_edges=True)
    return {
        "inputVertices": before_vertices,
        "inputTriangles": before_triangles,
        "weldedVertices": before_vertices - len(obj.data.vertices),
        "removedTriangles": max(0, before_triangles - triangle_count(obj)),
    }


def smart_uv_atlas(
    obj: bpy.types.Object,
    maximum_edge: int | None = None,
    angle_limit: float | None = None,
    island_margin: float | None = None,
) -> None:
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    obj.data.uv_layers.new(name="UVMap")
    # Every material owns a distinct delivered texture, so its rendered faces
    # may use the complete unit square. Explicit face-selection mode is
    # required here: vertex-mode selection can leak across material boundaries
    # that share vertices and leave thin material islands effectively empty.
    activate(obj, edit=True)
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    bpy.ops.object.mode_set(mode="OBJECT")
    effective_angle = math.radians(45) if angle_limit is None else angle_limit
    if island_margin is not None:
        effective_margin = island_margin
    elif maximum_edge is not None and maximum_edge > 0:
        effective_margin = max(0.001, min(0.005, 2.0 / float(maximum_edge)))
    else:
        effective_margin = 0.005
    material_indices = sorted({int(polygon.material_index) for polygon in obj.data.polygons})
    for material_index in material_indices:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.object.mode_set(mode="OBJECT")
        for polygon in obj.data.polygons:
            polygon.select = int(polygon.material_index) == material_index
        obj.data.update()
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.uv.smart_project(
            angle_limit=effective_angle,
            island_margin=effective_margin,
            area_weight=0.0,
            correct_aspect=True,
            scale_to_bounds=True,
        )
        bpy.ops.uv.average_islands_scale(shear=True)
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=effective_margin)
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.update()


def canonical_axis_in_blender(name: str) -> Vector:
    canonical = {
        "+X": Vector((1, 0, 0, 0)),
        "-X": Vector((-1, 0, 0, 0)),
        "+Y": Vector((0, 1, 0, 0)),
        "-Y": Vector((0, -1, 0, 0)),
        "+Z": Vector((0, 0, 1, 0)),
        "-Z": Vector((0, 0, -1, 0)),
    }.get(name)
    if canonical is None:
        fail("Asset-planar projection axis is invalid")
    mapped = GLTF_TO_BLENDER @ canonical
    return Vector((mapped.x, mapped.y, mapped.z))


def asset_planar_uv(obj: bpy.types.Object, role: dict[str, Any], studs_per_unit: float) -> None:
    projection = role["projection"]
    frame = projection["frame"]
    u_axis = canonical_axis_in_blender(frame["uAxis"])
    v_axis = canonical_axis_in_blender(frame["vAxis"])
    u_scale = float(projection["scaleStuds"]["u"])
    v_scale = float(projection["scaleStuds"]["v"])
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    layer = obj.data.uv_layers.new(name="UVMap")
    for loop in obj.data.loops:
        point = obj.data.vertices[loop.vertex_index].co
        layer.data[loop.index].uv = (
            point.dot(u_axis) * studs_per_unit / u_scale,
            point.dot(v_axis) * studs_per_unit / v_scale,
        )
    obj.data.update()


def uv_area_measurement(
    obj: bpy.types.Object, material_index: int | None = None
) -> dict[str, float]:
    if not obj.data.uv_layers:
        return {"surfaceAreaAssetUnits2": 0.0, "uvArea": 0.0}
    obj.data.calc_loop_triangles()
    layer = obj.data.uv_layers.active.data
    surface = 0.0
    uv_area = 0.0
    for triangle in obj.data.loop_triangles:
        if material_index is not None and int(triangle.material_index) != material_index:
            continue
        points = [obj.data.vertices[index].co for index in triangle.vertices]
        surface += ((points[1] - points[0]).cross(points[2] - points[0])).length / 2
        uvs = [layer[index].uv for index in triangle.loops]
        uv_area += abs((uvs[1] - uvs[0]).cross(uvs[2] - uvs[0])) / 2
    return {"surfaceAreaAssetUnits2": surface, "uvArea": uv_area}


def basic_uv_is_admissible(obj: bpy.types.Object) -> bool:
    if not obj.data.uv_layers:
        return False
    obj.data.uv_layers.active_index = 0
    while len(obj.data.uv_layers) > 1:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    layer = obj.data.uv_layers.active.data
    if any(
        not math.isfinite(float(loop.uv.x))
        or not math.isfinite(float(loop.uv.y))
        or loop.uv.x < -1e-6
        or loop.uv.x > 1 + 1e-6
        or loop.uv.y < -1e-6
        or loop.uv.y > 1 + 1e-6
        for loop in layer
    ):
        return False
    obj.data.calc_loop_triangles()
    surface = positive = negative = degenerate = 0.0
    for triangle in obj.data.loop_triangles:
        points = [obj.data.vertices[index].co for index in triangle.vertices]
        area = ((points[1] - points[0]).cross(points[2] - points[0])).length / 2
        uvs = [layer[index].uv for index in triangle.loops]
        signed = (uvs[1] - uvs[0]).cross(uvs[2] - uvs[0])
        surface += area
        if abs(signed) <= 1e-12:
            degenerate += area
        elif signed < 0:
            negative += area
        else:
            positive += area
    if not (surface > 0 and degenerate / surface <= 1e-6 and min(positive, negative) / surface <= 1e-6):
        return False
    triangles_by_material: dict[int, list[dict[str, Any]]] = {}
    for triangle in obj.data.loop_triangles:
        triangles_by_material.setdefault(int(triangle.material_index), []).append(
            {"uv": [tuple(float(value) for value in layer[index].uv) for index in triangle.loops]}
        )
    return all(
        sum(
            abs(
                (Vector(triangle["uv"][1]) - Vector(triangle["uv"][0])).cross(
                    Vector(triangle["uv"][2]) - Vector(triangle["uv"][0])
                )
            )
            / 2
            for triangle in triangles
        )
        > 1e-8
        and (coverage := unit_atlas_coverage(triangles))[1] <= 0.02
        for triangles in triangles_by_material.values()
    )


def ensure_uv(
    obj: bpy.types.Object,
    role: dict[str, Any],
    style: dict[str, Any],
    maximum_edge: int,
    studs_per_unit: float,
) -> tuple[str, list[tuple[float, float]] | None]:
    material_indices = sorted({int(polygon.material_index) for polygon in obj.data.polygons})
    source_uvs = (
        [
            (float(loop.uv.x), float(loop.uv.y))
            for loop in obj.data.uv_layers.active.data
        ]
        if obj.data.uv_layers.active is not None
        else []
    )

    def verify_texture_profiles() -> None:
        for material_index in material_indices:
            texture_profile(
                style,
                role,
                maximum_edge,
                obj,
                studs_per_unit,
                material_index,
            )

    mode = role["projection"]["mode"]
    if mode == "asset_planar":
        asset_planar_uv(obj, role, studs_per_unit)
        return "asset_planar_metric", source_uvs
    if mode == "asset_triplanar":
        smart_uv_atlas(obj, maximum_edge=maximum_edge)
        return "asset_triplanar_baked_atlas", source_uvs
    if mode == "trim_hotspot":
        import hotspot_unwrap
        trim_spec = role["projection"]["trimSheet"]
        hotspot_unwrap.apply_hotspot_to_mesh(obj, trim_spec)
        return "trim_hotspot_mapped", source_uvs
    retained = basic_uv_is_admissible(obj)
    if retained:
        try:
            verify_texture_profiles()
        except AdaptationFailure:
            retained = False
    if not retained:
        cascade = [
            (math.radians(45), max(0.001, min(0.005, 2.0 / float(maximum_edge)))),
            (math.radians(66), max(0.001, min(0.005, 2.0 / float(maximum_edge)))),
            (math.radians(75), max(0.001, min(0.005, 1.0 / float(maximum_edge)))),
        ]
        last_failure: Exception | None = None
        repaired = False
        for angle_limit, margin in cascade:
            smart_uv_atlas(obj, angle_limit=angle_limit, island_margin=margin)
            try:
                verify_texture_profiles()
                repaired = True
                break
            except AdaptationFailure as failure:
                last_failure = failure
        if not repaired:
            if last_failure is not None:
                raise last_failure
            verify_texture_profiles()
    else:
        # A retained atlas must itself fit the budget; this is the explicit
        # incomplete boundary when even a 2K/declared edge cannot meet minimum pps.
        verify_texture_profiles()
    return ("retained_verified", None) if retained else ("smart_atlas_repair", source_uvs)


def singular_values_2x2(a: float, b: float, c: float, d: float) -> tuple[float, float]:
    trace = a * a + b * b + c * c + d * d
    determinant = (a * d - b * c) ** 2
    discriminant = math.sqrt(max(0.0, trace * trace - 4 * determinant))
    return (
        math.sqrt(max(0.0, (trace - discriminant) / 2)),
        math.sqrt(max(0.0, (trace + discriminant) / 2)),
    )


def weighted_distribution(samples: list[tuple[float, float]]) -> dict[str, float]:
    retained = sorted(
        ((value, weight) for value, weight in samples if math.isfinite(value) and value >= 0 and weight > 0),
        key=lambda item: item[0],
    )
    if not retained:
        return {key: 0.0 for key in ("minimum", "p05", "median", "p95", "maximum", "areaWeightedRms")}
    total = sum(weight for _, weight in retained)

    def quantile(target: float) -> float:
        cumulative = 0.0
        for value, weight in retained:
            cumulative += weight
            if cumulative + 1e-12 >= total * target:
                return value
        return retained[-1][0]

    return {
        "minimum": retained[0][0],
        "p05": quantile(0.05),
        "median": quantile(0.5),
        "p95": quantile(0.95),
        "maximum": retained[-1][0],
        "areaWeightedRms": math.sqrt(sum(value * value * weight for value, weight in retained) / total),
    }


def point_inside_uv_triangle(x: float, y: float, points: list[Vector]) -> bool:
    first = (points[1].x - points[0].x) * (y - points[0].y) - (points[1].y - points[0].y) * (x - points[0].x)
    second = (points[2].x - points[1].x) * (y - points[1].y) - (points[2].y - points[1].y) * (x - points[1].x)
    third = (points[0].x - points[2].x) * (y - points[2].y) - (points[0].y - points[2].y) * (x - points[2].x)
    return (first > 1e-10 and second > 1e-10 and third > 1e-10) or (
        first < -1e-10 and second < -1e-10 and third < -1e-10
    )


def unit_atlas_coverage(triangles: list[dict[str, Any]]) -> tuple[float, float]:
    if any(
        coordinate < -1e-6 or coordinate > 1 + 1e-6
        for triangle in triangles
        for uv in triangle["uv"]
        for coordinate in uv
    ):
        return 0.0, 1.0
    resolution = 128
    counts = [0] * (resolution * resolution)
    for triangle in triangles:
        points = [Vector(uv) for uv in triangle["uv"]]
        low_x = max(0, math.floor(min(point.x for point in points) * resolution))
        high_x = min(resolution - 1, math.ceil(max(point.x for point in points) * resolution) - 1)
        low_y = max(0, math.floor(min(point.y for point in points) * resolution))
        high_y = min(resolution - 1, math.ceil(max(point.y for point in points) * resolution) - 1)
        for y in range(low_y, high_y + 1):
            for x in range(low_x, high_x + 1):
                if point_inside_uv_triangle((x + 0.5) / resolution, (y + 0.5) / resolution, points):
                    index = y * resolution + x
                    counts[index] = min(65535, counts[index] + 1)
    occupied = sum(value > 0 for value in counts)
    overlapping = sum(value > 1 for value in counts)
    return occupied / len(counts), 0.0 if occupied == 0 else overlapping / occupied


def material_uv_metrics(
    obj: bpy.types.Object,
    material_index: int,
    material_name: str,
    width: int,
    height: int,
    studs_per_unit: float,
) -> dict[str, Any]:
    obj.data.calc_loop_triangles()
    layer = obj.data.uv_layers.active.data
    triangles: list[dict[str, Any]] = []
    density_samples: list[tuple[float, float]] = []
    stretch_samples: list[tuple[float, float]] = []
    for triangle in obj.data.loop_triangles:
        if triangle.material_index != material_index:
            continue
        points = [obj.data.vertices[index].co.copy() for index in triangle.vertices]
        uvs = [layer[index].uv.copy() for index in triangle.loops]
        first_edge = points[1] - points[0]
        second_edge = points[2] - points[0]
        first_length = first_edge.length
        double_surface = first_edge.cross(second_edge).length
        signed_uv = (uvs[1] - uvs[0]).cross(uvs[2] - uvs[0])
        jacobian = (0.0, 0.0, 0.0, 0.0)
        if first_length > 1e-12 and double_surface > 1e-16 and abs(signed_uv) > 1e-16:
            tangent = first_edge / first_length
            x1 = second_edge.dot(tangent)
            y1 = double_surface / first_length
            inverse = (1 / first_length, -x1 / (first_length * y1), 0.0, 1 / y1)
            du0, du1 = uvs[1].x - uvs[0].x, uvs[2].x - uvs[0].x
            dv0, dv1 = uvs[1].y - uvs[0].y, uvs[2].y - uvs[0].y
            jacobian = (
                du0 * inverse[0] + du1 * inverse[2],
                du0 * inverse[1] + du1 * inverse[3],
                dv0 * inverse[0] + dv1 * inverse[2],
                dv0 * inverse[1] + dv1 * inverse[3],
            )
        minimum, maximum = singular_values_2x2(
            jacobian[0] * width,
            jacobian[1] * width,
            jacobian[2] * height,
            jacobian[3] * height,
        )
        minimum /= studs_per_unit
        maximum /= studs_per_unit
        area = double_surface / 2
        density_samples.extend(((minimum, area / 2), (maximum, area / 2)))
        stretch_samples.append((maximum / minimum if minimum > 1e-12 else 1e12, area))
        triangles.append({"surfaceArea": area, "signedUvDoubleArea": signed_uv, "uv": [(uv.x, uv.y) for uv in uvs]})
    if not triangles:
        fail(f"Adapted material has no rendered triangles: {material_name}")
    surface = sum(value["surfaceArea"] for value in triangles)
    degenerate = sum(value["surfaceArea"] for value in triangles if abs(value["signedUvDoubleArea"]) <= 1e-12)
    positive = sum(value["surfaceArea"] for value in triangles if value["signedUvDoubleArea"] > 1e-12)
    negative = sum(value["surfaceArea"] for value in triangles if value["signedUvDoubleArea"] < -1e-12)
    all_uvs = [uv for triangle in triangles for uv in triangle["uv"]]
    occupancy, overlap = unit_atlas_coverage(triangles)
    return {
        "materialName": material_name,
        "triangleCount": len(triangles),
        "surfaceAreaAssetUnits2": surface,
        "uvArea": sum(abs(value["signedUvDoubleArea"]) / 2 for value in triangles),
        "degenerateSurfaceFraction": degenerate / surface,
        "mirroredSurfaceFraction": min(positive, negative) / surface,
        "uvBounds": {
            "minimum": [min(value[0] for value in all_uvs), min(value[1] for value in all_uvs)],
            "maximum": [max(value[0] for value in all_uvs), max(value[1] for value in all_uvs)],
        },
        "unitAtlasOccupancyFraction": occupancy,
        "unitAtlasOverlapFraction": overlap,
        "stretchRatio": weighted_distribution(stretch_samples),
        "pixelsPerStud": weighted_distribution(density_samples),
    }


def measured_uv_report(
    obj: bpy.types.Object,
    materials: list[dict[str, Any]],
    studs_per_unit: float,
    generation: str,
    role: dict[str, Any],
) -> dict[str, Any]:
    rows = [
        material_uv_metrics(
            obj,
            index,
            material["name"],
            int(material["generatedTextureSize"]["width"]),
            int(material["generatedTextureSize"]["height"]),
            studs_per_unit,
        )
        for index, material in enumerate(materials)
    ]
    return {
        "generation": generation,
        "layers": 1,
        "studsPerUnit": studs_per_unit,
        "overlapPolicy": (
            "repeating_asset_planar"
            if role["projection"]["mode"] == "asset_planar"
            else "repeating_trim_sheet"
            if role["projection"]["mode"] == "trim_hotspot"
            else "unique_nonoverlap"
        ),
        "materials": rows,
    }


def assert_uv_admission(report: dict[str, Any], style: dict[str, Any]) -> None:
    minimum = float(style["texelDensity"]["minimumPixelsPerStud"])
    maximum = float(style["texelDensity"]["maximumPixelsPerStud"])
    unique = report["overlapPolicy"] == "unique_nonoverlap"
    for material in report["materials"]:
        if material["degenerateSurfaceFraction"] > 1e-6:
            fail("Final UV mapping contains collapsed rendered surface")
        if unique and material["mirroredSurfaceFraction"] > 1e-6:
            fail("Final unique UV atlas contains inconsistently mirrored islands")
        if unique and material["unitAtlasOverlapFraction"] > 0.02:
            fail(
                "Final unique UV atlas contains overlapping rendered surface: "
                f"material={material['materialName']}, generation={report['generation']}, "
                f"overlap={material['unitAtlasOverlapFraction']:.9f}"
            )
        if unique and material["uvArea"] <= 1e-8:
            fail("Final unique UV atlas has negligible usable area")
        density = material["pixelsPerStud"]
        if density["p05"] + 1e-5 < minimum or density["areaWeightedRms"] - 1e-5 > maximum:
            fail("Final GLB UV mapping violates the style texel-density interval")
        if material["stretchRatio"]["p95"] > 4.0:
            fail(
                "Final GLB UV mapping exceeds the deterministic stretch policy: "
                f"material={material['materialName']}, generation={report['generation']}, "
                f"p95={material['stretchRatio']['p95']:.9f}"
            )


def object_bounds_gltf(obj: bpy.types.Object) -> tuple[list[float], list[float]]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    blender_low = [min(point[index] for point in points) for index in range(3)]
    blender_high = [max(point[index] for point in points) for index in range(3)]
    # Blender (x, y, z) -> glTF (x, z, -y).
    return (
        [blender_low[0], blender_low[2], -blender_high[1]],
        [blender_high[0], blender_high[2], -blender_low[1]],
    )


def collision_support_float(value: float) -> float:
    retained = struct.unpack("<f", struct.pack("<f", float(value)))[0]
    return 0.0 if retained == 0 else retained


def directional_topology_patches(
    obj: bpy.types.Object, direction: Vector
) -> list[dict[str, Any]]:
    """Retain canonical GLB triangles without filling topology holes."""
    if not all(math.isfinite(float(value)) for value in direction) or abs(direction.length - 1) > 1e-3:
        fail("Asset topology direction is invalid")
    direction = direction.normalized()
    obj.data.calc_loop_triangles()
    blender_to_gltf = GLTF_TO_BLENDER.inverted()
    patches: dict[str, tuple[float, dict[str, Any]]] = {}
    for triangle in obj.data.loop_triangles:
        points = []
        for vertex_index in triangle.vertices:
            point = blender_to_gltf @ (obj.matrix_world @ obj.data.vertices[vertex_index].co.to_4d())
            points.append(
                {
                    "x": collision_support_float(point.x),
                    "y": collision_support_float(point.y),
                    "z": collision_support_float(point.z),
                }
            )
        first = Vector((points[0]["x"], points[0]["y"], points[0]["z"]))
        second = Vector((points[1]["x"], points[1]["y"], points[1]["z"]))
        third = Vector((points[2]["x"], points[2]["y"], points[2]["z"]))
        cross = (second - first).cross(third - first)
        if cross.length <= 1e-8:
            continue
        normal_vector = cross.normalized()
        normal = {
            "x": collision_support_float(normal_vector.x),
            "y": collision_support_float(normal_vector.y),
            "z": collision_support_float(normal_vector.z),
        }
        if normal_vector.dot(direction) <= 1e-5:
            continue
        rotations = [points, points[1:] + points[:1], points[2:] + points[:2]]
        polygon = min(
            rotations,
            key=lambda value: json.dumps(
                value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ),
        )
        patch = {"polygon": polygon, "normal": normal}
        identity = json.dumps(
            patch, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        patches[identity] = (cross.length / 2, patch)
    return [value[1] for _, value in sorted(patches.items(), key=lambda item: item[0])]


def canonical_polygon_cyclic_order(
    polygon: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if len(polygon) != 3:
        return polygon
    rotations = [
        polygon,
        [polygon[1], polygon[2], polygon[0]],
        [polygon[2], polygon[0], polygon[1]],
    ]
    serialize = lambda p: json.dumps(
        p, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return min(rotations, key=serialize)


def bounded_physical_proxy_surfaces(
    patches: list[dict[str, Any]], maximum: int
) -> list[dict[str, Any]]:
    def area(patch: dict[str, Any]) -> float:
        points = [
            Vector((float(point["x"]), float(point["y"]), float(point["z"])))
            for point in patch["polygon"]
        ]
        return (points[1] - points[0]).cross(points[2] - points[0]).length / 2

    def quantized(value: Any) -> Any:
        if isinstance(value, float):
            return round(value, 5)
        if isinstance(value, list):
            return [quantized(item) for item in value]
        if isinstance(value, dict):
            return {key: quantized(value[key]) for key in sorted(value)}
        return value

    def canonical_patch(patch: dict[str, Any]) -> dict[str, Any]:
        return {**patch, "polygon": canonical_polygon_cyclic_order(patch["polygon"])}

    def signature(patch: dict[str, Any]) -> str:
        canonical = canonical_patch(patch)
        return json.dumps(
            quantized(canonical), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )

    canonical_patches = [canonical_patch(patch) for patch in patches]
    selected = sorted(
        canonical_patches,
        key=lambda patch: (
            -round(area(patch), 5),
            signature(patch),
        ),
    )[:maximum]
    return sorted(selected, key=signature)


def collision_support_patches(obj: bpy.types.Object) -> list[dict[str, Any]]:
    """Retain bounded upward surfaces for the placement physical proxy."""
    return bounded_physical_proxy_surfaces(
        directional_topology_patches(obj, Vector((0.0, 1.0, 0.0))),
        MAX_COLLISION_SUPPORT_PATCHES_PER_PART,
    )


def asset_contact_patches(
    obj: bpy.types.Object, surface_placement: dict[str, Any]
) -> list[dict[str, Any]]:
    """Derive a bounded contact proxy in the required asset-local direction."""
    if surface_placement["kind"] == "none":
        return []
    declared = surface_placement["outwardNormal"]
    direction = Vector(
        (float(declared["x"]), float(declared["y"]), float(declared["z"]))
    ).normalized()
    directed = directional_topology_patches(obj, direction)

    def fallback_contact_patch() -> list[dict[str, Any]]:
        blender_to_gltf = GLTF_TO_BLENDER.inverted()
        points = []
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            point = blender_to_gltf @ Vector((world.x, world.y, world.z, 1.0))
            points.append(Vector((point.x, point.y, point.z)))
        if not points:
            return []
        projections = [point.dot(direction) for point in points]
        extreme = max(projections)
        span = max(
            1e-5,
            max((point - other).length for point in points for other in points[:1]),
        )
        tolerance = max(1e-6, span * 1e-6)
        extreme_points = [
            point for point, value in zip(points, projections, strict=True)
            if value >= extreme - tolerance
        ]
        center = sum(extreme_points, Vector((0.0, 0.0, 0.0))) / len(extreme_points)
        center += direction * (extreme - center.dot(direction))
        reference = Vector((0.0, 1.0, 0.0))
        if abs(direction.dot(reference)) > 0.9:
            reference = Vector((1.0, 0.0, 0.0))
        tangent = direction.cross(reference).normalized()
        bitangent = direction.cross(tangent).normalized()
        radius = max(1e-5, span * 1e-4)
        polygon_vectors = [
            center + tangent * radius,
            center + bitangent * radius,
            center - (tangent + bitangent) * radius,
        ]
        polygon = canonical_polygon_cyclic_order(
            [
                {
                    "x": collision_support_float(point.x),
                    "y": collision_support_float(point.y),
                    "z": collision_support_float(point.z),
                }
                for point in polygon_vectors
            ]
        )
        sample = {
            "x": collision_support_float(center.x),
            "y": collision_support_float(center.y),
            "z": collision_support_float(center.z),
        }
        return [{
            "polygon": polygon,
            "outwardNormal": {
                "x": collision_support_float(direction.x),
                "y": collision_support_float(direction.y),
                "z": collision_support_float(direction.z),
            },
            "contactSamples": [sample],
        }]

    if not directed:
        return fallback_contact_patch()

    def projection(point: dict[str, Any]) -> float:
        return (
            float(point["x"]) * direction.x
            + float(point["y"]) * direction.y
            + float(point["z"]) * direction.z
        )

    projections = [
        projection(point) for patch in directed for point in patch["polygon"]
    ]
    extreme = max(projections)
    tolerance = max(1e-6, (max(projections) - min(projections)) * 1e-6)
    patches = [
        {
            "polygon": patch["polygon"],
            "outwardNormal": patch["normal"],
            "contactSamples": [
                {
                    "x": collision_support_float(
                        sum(point["x"] for point in patch["polygon"]) / 3
                    ),
                    "y": collision_support_float(
                        sum(point["y"] for point in patch["polygon"]) / 3
                    ),
                    "z": collision_support_float(
                        sum(point["z"] for point in patch["polygon"]) / 3
                    ),
                }
            ],
        }
        for patch in directed
        if all(projection(point) >= extreme - tolerance for point in patch["polygon"])
    ]
    if not patches:
        return fallback_contact_patch()
    return bounded_physical_proxy_surfaces(patches, MAX_ASSET_CONTACT_PATCHES_PER_PART)


def uniform_studs_per_unit(obj: bpy.types.Object, expected: dict[str, Any]) -> float:
    low, high = object_bounds_gltf(obj)
    measured = [high[index] - low[index] for index in range(3)]
    wanted = [float(expected[axis]) for axis in ("x", "y", "z")]
    if any(not math.isfinite(value) or value <= 0 for value in measured + wanted):
        fail("Asset bounds are degenerate")
    scale = min(wanted[index] / measured[index] for index in range(3))
    if scale <= 0 or scale > 10000:
        fail("Asset bounds cannot derive a finite conservative uniform scale")
    return scale


def apply_edge_policy(
    obj: bpy.types.Object,
    part_roles: list[dict[str, Any]],
    expected: dict[str, Any],
) -> dict[str, Any]:
    treatments = [role.get("edgeTreatment") for role in part_roles]
    treatments = [value for value in treatments if isinstance(value, dict) and value.get("kind") == "treated"]
    if not treatments:
        return {"applied": False}
    studs_per_unit = uniform_studs_per_unit(obj, expected)
    requested = min(float(value.get("widthStuds", 0)) for value in treatments)
    low, high = object_bounds_gltf(obj)
    smallest = min(high[index] - low[index] for index in range(3))
    width = min(requested / studs_per_unit, smallest * 0.035)
    if width <= 1e-5:
        return {"applied": False}
    modifier = obj.modifiers.new("BasaltStyleEdgeTreatment", "BEVEL")
    modifier.width = width
    segments = int(treatments[0]["segments"])
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    modifier.angle_limit = math.radians(25)
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"applied": True, "widthAssetUnits": width, "segments": segments}


def retained_neural_vertex_attributes(obj: bpy.types.Object) -> list[str]:
    expected = ("BasaltTensorBaseColor", "BasaltTensorORM")
    present = [name for name in expected if obj.data.color_attributes.get(name) is not None]
    if present and present != list(expected):
        fail("Neural PBR vertex attributes are incomplete")
    for name in present:
        attribute = obj.data.color_attributes[name]
        if (
            attribute.domain != "POINT"
            or attribute.data_type != "FLOAT_COLOR"
            or len(attribute.data) != len(obj.data.vertices)
            or any(
                not all(math.isfinite(float(component)) for component in value.color)
                for value in attribute.data
            )
        ):
            fail(f"Neural PBR vertex attribute was not retained exactly: {name}")
    return present


def apply_collapse_decimation(
    obj: bpy.types.Object,
    target: int,
    headroom: float,
) -> dict[str, Any]:
    before = triangle_count(obj)
    ratio = max(0.000001, min(1.0, target / before * headroom))
    modifier = obj.modifiers.new("BasaltBudgetDecimation", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    clean_geometry(obj)
    return {
        "inputTriangles": before,
        "outputTriangles": triangle_count(obj),
        "ratio": ratio,
    }


def remove_neural_dust(obj: bpy.types.Object) -> tuple[bpy.types.Object, dict[str, Any]]:
    """Remove disconnected specks before simplifying a neural surface.

    TRELLIS-style outputs can contain dozens of tiny disconnected islands. A
    collapse modifier spends its budget preserving those islands and then
    stalls far above the delivery budget. Separating loose components lets us
    retain the meaningful silhouette-bearing pieces and discard only islands
    below a deterministic fraction of the source triangle inventory.
    """

    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [
        candidate
        for candidate in bpy.context.scene.objects
        if candidate.type == "MESH"
    ]
    # Blender retains the original object and creates the other components.
    pieces = list(dict.fromkeys(pieces))
    if len(pieces) <= 1:
        total_triangles = triangle_count(obj)
        return obj, {
            "applied": False,
            "componentCount": 1,
            "removedComponents": 0,
            "removedTriangleFraction": 0.0,
            "retainedTriangleFraction": 1.0 if total_triangles else 0.0,
        }
    pieces.sort(key=triangle_count, reverse=True)
    total_triangles = sum(triangle_count(piece) for piece in pieces)
    minimum_triangles = max(32, int(total_triangles * 0.00005))
    keep = [piece for piece in pieces if triangle_count(piece) >= minimum_triangles][:32]
    if not keep:
        keep = pieces[:1]
    remove = [piece for piece in pieces if piece not in keep]
    removed_triangles = sum(triangle_count(piece) for piece in remove)
    kept_triangles = sum(triangle_count(piece) for piece in keep)
    for piece in remove:
        bpy.data.objects.remove(piece, do_unlink=True)
    activate(keep[0])
    for piece in keep[1:]:
        piece.select_set(True)
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    if merged is None or merged.type != "MESH":
        fail("Neural loose-component cleanup lost its merged mesh")
    return merged, {
        "applied": True,
        "componentCount": len(pieces),
        "keptComponents": len(keep),
        "removedComponents": len(remove),
        "minimumTrianglesPerComponent": minimum_triangles,
        "removedTriangleFraction": (
            removed_triangles / total_triangles
            if total_triangles
            else 1.0
        ),
        "retainedTriangleFraction": (
            kept_triangles / total_triangles
            if total_triangles
            else 0.0
        ),
    }


def bound_neural_source(obj: bpy.types.Object, target: int) -> dict[str, Any]:
    """Bound an oversized neural mesh before quadratic mesh inspection.

    TRELLIS can emit several million triangles. Separating every loose piece,
    calculating UV coverage, or measuring curvature at that size can monopolize
    the Blender worker. A single coarse collapse keeps a generous detail
    reserve for the final delivery decimator while making subsequent checks
    bounded. This is geometry-only; neural vertex attributes remain attached
    and the normal/material bake still happens later on the bounded mesh.
    """
    before = triangle_count(obj)
    if before <= target:
        return {
            "applied": False,
            "inputTriangles": before,
            "targetTriangles": target,
            "outputTriangles": before,
        }
    modifier = obj.modifiers.new("BasaltNeuralSourceBound", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = max(0.000001, min(1.0, target / before))
    modifier.use_collapse_triangulate = True
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    output = triangle_count(obj)
    if output <= 0:
        fail(
            "Neural source bound removed all geometry: "
            f"inputTriangles={before} targetTriangles={target}"
        )
    return {
        "applied": True,
        "inputTriangles": before,
        "targetTriangles": target,
        "outputTriangles": output,
        "ratio": modifier.ratio,
    }


def deterministic_voxel_remesh(obj: bpy.types.Object, target: int) -> dict[str, Any]:
    input_triangles = triangle_count(obj)
    retained_attributes = retained_neural_vertex_attributes(obj)
    dimensions = [float(value) for value in obj.dimensions]
    maximum_extent = max(dimensions)
    if not math.isfinite(maximum_extent) or maximum_extent <= 1e-8:
        fail("Voxel-remesh fallback received degenerate asset bounds")
    # A closed surface sampled at roughly sqrt(target / 2) cells across its
    # longest axis leaves enough geometric detail for a final bounded collapse
    # while avoiding the non-manifold floor that stopped the source topology.
    resolution = max(64, min(160, int(round(math.sqrt(target / 2)))))
    voxel_size = maximum_extent / resolution
    obj.data.remesh_voxel_size = voxel_size
    obj.data.remesh_voxel_adaptivity = 0.0
    obj.data.use_remesh_preserve_volume = True
    obj.data.use_remesh_preserve_attributes = True
    activate(obj)
    bpy.ops.object.voxel_remesh()
    clean_geometry(obj)
    output_triangles = triangle_count(obj)
    if output_triangles <= 0:
        fail(
            "Deterministic voxel remesh removed all geometry: "
            f"inputTriangles={input_triangles} outputTriangles={output_triangles} "
            f"targetTriangles={target}"
        )
    output_attributes = retained_neural_vertex_attributes(obj)
    if output_attributes != retained_attributes:
        fail("Deterministic voxel remesh did not retain neural PBR attributes")
    return {
        "inputTriangles": input_triangles,
        "outputTriangles": output_triangles,
        "voxelSize": voxel_size,
        "resolutionAcrossLargestExtent": resolution,
        "preservedAttributes": output_attributes,
    }


def decimate_to_budget(
    obj: bpy.types.Object,
    target: int,
    *,
    preserve_neural_surface: bool = False,
) -> dict[str, Any]:
    initial = triangle_count(obj)
    if initial <= target:
        return {
            "inputTriangles": initial,
            "targetTriangles": target,
            "outputTriangles": initial,
            "applied": False,
            "strategy": "none",
            "collapsePasses": [],
        }
    collapse_passes = []
    # Neural tensor meshes commonly contain thin, open surfaces. Blender's
    # voxel remesher is useful for sealed catalog meshes, but it invents a new
    # volume and can turn thin neural structure into spikes and blobby bridges.
    # Keep neural geometry on the original topology and spend extra collapse
    # passes to reach the delivery budget instead.
    maximum_collapse_passes = 6 if preserve_neural_surface else 2
    for _ in range(maximum_collapse_passes):
        if triangle_count(obj) <= target:
            break
        collapse_passes.append(apply_collapse_decimation(obj, target, 0.985))
    voxel_remesh = None
    if triangle_count(obj) > target:
        voxel_remesh = deterministic_voxel_remesh(obj, target)
        for _ in range(4):
            if triangle_count(obj) <= target:
                break
            collapse_passes.append(apply_collapse_decimation(obj, target, 0.9))
    output = triangle_count(obj)
    if output > target or output <= 0:
        fail(
            "Deterministic decimation could not satisfy the triangle budget: "
            f"inputTriangles={initial} outputTriangles={output} targetTriangles={target}"
        )
    result = {
        "inputTriangles": initial,
        "targetTriangles": target,
        "outputTriangles": output,
        "applied": True,
        "strategy": "voxel_remesh_then_collapse" if voxel_remesh else "collapse",
        "neuralSurfacePreserved": preserve_neural_surface,
        "collapsePasses": collapse_passes,
    }
    if voxel_remesh:
        result["voxelRemesh"] = voxel_remesh
    return result


@lru_cache(maxsize=4096)
def deterministic_seed(seed: str) -> int:
    return int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "little")


def deterministic_unit(seed: str, x: int, y: int, band: int) -> float:
    """Fast deterministic SplitMix64 sample; the semantic seed remains SHA-bound."""
    value = (
        deterministic_seed(seed)
        ^ ((x + 0x9E3779B9) * 0xBF58476D1CE4E5B9)
        ^ ((y + 0x94D049BB) * 0x94D049BB133111EB)
        ^ ((band + 1) * 0xD6E8FEB86659FD93)
    ) & 0xFFFFFFFFFFFFFFFF
    value = (value ^ (value >> 30)) * 0xBF58476D1CE4E5B9 & 0xFFFFFFFFFFFFFFFF
    value = (value ^ (value >> 27)) * 0x94D049BB133111EB & 0xFFFFFFFFFFFFFFFF
    value ^= value >> 31
    return (value & 0xFFFFFFFF) / 4294967295


def smooth_unit(value: float) -> float:
    bounded = max(0.0, min(1.0, value))
    return bounded * bounded * (3.0 - 2.0 * bounded)


def tileable_value_noise(
    u: float,
    v: float,
    cells_u: int,
    cells_v: int,
    seed: str,
    band: int,
) -> float:
    x = (u % 1.0) * cells_u
    y = (v % 1.0) * cells_v
    x0 = math.floor(x)
    y0 = math.floor(y)
    tx = smooth_unit(x - x0)
    ty = smooth_unit(y - y0)

    def sample(ix: int, iy: int) -> float:
        return deterministic_unit(seed, ix % cells_u, iy % cells_v, band)

    low = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx
    high = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx
    return low * (1 - ty) + high * ty


def tileable_fbm(
    u: float,
    v: float,
    cells: dict[str, int],
    octaves: int,
    lacunarity: int,
    gain: float,
    seed: str,
    basis: str = "value_fbm",
) -> float:
    amplitude = 1.0
    total = 0.0
    weight = 0.0
    frequency = 1
    for octave in range(octaves):
        value = tileable_value_noise(
            u,
            v,
            int(cells["u"]) * frequency,
            int(cells["v"]) * frequency,
            seed,
            octave,
        )
        if basis == "billow_fbm":
            value = abs(value * 2.0 - 1.0)
        elif basis == "ridged_fbm":
            value = 1.0 - abs(value * 2.0 - 1.0)
        total += value * amplitude
        weight += amplitude
        amplitude *= gain
        frequency *= lacunarity
    return total / weight if weight > 1e-12 else 0.0


def resolve_graph_color(
    style_entries: dict[str, dict[str, Any]], value: dict[str, Any]
) -> tuple[float, float, float]:
    if value["kind"] == "literal":
        return hex_rgb(value["color"])
    entry = style_entries[value["paletteEntryId"]]
    return hex_rgb(entry["color"] if value["channel"] == "base_color" else entry["emissive"])


def evaluate_material_graph(
    graph: dict[str, Any],
    style: dict[str, Any],
    surface: dict[str, Any],
) -> dict[str, Any]:
    nodes = {node["id"]: node for node in graph["nodes"]}
    palette = {entry["id"]: entry for entry in style["palette"]}
    seed = f"{graph['hash']}:{graph['seed']}"
    memo: dict[str, Any] = {}

    def scalar(identifier: str) -> float:
        value = evaluate(identifier)
        if isinstance(value, tuple):
            fail("Procedural material scalar reference resolved to a vector")
        return float(value)

    def color(identifier: str) -> tuple[float, float, float]:
        value = evaluate(identifier)
        if not isinstance(value, tuple) or len(value) != 3:
            fail("Procedural material color reference resolved to another type")
        return value

    def coordinate(identifier: str) -> tuple[tuple[float, float, float], ...]:
        value = evaluate(identifier)
        if (
            not isinstance(value, tuple)
            or not value
            or any(
                not isinstance(projection, tuple) or len(projection) != 3
                for projection in value
            )
        ):
            fail("Procedural material coordinate reference resolved to another type")
        return value

    def projected_scalar(identifier: str, operation: Any) -> float:
        return sum(
            float(weight) * float(operation(float(u), float(v)))
            for u, v, weight in coordinate(identifier)
        )

    def wrap_coordinate(value: float, mode: str) -> float:
        if mode == "repeat":
            return value % 1.0
        mirrored = value % 2.0
        return 2.0 - mirrored if mirrored > 1.0 else mirrored

    def evaluate(identifier: str) -> Any:
        if identifier in memo:
            return memo[identifier]
        node = nodes[identifier]
        kind = node["kind"]
        if kind == "scalar_constant":
            result: Any = float(node["value"])
        elif kind == "surface_coordinates":
            projection = node["projection"]
            if projection["kind"] == "uv0":
                result = ((float(surface["uv0"][0]), float(surface["uv0"][1]), 1.0),)
            else:
                point = surface["positionStuds"]
                normal = surface["normal"]
                exponent = float(projection["blendExponent"])
                weights = [abs(float(normal[axis])) ** exponent for axis in range(3)]
                total_weight = sum(weights)
                weights = (
                    [1 / 3, 1 / 3, 1 / 3]
                    if total_weight <= 1e-12
                    else [value / total_weight for value in weights]
                )
                scale = projection["scaleStuds"]
                result = (
                    (
                        float(point[1]) / float(scale["u"]),
                        float(point[2]) / float(scale["v"]),
                        weights[0],
                    ),
                    (
                        float(point[0]) / float(scale["u"]),
                        float(point[2]) / float(scale["v"]),
                        weights[1],
                    ),
                    (
                        float(point[0]) / float(scale["u"]),
                        float(point[1]) / float(scale["v"]),
                        weights[2],
                    ),
                )
        elif kind == "coordinate_transform":
            pivot_u = float(node["pivot"]["u"])
            pivot_v = float(node["pivot"]["v"])
            angle = math.radians(float(node["rotationDegrees"]))
            result = tuple(
                (
                    wrap_coordinate(
                        (source_u - pivot_u) * float(node["scale"]["u"])
                        * math.cos(angle)
                        - (source_v - pivot_v) * float(node["scale"]["v"])
                        * math.sin(angle)
                        + pivot_u
                        + float(node["translation"]["u"]),
                        node["wrap"],
                    ),
                    wrap_coordinate(
                        (source_u - pivot_u) * float(node["scale"]["u"])
                        * math.sin(angle)
                        + (source_v - pivot_v) * float(node["scale"]["v"])
                        * math.cos(angle)
                        + pivot_v
                        + float(node["translation"]["v"]),
                        node["wrap"],
                    ),
                    weight,
                )
                for source_u, source_v, weight in coordinate(node["inputNodeId"])
            )
        elif kind == "polar_coordinates":
            result = tuple(
                (
                    math.atan2(
                        source_v - float(node["center"]["v"]),
                        source_u - float(node["center"]["u"]),
                    )
                    / math.tau
                    + float(node["angularOffset"]),
                    math.hypot(
                        source_u - float(node["center"]["u"]),
                        source_v - float(node["center"]["v"]),
                    )
                    * float(node["radialScale"]),
                    weight,
                )
                for source_u, source_v, weight in coordinate(node["inputNodeId"])
            )
        elif kind == "coordinate_gradient":
            def gradient(sample_u: float, sample_v: float) -> float:
                source_value = sample_u if node["axis"] == "u" else sample_v
                amount = (source_value - float(node["low"])) / (
                    float(node["high"]) - float(node["low"])
                )
                if node["clamp"]:
                    amount = max(0.0, min(1.0, amount))
                return 1.0 - amount if node["invert"] else amount

            result = projected_scalar(node["coordinateNodeId"], gradient)
        elif kind == "wave":
            def wave(sample_u: float, sample_v: float) -> float:
                position = (
                    sample_u * int(node["cycles"]["u"])
                    + sample_v * int(node["cycles"]["v"])
                    + float(node["phase"])
                ) % 1.0
                waveform = node["waveform"]
                if waveform == "sine":
                    raw = 0.5 + 0.5 * math.sin(position * math.tau)
                elif waveform == "triangle":
                    raw = 1.0 - abs(position * 2.0 - 1.0)
                elif waveform == "saw":
                    raw = position
                else:
                    duty = float(node["dutyCycle"])
                    softness = float(node["softness"])
                    if softness <= 1e-9:
                        raw = 1.0 if position < duty else 0.0
                    else:
                        reach = min(0.49, softness * 0.25)
                        enter = smooth_unit((position + reach) / (reach * 2))
                        leave = 1.0 - smooth_unit(
                            (position - duty + reach) / (reach * 2)
                        )
                        wrap_enter = smooth_unit(
                            (position - 1 + reach) / (reach * 2)
                        )
                        raw = max(min(enter, leave), wrap_enter)
                softness = float(node["softness"])
                return raw * (1 - softness * 0.25) + smooth_unit(raw) * softness * 0.25

            result = projected_scalar(node["coordinateNodeId"], wave)
        elif kind == "checker":
            def checker(sample_u: float, sample_v: float) -> float:
                x = (
                    sample_u * int(node["cells"]["u"])
                    + float(node["offset"]["u"])
                ) % 1.0
                y = (
                    sample_v * int(node["cells"]["v"])
                    + float(node["offset"]["v"])
                ) % 1.0
                raw = float(
                    (
                        math.floor(
                            sample_u * int(node["cells"]["u"])
                            + float(node["offset"]["u"])
                        )
                        + math.floor(
                            sample_v * int(node["cells"]["v"])
                            + float(node["offset"]["v"])
                        )
                    )
                    % 2
                )
                edge = min(x, 1 - x, y, 1 - y) * 2
                return (
                    0.5
                    + (raw - 0.5)
                    * smooth_unit(edge / max(1e-6, float(node["softness"])))
                    if node["softness"] > 0
                    else raw
                )

            result = projected_scalar(node["coordinateNodeId"], checker)
        elif kind == "brick":
            def brick(sample_u: float, sample_v: float) -> float:
                rows = int(node["cells"]["v"])
                columns = int(node["cells"]["u"])
                row_position = sample_v * rows
                row = math.floor(row_position)
                local_v = row_position - row
                local_u = (
                    sample_u * columns + row * float(node["rowOffset"])
                ) % 1.0
                edge = min(local_u, 1 - local_u, local_v, 1 - local_v)
                mortar = float(node["mortarFraction"]) * 0.5
                softness = float(node["edgeSoftness"]) * max(1e-6, 0.5 - mortar)
                return (
                    smooth_unit((edge - mortar) / softness)
                    if softness > 1e-9
                    else float(edge >= mortar)
                )

            result = projected_scalar(node["coordinateNodeId"], brick)
        elif kind == "noise":
            def noise(sample_u: float, sample_v: float) -> float:
                warp = node.get("domainWarp")
                if warp is not None and float(warp["amplitude"]) > 0:
                    warp_seed = f"{seed}:{node['seedOffset']}:warp"
                    first = tileable_fbm(
                        sample_u,
                        sample_v,
                        warp["cells"],
                        int(warp["octaves"]),
                        2,
                        0.5,
                        f"{warp_seed}:u",
                    )
                    second = tileable_fbm(
                        sample_u,
                        sample_v,
                        warp["cells"],
                        int(warp["octaves"]),
                        2,
                        0.5,
                        f"{warp_seed}:v",
                    )
                    sample_u += (first - 0.5) * float(warp["amplitude"])
                    sample_v += (second - 0.5) * float(warp["amplitude"])
                return tileable_fbm(
                    sample_u,
                    sample_v,
                    node["cells"],
                    int(node["octaves"]),
                    int(node["lacunarity"]),
                    float(node["gain"]),
                    f"{seed}:{node['seedOffset']}",
                    node["basis"],
                )

            result = projected_scalar(node["coordinateNodeId"], noise)
        elif kind == "cellular":
            def cellular(sample_u: float, sample_v: float) -> float:
                columns = int(node["cells"]["u"])
                rows = int(node["cells"]["v"])
                x = (sample_u % 1.0) * columns
                y = (sample_v % 1.0) * rows
                base_x = math.floor(x)
                base_y = math.floor(y)
                distances: list[tuple[float, float]] = []
                cell_seed = f"{seed}:{node['seedOffset']}:cellular"
                for offset_y in (-1, 0, 1):
                    for offset_x in (-1, 0, 1):
                        cell_x = base_x + offset_x
                        cell_y = base_y + offset_y
                        wrapped_x = cell_x % columns
                        wrapped_y = cell_y % rows
                        jitter = float(node["jitter"])
                        feature_x = cell_x + 0.5 + (
                            deterministic_unit(cell_seed, wrapped_x, wrapped_y, 0) - 0.5
                        ) * jitter
                        feature_y = cell_y + 0.5 + (
                            deterministic_unit(cell_seed, wrapped_x, wrapped_y, 1) - 0.5
                        ) * jitter
                        dx = x - feature_x
                        dy = y - feature_y
                        distance = (
                            abs(dx) + abs(dy)
                            if node["metric"] == "manhattan"
                            else math.hypot(dx, dy)
                        )
                        distances.append(
                            (
                                distance,
                                deterministic_unit(
                                    cell_seed, wrapped_x, wrapped_y, 2
                                ),
                            )
                        )
                distances.sort(key=lambda item: item[0])
                if node["output"] == "cell_value":
                    return distances[0][1]
                if node["output"] == "edge_distance":
                    return max(0.0, min(1.0, distances[1][0] - distances[0][0]))
                return max(0.0, min(1.0, distances[0][0] / math.sqrt(2)))

            result = projected_scalar(node["coordinateNodeId"], cellular)
        elif kind == "motif":
            def motif(sample_u: float, sample_v: float) -> float:
                local_u = (sample_u * int(node["cells"]["u"])) % 1.0 - float(
                    node["center"]["u"]
                )
                local_v = (sample_v * int(node["cells"]["v"])) % 1.0 - float(
                    node["center"]["v"]
                )
                angle = math.radians(float(node["rotationDegrees"]))
                rotated_u = local_u * math.cos(angle) - local_v * math.sin(angle)
                rotated_v = local_u * math.sin(angle) + local_v * math.cos(angle)
                normalized_u = abs(rotated_u) / (float(node["size"]["u"]) * 0.5)
                normalized_v = abs(rotated_v) / (float(node["size"]["v"]) * 0.5)
                if node["shape"] == "ellipse":
                    distance = math.hypot(normalized_u, normalized_v)
                elif node["shape"] == "diamond":
                    distance = normalized_u + normalized_v
                else:
                    distance = max(normalized_u, normalized_v)
                softness = float(node["edgeSoftness"])
                return (
                    1.0
                    - smooth_unit(
                        (distance - (1 - softness)) / max(1e-6, softness)
                    )
                    if softness > 0
                    else float(distance <= 1)
                )

            result = projected_scalar(node["coordinateNodeId"], motif)
        elif kind == "scalar_math":
            left = scalar(node["leftNodeId"])
            right = scalar(node["rightNodeId"])
            result = {
                "add": left + right,
                "subtract": left - right,
                "multiply": left * right,
                "minimum": min(left, right),
                "maximum": max(left, right),
            }[node["operation"]]
        elif kind == "scalar_mix":
            factor = max(0.0, min(1.0, scalar(node["factorNodeId"])))
            result = scalar(node["firstNodeId"]) * (1 - factor) + scalar(node["secondNodeId"]) * factor
        elif kind == "remap":
            amount = (scalar(node["inputNodeId"]) - float(node["inputMinimum"])) / (float(node["inputMaximum"]) - float(node["inputMinimum"]))
            if node["clamp"]:
                amount = max(0.0, min(1.0, amount))
            result = float(node["outputMinimum"]) + amount * (float(node["outputMaximum"]) - float(node["outputMinimum"]))
        elif kind == "smoothstep":
            result = smooth_unit((scalar(node["inputNodeId"]) - float(node["low"])) / (float(node["high"]) - float(node["low"])))
        elif kind == "invert":
            result = 1.0 - scalar(node["inputNodeId"])
        elif kind == "quantize":
            value = scalar(node["inputNodeId"])
            if "ditherNodeId" in node:
                value += (scalar(node["ditherNodeId"]) - 0.5) * float(node["ditherStrength"]) / int(node["steps"])
            result = round(max(0.0, min(1.0, value)) * (int(node["steps"]) - 1)) / (int(node["steps"]) - 1)
        elif kind == "palette_property":
            result = float(palette[node["paletteEntryId"]][node["property"]])
        elif kind == "context_field":
            result = float(surface[node["source"]])
            if node["invert"]:
                result = 1.0 - result
        elif kind == "color_constant":
            result = resolve_graph_color(palette, node["value"])
        elif kind == "color_ramp":
            amount = max(0.0, min(1.0, scalar(node["inputNodeId"])))
            stops = node["stops"]
            upper_index = next((index for index, stop in enumerate(stops) if float(stop["position"]) >= amount), len(stops) - 1)
            lower = stops[max(0, upper_index - 1)]
            upper = stops[upper_index]
            if node["interpolation"] == "constant" or lower is upper:
                factor = 0.0
            else:
                factor = (amount - float(lower["position"])) / (float(upper["position"]) - float(lower["position"]))
                if node["interpolation"] == "smooth":
                    factor = smooth_unit(factor)
            lower_color = resolve_graph_color(palette, lower["color"])
            upper_color = resolve_graph_color(palette, upper["color"])
            result = tuple(lower_color[channel] * (1 - factor) + upper_color[channel] * factor for channel in range(3))
        else:
            base = color(node["baseNodeId"])
            layer = color(node["layerNodeId"])
            factor = max(0.0, min(1.0, scalar(node["factorNodeId"])))
            operation = node["operation"]
            blended = []
            for channel in range(3):
                if operation == "multiply":
                    target = base[channel] * layer[channel]
                elif operation == "screen":
                    target = 1 - (1 - base[channel]) * (1 - layer[channel])
                elif operation == "overlay":
                    target = 2 * base[channel] * layer[channel] if base[channel] < 0.5 else 1 - 2 * (1 - base[channel]) * (1 - layer[channel])
                elif operation == "add":
                    target = min(1.0, base[channel] + layer[channel])
                else:
                    target = layer[channel]
                blended.append(base[channel] * (1 - factor) + target * factor)
            result = tuple(blended)
        memo[identifier] = result
        return result

    outputs = graph["outputs"]
    result: dict[str, float | tuple[float, float, float]] = {
        "base_color": color(outputs["baseColorNodeId"]),
        "roughness": scalar(outputs["roughnessNodeId"]),
        "metallic": scalar(outputs["metallicNodeId"]),
        "occlusion": scalar(outputs["occlusionNodeId"]),
        "opacity": scalar(outputs["opacityNodeId"]),
    }
    if outputs["normal"]["kind"] == "height_gradient":
        result["normal_height"] = scalar(outputs["normal"]["heightNodeId"])
    if "emissiveNodeId" in outputs:
        result["emissive"] = color(outputs["emissiveNodeId"])
    return result


def image_from_pixels(
    name: str,
    width: int,
    height: int,
    pixels: array,
    non_color: bool,
) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.update()
    image.pack()
    return image


def procedural_surface_context_atlas(
    obj: bpy.types.Object,
    width: int,
    height: int,
    studs_per_unit: float,
    required_fields: tuple[str, ...] | None = None,
    include_triplanar: bool = True,
    material_index: int | None = None,
) -> dict[str, array]:
    """Bake measured geometry fields into the exact UV0 atlas used by Roblox.

    Context fields are observations of the adapted mesh, after transform baking,
    cleanup, decimation, normal policy, and UV generation. They are not inferred
    from image-space borders or authored prose.
    """
    uv_layer = obj.data.uv_layers.active
    if uv_layer is None:
        fail("Procedural material context requires final UV0")
    obj.data.calc_loop_triangles()
    triangles = [
        triangle
        for triangle in obj.data.loop_triangles
        if material_index is None or int(triangle.material_index) == material_index
    ]
    if not triangles:
        fail("Procedural material context requires rendered triangles")
    vertex_curvature = array("f", [0.0]) * len(obj.data.vertices)
    public_fields = (
        "height_fraction",
        "normal_x",
        "normal_y",
        "normal_z",
        "upward_facing",
        "slope",
        "curvature",
        "contact",
        "edge_wear",
    )
    requested = set(public_fields if required_fields is None else required_fields)
    if not requested.issubset(public_fields):
        fail("Procedural material context requests an unsupported measured field")
    if requested.intersection({"curvature", "edge_wear"}):
        incident_normals: list[list[Vector]] = [[] for _ in obj.data.vertices]
        for triangle in triangles:
            normal = triangle.normal.normalized()
            for vertex_index in triangle.vertices:
                incident_normals[int(vertex_index)].append(normal.copy())
        for vertex_index, normals in enumerate(incident_normals):
            if len(normals) < 2:
                continue
            average = sum(normals, Vector((0.0, 0.0, 0.0)))
            if average.length <= 1e-12:
                vertex_curvature[vertex_index] = 1.0
                continue
            average.normalize()
            vertex_curvature[vertex_index] = max(
                0.0,
                min(
                    1.0,
                    sum(
                        1.0 - max(-1.0, min(1.0, normal.dot(average)))
                        for normal in normals
                    )
                    / len(normals)
                    * 2.0,
                ),
            )
    # Blender (X, Y, Z-up) -> canonical/glTF (X, Y-up, -Z-forward).
    positions = [
        Vector((vertex.co.x, vertex.co.z, -vertex.co.y)) * studs_per_unit
        for vertex in obj.data.vertices
    ]
    minimum_height = min(position.y for position in positions)
    maximum_height = max(position.y for position in positions)
    height_span = max(1e-6, maximum_height - minimum_height)
    contact_reach = max(1e-4, height_span * 0.15)
    names = tuple(sorted(requested)) + (
        (
            "position_x",
            "position_y",
            "position_z",
            "normal_x_raw",
            "normal_y_raw",
            "normal_z_raw",
        )
        if include_triplanar
        else ()
    )
    fields = {name: array("f", [0.0]) * (width * height) for name in names}
    covered = bytearray(width * height)
    operation_count = 0
    for triangle in triangles:
        loop_indices = tuple(int(index) for index in triangle.loops)
        vertex_indices = tuple(int(index) for index in triangle.vertices)
        points = [
            (
                float(uv_layer.data[loop_index].uv.x) * (width - 1),
                float(uv_layer.data[loop_index].uv.y) * (height - 1),
            )
            for loop_index in loop_indices
        ]
        x0, y0 = points[0]
        x1, y1 = points[1]
        x2, y2 = points[2]
        denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denominator) <= 1e-12:
            continue
        minimum_x = max(0, math.floor(min(x0, x1, x2)))
        maximum_x = min(width - 1, math.ceil(max(x0, x1, x2)))
        minimum_y = max(0, math.floor(min(y0, y1, y2)))
        maximum_y = min(height - 1, math.ceil(max(y0, y1, y2)))
        operation_count += max(0, maximum_x - minimum_x + 1) * max(
            0, maximum_y - minimum_y + 1
        )
        if operation_count > 64 * 1024 * 1024:
            fail("Procedural material context rasterization exceeds its work budget")
        triangle_positions = [positions[index] for index in vertex_indices]
        blender_normal = triangle.normal.normalized()
        triangle_normal = Vector(
            (blender_normal.x, blender_normal.z, -blender_normal.y)
        ).normalized()
        triangle_curvature = [vertex_curvature[index] for index in vertex_indices]
        for y in range(minimum_y, maximum_y + 1):
            sample_y = y + 0.5
            for x in range(minimum_x, maximum_x + 1):
                sample_x = x + 0.5
                weight0 = (
                    (y1 - y2) * (sample_x - x2) + (x2 - x1) * (sample_y - y2)
                ) / denominator
                weight1 = (
                    (y2 - y0) * (sample_x - x2) + (x0 - x2) * (sample_y - y2)
                ) / denominator
                weight2 = 1.0 - weight0 - weight1
                if min(weight0, weight1, weight2) < -1e-7:
                    continue
                weights = (weight0, weight1, weight2)
                point = sum(
                    (
                        triangle_positions[index] * weights[index]
                        for index in range(3)
                    ),
                    Vector((0.0, 0.0, 0.0)),
                )
                normal = triangle_normal
                curvature = max(
                    0.0,
                    min(
                        1.0,
                        sum(triangle_curvature[index] * weights[index] for index in range(3)),
                    ),
                )
                height_fraction = max(
                    0.0, min(1.0, (point.y - minimum_height) / height_span)
                )
                contact = max(
                    0.0, min(1.0, 1.0 - (point.y - minimum_height) / contact_reach)
                )
                upward = max(0.0, min(1.0, normal.y))
                slope = math.acos(max(-1.0, min(1.0, normal.y))) / math.pi
                edge_wear = max(
                    0.0,
                    min(
                        1.0,
                        curvature * (0.35 + upward * 0.65) * (1.0 - contact * 0.35),
                    ),
                )
                pixel_index = y * width + x
                values = {
                    "position_x": point.x,
                    "position_y": point.y,
                    "position_z": point.z,
                    "normal_x_raw": normal.x,
                    "normal_y_raw": normal.y,
                    "normal_z_raw": normal.z,
                    "height_fraction": height_fraction,
                    "normal_x": normal.x * 0.5 + 0.5,
                    "normal_y": normal.y * 0.5 + 0.5,
                    "normal_z": normal.z * 0.5 + 0.5,
                    "upward_facing": upward,
                    "slope": slope,
                    "curvature": curvature,
                    "contact": contact,
                    "edge_wear": edge_wear,
                }
                for name, value in values.items():
                    if name in fields:
                        fields[name][pixel_index] = float(value)
                covered[pixel_index] = 1
    if not any(covered):
        fail("Procedural material context rasterization covered no texels")
    for _ in range(8):
        additions: list[tuple[int, int]] = []
        for y in range(height):
            for x in range(width):
                pixel_index = y * width + x
                if covered[pixel_index]:
                    continue
                neighbour = next(
                    (
                        neighbour_y * width + neighbour_x
                        for offset_y, offset_x in ((-1, 0), (0, -1), (0, 1), (1, 0))
                        if 0 <= (neighbour_x := x + offset_x) < width
                        and 0 <= (neighbour_y := y + offset_y) < height
                        and covered[neighbour_y * width + neighbour_x]
                    ),
                    None,
                )
                if neighbour is not None:
                    additions.append((pixel_index, neighbour))
        if not additions:
            break
        for pixel_index, neighbour in additions:
            for field in fields.values():
                field[pixel_index] = field[neighbour]
            covered[pixel_index] = 1
    return fields


def procedural_surface_sample(
    atlas: dict[str, array] | None, pixel_index: int, u: float, v: float
) -> dict[str, Any]:
    if atlas is None:
        return {
            "uv0": (u, v),
            "positionStuds": (0.0, 0.0, 0.0),
            "normal": (0.0, 1.0, 0.0),
            "height_fraction": 0.0,
            "normal_x": 0.5,
            "normal_y": 1.0,
            "normal_z": 0.5,
            "upward_facing": 1.0,
            "slope": 0.0,
            "curvature": 0.0,
            "contact": 0.0,
            "edge_wear": 0.0,
        }
    def field(name: str, default: float) -> float:
        values = atlas.get(name)
        return float(values[pixel_index]) if values is not None else default

    return {
        "uv0": (u, v),
        "positionStuds": (
            field("position_x", 0.0),
            field("position_y", 0.0),
            field("position_z", 0.0),
        ),
        "normal": (
            field("normal_x_raw", 0.0),
            field("normal_y_raw", 1.0),
            field("normal_z_raw", 0.0),
        ),
        "height_fraction": field("height_fraction", 0.0),
        "normal_x": field("normal_x", 0.5),
        "normal_y": field("normal_y", 1.0),
        "normal_z": field("normal_z", 0.5),
        "upward_facing": field("upward_facing", 1.0),
        "slope": field("slope", 0.0),
        "curvature": field("curvature", 0.0),
        "contact": field("contact", 0.0),
        "edge_wear": field("edge_wear", 0.0),
    }


def procedural_material_images(
    graph: dict[str, Any],
    style: dict[str, Any],
    name: str,
    width: int,
    height: int,
    surface_atlas: dict[str, array] | None,
    u_pixels_per_stud: float,
    v_pixels_per_stud: float,
) -> dict[str, bpy.types.Image]:
    base_pixels = array("f", [0.0]) * (width * height * 4)
    orm_pixels = array("f", [0.0]) * (width * height * 4)
    height_values = array("f", [0.5]) * (width * height)
    emissive_pixels = array("f", [0.0]) * (width * height * 4)
    has_height = graph["outputs"]["normal"]["kind"] == "height_gradient"
    has_emissive = "emissiveNodeId" in graph["outputs"]
    for y in range(height):
        v = (y + 0.5) / height
        for x in range(width):
            u = (x + 0.5) / width
            pixel_index = y * width + x
            sample = evaluate_material_graph(
                graph,
                style,
                procedural_surface_sample(surface_atlas, pixel_index, u, v),
            )
            offset = (y * width + x) * 4
            base = sample["base_color"]
            if not isinstance(base, tuple):
                fail("Procedural base-color output is not a color")
            base_pixels[offset : offset + 4] = array(
                "f",
                (
                    *[max(0.0, min(1.0, float(value))) for value in base],
                    max(0.0, min(1.0, float(sample["opacity"]))),
                ),
            )
            orm_pixels[offset : offset + 4] = array(
                "f",
                (
                    max(0.0, min(1.0, float(sample["occlusion"]))),
                    max(0.0, min(1.0, float(sample["roughness"]))),
                    max(0.0, min(1.0, float(sample["metallic"]))),
                    1.0,
                ),
            )
            if has_height:
                height_values[pixel_index] = float(sample["normal_height"])
            if has_emissive:
                emissive = sample["emissive"]
                if not isinstance(emissive, tuple):
                    fail("Procedural emissive output is not a color")
                emissive_pixels[offset : offset + 4] = array(
                    "f", (*[max(0.0, min(1.0, float(value))) for value in emissive], 1.0)
                )
    result = {
        "base": image_from_pixels(f"{name}_BaseColor", width, height, base_pixels, False),
        "orm": image_from_pixels(f"{name}_ORM", width, height, orm_pixels, True),
    }
    if has_height:
        amplitude_studs = float(graph["outputs"]["normal"]["amplitudeStuds"])
        normal_pixels = array("f", [0.0]) * (width * height * 4)
        for y in range(height):
            for x in range(width):
                left = height_values[y * width + ((x - 1) % width)]
                right = height_values[y * width + ((x + 1) % width)]
                down = height_values[((y - 1) % height) * width + x]
                up = height_values[((y + 1) % height) * width + x]
                u_derivative = (right - left) * amplitude_studs * u_pixels_per_stud * 0.5
                v_derivative = (up - down) * amplitude_studs * v_pixels_per_stud * 0.5
                normal = Vector((-u_derivative, -v_derivative, 1.0)).normalized()
                offset = (y * width + x) * 4
                normal_pixels[offset : offset + 4] = array(
                    "f", (normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z, 1.0)
                )
        result["normal"] = image_from_pixels(f"{name}_Normal", width, height, normal_pixels, True)
    if has_emissive:
        result["emissive"] = image_from_pixels(f"{name}_Emissive", width, height, emissive_pixels, False)
    return result


def baked_triplanar_field(
    obj: bpy.types.Object,
    width: int,
    height: int,
    role: dict[str, Any],
    studs_per_unit: float,
    seed: str,
    material_index: int | None = None,
) -> array:
    """Rasterize an asset-local triplanar field into the exported UV0 atlas.

    The three canonical projections are evaluated from baked vertex positions,
    blended by the declared normal exponent, then flattened to pixels. Runtime
    materials therefore contain image textures and UV0 only.
    """
    obj.data.calc_loop_triangles()
    layer = obj.data.uv_layers.active.data
    result = array("f", [0.5]) * (width * height)
    scale = role["projection"]["scaleStuds"]
    exponent = float(role["projection"]["blendExponent"])
    for triangle in obj.data.loop_triangles:
        if material_index is not None and int(triangle.material_index) != material_index:
            continue
        uvs = [layer[index].uv.copy() for index in triangle.loops]
        points = [obj.data.vertices[index].co.copy() for index in triangle.vertices]
        normal = triangle.normal.normalized()
        weights = [abs(normal.x) ** exponent, abs(normal.y) ** exponent, abs(normal.z) ** exponent]
        total_weight = sum(weights)
        if total_weight <= 1e-12:
            weights = [1 / 3, 1 / 3, 1 / 3]
        else:
            weights = [value / total_weight for value in weights]
        low_x = max(0, math.floor(min(uv.x for uv in uvs) * width))
        high_x = min(width - 1, math.ceil(max(uv.x for uv in uvs) * width) - 1)
        low_y = max(0, math.floor(min(uv.y for uv in uvs) * height))
        high_y = min(height - 1, math.ceil(max(uv.y for uv in uvs) * height) - 1)
        determinant = (uvs[1] - uvs[0]).cross(uvs[2] - uvs[0])
        if abs(determinant) <= 1e-14:
            continue
        for y in range(low_y, high_y + 1):
            for x in range(low_x, high_x + 1):
                sample = Vector(((x + 0.5) / width, (y + 0.5) / height))
                if not point_inside_uv_triangle(sample.x, sample.y, uvs):
                    continue
                first = (sample - uvs[0]).cross(uvs[2] - uvs[0]) / determinant
                second = (uvs[1] - uvs[0]).cross(sample - uvs[0]) / determinant
                third = 1.0 - first - second
                point = (points[0] * third + points[1] * first + points[2] * second) * studs_per_unit
                projections = (
                    (point.y / float(scale["u"]), point.z / float(scale["v"])),
                    (point.x / float(scale["u"]), point.z / float(scale["v"])),
                    (point.x / float(scale["u"]), point.y / float(scale["v"])),
                )
                value = sum(
                    weights[axis]
                    * deterministic_unit(
                        f"{seed}:axis:{axis}",
                        math.floor(coordinates[0] * 16),
                        math.floor(coordinates[1] * 16),
                        axis,
                    )
                    for axis, coordinates in enumerate(projections)
                )
                result[y * width + x] = value
    return result


def apply_triplanar_field(
    image: bpy.types.Image,
    field: array | None,
    strength: float,
    channels: tuple[int, ...],
) -> bpy.types.Image:
    if field is None or strength <= 0:
        return image
    width, height = (int(value) for value in image.size[:])
    if len(field) != width * height:
        fail("Triplanar bake field dimensions differ from the target texture")
    pixels = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    for index, sample in enumerate(field):
        delta = (sample - 0.5) * strength
        for channel in channels:
            offset = index * 4 + channel
            pixels[offset] = max(0.0, min(1.0, pixels[offset] + delta))
    image.pixels.foreach_set(pixels)
    image.update()
    image.pack()
    return image


def generated_image(
    name: str,
    width: int,
    height: int,
    rgba: tuple[float, float, float, float],
    non_color: bool,
    seed: str,
    variation: float = 0.0,
    variation_scale_pixels: int = 16,
    wear: float = 0.0,
) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    pixels = array("f")
    broad_cell = max(1, int(variation_scale_pixels))
    medium_cell = max(1, broad_cell // 4)
    for y in range(height):
        for x in range(width):
            broad = deterministic_unit(seed, x // broad_cell, y // broad_cell, 0) - 0.5
            medium = deterministic_unit(seed, x // medium_cell, y // medium_cell, 1) - 0.5
            amount = (broad * 0.7 + medium * 0.3) * variation
            edge_distance = min(x, y, width - 1 - x, height - 1 - y)
            edge_reach = max(1, min(width, height) // 12)
            edge_wear = max(0.0, 1.0 - edge_distance / edge_reach)
            wear_noise = deterministic_unit(seed, x // medium_cell, y // medium_cell, 2)
            wear_response = edge_wear * wear * (0.35 + wear_noise * 0.65)
            pixels.extend(
                [
                    max(0.0, min(1.0, rgba[0] + amount - wear_response * 0.14)),
                    max(0.0, min(1.0, rgba[1] + amount - wear_response * 0.12)),
                    max(0.0, min(1.0, rgba[2] + amount - wear_response * 0.09)),
                    max(0.0, min(1.0, rgba[3])),
                ]
            )
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.update()
    image.pack()
    return image


def rasterized_point_color_image(
    obj: bpy.types.Object,
    attribute_name: str,
    image_name: str,
    width: int,
    height: int,
    non_color: bool,
    material_index: int | None = None,
) -> bpy.types.Image:
    attribute = obj.data.color_attributes.get(attribute_name)
    uv_layer = obj.data.uv_layers.active
    if attribute is None or attribute.domain not in {"POINT", "CORNER"} or uv_layer is None:
        fail(f"Tensor attribute cannot be baked to UV0: {attribute_name}")
    obj.data.calc_loop_triangles()
    pixels = array("f", [0.0]) * (width * height * 4)
    covered = bytearray(width * height)
    operation_count = 0

    def color(vertex_index: int, loop_index: int) -> tuple[float, float, float, float]:
        entry = attribute.data[vertex_index if attribute.domain == "POINT" else loop_index].color
        return tuple(float(entry[channel]) for channel in range(4))

    colors = [tuple(float(entry.color[channel]) for channel in range(4)) for entry in attribute.data]
    averages = tuple(
        sum(entry[channel] for entry in colors) / len(colors) for channel in range(4)
    )
    for triangle in obj.data.loop_triangles:
        if material_index is not None and int(triangle.material_index) != material_index:
            continue
        loop_indices = tuple(int(index) for index in triangle.loops)
        vertex_indices = tuple(int(index) for index in triangle.vertices)
        points = [
            (
                float(uv_layer.data[loop_index].uv.x) * (width - 1),
                float(uv_layer.data[loop_index].uv.y) * (height - 1),
            )
            for loop_index in loop_indices
        ]
        if any(not math.isfinite(value) for point in points for value in point):
            fail("Generated UV0 contains nonfinite coordinates")
        x0, y0 = points[0]
        x1, y1 = points[1]
        x2, y2 = points[2]
        denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denominator) <= 1e-12:
            continue
        minimum_x = max(0, math.floor(min(x0, x1, x2)))
        maximum_x = min(width - 1, math.ceil(max(x0, x1, x2)))
        minimum_y = max(0, math.floor(min(y0, y1, y2)))
        maximum_y = min(height - 1, math.ceil(max(y0, y1, y2)))
        if minimum_x > maximum_x or minimum_y > maximum_y:
            continue
        operation_count += (maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1)
        if operation_count > 64 * 1024 * 1024:
            fail("Tensor UV rasterization exceeds its deterministic work budget")
        triangle_colors = [
            color(vertex_indices[index], loop_indices[index]) for index in range(3)
        ]
        for y in range(minimum_y, maximum_y + 1):
            sample_y = y + 0.5
            for x in range(minimum_x, maximum_x + 1):
                sample_x = x + 0.5
                weight0 = (
                    (y1 - y2) * (sample_x - x2) + (x2 - x1) * (sample_y - y2)
                ) / denominator
                weight1 = (
                    (y2 - y0) * (sample_x - x2) + (x0 - x2) * (sample_y - y2)
                ) / denominator
                weight2 = 1.0 - weight0 - weight1
                if min(weight0, weight1, weight2) < -1e-7:
                    continue
                pixel_index = y * width + x
                offset = pixel_index * 4
                for channel in range(4):
                    pixels[offset + channel] = max(
                        0.0,
                        min(
                            1.0,
                            triangle_colors[0][channel] * weight0
                            + triangle_colors[1][channel] * weight1
                            + triangle_colors[2][channel] * weight2,
                        ),
                    )
                covered[pixel_index] = 1

    if not any(covered):
        fail("Tensor UV rasterization produced no covered texels")
    for _ in range(8):
        additions: list[tuple[int, tuple[float, float, float, float]]] = []
        for y in range(height):
            for x in range(width):
                pixel_index = y * width + x
                if covered[pixel_index]:
                    continue
                neighbours = []
                for offset_y, offset_x in ((-1, 0), (0, -1), (0, 1), (1, 0)):
                    neighbour_x = x + offset_x
                    neighbour_y = y + offset_y
                    if not (0 <= neighbour_x < width and 0 <= neighbour_y < height):
                        continue
                    neighbour_index = neighbour_y * width + neighbour_x
                    if covered[neighbour_index]:
                        start = neighbour_index * 4
                        neighbours.append(tuple(pixels[start + channel] for channel in range(4)))
                if neighbours:
                    additions.append(
                        (
                            pixel_index,
                            tuple(
                                sum(entry[channel] for entry in neighbours) / len(neighbours)
                                for channel in range(4)
                            ),
                        )
                    )
        if not additions:
            break
        for pixel_index, value in additions:
            start = pixel_index * 4
            pixels[start : start + 4] = array("f", value)
            covered[pixel_index] = 1
    for pixel_index, present in enumerate(covered):
        if present:
            continue
        start = pixel_index * 4
        pixels[start : start + 4] = array("f", averages)

    image = bpy.data.images.new(
        image_name, width=width, height=height, alpha=True
    )
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.update()
    image.pack()
    return image


def image_texture(material: bpy.types.Material, name: str, image: bpy.types.Image):
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.name = name
    node.label = name
    node.image = image
    node.interpolation = "Linear"
    return node


def first_linked_image(socket: Any) -> bpy.types.Image | None:
    if socket is None or not socket.is_linked:
        return None
    stack = [link.from_node for link in socket.links]
    visited: set[int] = set()
    while stack:
        node = stack.pop()
        if node.as_pointer() in visited:
            continue
        visited.add(node.as_pointer())
        if node.type == "TEX_IMAGE" and node.image is not None:
            return node.image
        for input_socket in node.inputs:
            stack.extend(link.from_node for link in input_socket.links)
    return None


def linked_image_channel(socket: Any, scalar: bool = False) -> dict[str, Any] | None:
    """Resolve one exact image/channel through the glTF import node patterns.

    Unsupported procedural or arithmetic graphs fail closed by returning no
    retained binding; they are never misidentified as an unrelated PBR map.
    """
    if socket is None or not socket.is_linked or len(socket.links) != 1:
        return None
    link = socket.links[0]
    node = link.from_node
    output_name = link.from_socket.name
    if node.type == "TEX_IMAGE" and node.image is not None:
        if output_name == "Alpha":
            channel: int | str = 3
        elif output_name == "Color":
            channel = "luminance" if scalar else "color"
        else:
            return None
        return {
            "image": node.image,
            "channel": channel,
            "extension": str(getattr(node, "extension", "REPEAT")),
        }
    if node.type in {"SEPARATE_COLOR", "SEPRGB"}:
        channel_by_name = {"Red": 0, "Green": 1, "Blue": 2, "Alpha": 3, "R": 0, "G": 1, "B": 2}
        channel = channel_by_name.get(output_name)
        color_input = node.inputs.get("Color") or node.inputs.get("Image")
        source = linked_image_channel(color_input, False)
        if channel is None or source is None:
            return None
        return {
            "image": source["image"],
            "channel": channel,
            "extension": source.get("extension", "REPEAT"),
        }
    if node.type == "NORMAL_MAP" and output_name == "Normal":
        return linked_image_channel(node.inputs.get("Color"), False)
    return None


def material_occlusion_binding(tree: Any) -> dict[str, Any] | None:
    for node in tree.nodes:
        if node.type != "GROUP" or node.inputs.get("Occlusion") is None:
            continue
        binding = linked_image_channel(node.inputs.get("Occlusion"), True)
        if binding is not None:
            return binding
    return None


def image_channel_samples(binding: dict[str, Any]) -> tuple[array, int, int, int | str]:
    image = binding["image"]
    width, height = (int(value) for value in image.size[:])
    if min(width, height) <= 0:
        fail("Source material contains an empty channel image")
    pixels = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    return pixels, width, height, binding["channel"]


def sampled_image_channel(
    source: tuple[array, int, int, int | str],
    x: int,
    y: int,
    width: int,
    height: int,
) -> float:
    pixels, source_width, source_height, channel = source
    source_x = min(source_width - 1, math.floor((x + 0.5) * source_width / width))
    source_y = min(source_height - 1, math.floor((y + 0.5) * source_height / height))
    offset = (source_y * source_width + source_x) * 4
    if isinstance(channel, int):
        return float(pixels[offset + channel])
    if channel == "luminance":
        return (
            float(pixels[offset]) * 0.2126
            + float(pixels[offset + 1]) * 0.7152
            + float(pixels[offset + 2]) * 0.0722
        )
    fail("Scalar material channel is not independently addressable")


def image_channel_mean(binding: dict[str, Any]) -> float:
    source = image_channel_samples(binding)
    return sum(
        sampled_image_channel(source, x, y, source[1], source[2])
        for y in range(source[2])
        for x in range(source[1])
    ) / (source[1] * source[2])


def apply_opacity_channel(image: bpy.types.Image, binding: dict[str, Any]) -> float:
    width, height = (int(value) for value in image.size[:])
    target = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(target)
    source = image_channel_samples(binding)
    minimum = 1.0
    for y in range(height):
        for x in range(width):
            value = max(0.0, min(1.0, sampled_image_channel(source, x, y, width, height)))
            target[(y * width + x) * 4 + 3] = value
            minimum = min(minimum, value)
    image.pixels.foreach_set(target)
    image.update()
    image.pack()
    return minimum


def apply_constant_opacity(image: bpy.types.Image, value: float) -> float:
    retained = max(0.0, min(1.0, float(value)))
    width, height = (int(item) for item in image.size[:])
    target = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(target)
    for pixel in range(width * height):
        target[pixel * 4 + 3] = retained
    image.pixels.foreach_set(target)
    image.update()
    image.pack()
    return retained


def material_roles_for_source(invocation: dict[str, Any], source_id: str) -> list[dict[str, Any]]:
    role_by_id = {role["id"]: role for role in invocation["materialRoles"]}
    identifiers = sorted(
        {
            part["materialRoleId"]
            for part in invocation["parts"]
            if part["sourceId"] == source_id and part["materialRoleId"] in role_by_id
        }
    )
    if not identifiers:
        fail(f"Source has no declared material role: {source_id}")
    return [role_by_id[identifier] for identifier in identifiers]


def material_variant_id(source_id: str, role_id: str, role_index: int) -> str:
    if role_index == 0:
        return source_id
    suffix = hashlib.sha256(f"{source_id}\0{role_id}".encode("utf-8")).hexdigest()[:12]
    return f"{source_id[:51]}_{suffix}"


def material_variants(invocation: dict[str, Any]) -> list[dict[str, Any]]:
    variants = []
    identifiers: set[str] = set()
    for source in invocation["sources"]:
        for role_index, role in enumerate(material_roles_for_source(invocation, source["id"])):
            identifier = material_variant_id(source["id"], role["id"], role_index)
            if identifier in identifiers:
                fail("Material variant identifiers collide")
            identifiers.add(identifier)
            variants.append(
                {
                    "id": identifier,
                    "source": source,
                    "materialRole": role,
                }
            )
    if len(variants) > 512:
        fail("Material variant inventory exceeds the worker policy")
    return variants


def variation_strength(role: dict[str, Any]) -> float:
    result = 0.0
    for weight, name in ((0.45, "macro"), (0.35, "meso"), (0.2, "micro")):
        band = role.get("variationBands", {}).get(name, {})
        if band.get("kind") == "variation":
            result += weight * float(band.get("strength", 0))
    return min(0.18, result * 0.18)


def ensure_principled(material: bpy.types.Material):
    material.use_nodes = True
    tree = material.node_tree
    principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if principled is None:
        tree.nodes.clear()
        output = tree.nodes.new("ShaderNodeOutputMaterial")
        principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
        tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    return tree, principled


def exact_resized_copy(
    image: bpy.types.Image, name: str, width: int, height: int, non_color: bool
) -> bpy.types.Image:
    source_width, source_height = (int(value) for value in image.size[:])
    if min(source_width, source_height) <= 0:
        fail("Source material contains an empty image")
    source_pixels = array("f", [0.0]) * (source_width * source_height * 4)
    image.pixels.foreach_get(source_pixels)
    result = bpy.data.images.new(name, width=width, height=height, alpha=True)
    if non_color:
        result.colorspace_settings.name = "Non-Color"
    target_pixels = array("f", [0.0]) * (width * height * 4)
    x_indices = [min(source_width - 1, math.floor((x + 0.5) * source_width / width)) for x in range(width)]
    for y in range(height):
        source_y = min(source_height - 1, math.floor((y + 0.5) * source_height / height))
        for x, source_x in enumerate(x_indices):
            source_offset = (source_y * source_width + source_x) * 4
            target_offset = (y * width + x) * 4
            target_pixels[target_offset : target_offset + 4] = source_pixels[
                source_offset : source_offset + 4
            ]
    result.pixels.foreach_set(target_pixels)
    result.update()
    result.pack()
    return result


def reprojected_uv_image(
    obj: bpy.types.Object,
    source_image: bpy.types.Image,
    source_uvs: list[tuple[float, float]],
    material_index: int,
    name: str,
    width: int,
    height: int,
    non_color: bool,
    extension: str = "REPEAT",
    tangent_normal: bool = False,
) -> bpy.types.Image:
    """Rebake one source image from the imported UVs into final UV0.

    Geometry is already cleaned and decimated, so loop correspondence is exact.
    Reprojection happens before source shader nodes are replaced. Normal maps
    are rotated from the source tangent frame into the destination tangent
    frame instead of copying pixels across arbitrarily rotated islands.
    """
    if len(source_uvs) != len(obj.data.loops):
        fail("Source UV snapshot no longer matches adapted mesh topology")
    source_width, source_height = (int(value) for value in source_image.size[:])
    if min(source_width, source_height, width, height) <= 0:
        fail("UV reprojection requires nonempty source and destination images")
    source_pixels = array("f", [0.0]) * (source_width * source_height * 4)
    source_image.pixels.foreach_get(source_pixels)
    source_average = tuple(
        sum(source_pixels[offset + channel] for offset in range(0, len(source_pixels), 4))
        / (source_width * source_height)
        for channel in range(4)
    )
    destination = array("f", [0.0]) * (width * height * 4)
    covered = bytearray(width * height)
    obj.data.calc_loop_triangles()
    uv_layer = obj.data.uv_layers.active
    if uv_layer is None:
        fail("UV reprojection requires final UV0")

    def sample(u: float, v: float) -> tuple[float, float, float, float]:
        mode = extension.upper()
        if mode == "REPEAT":
            u %= 1.0
            v %= 1.0
        elif mode in {"EXTEND", "MIRROR"}:
            if mode == "MIRROR":
                u = 1.0 - abs((u % 2.0) - 1.0)
                v = 1.0 - abs((v % 2.0) - 1.0)
            else:
                u = max(0.0, min(1.0, u))
                v = max(0.0, min(1.0, v))
        elif not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
            return (0.0, 0.0, 0.0, 0.0)
        x = u * source_width - 0.5
        y = v * source_height - 0.5
        x0 = math.floor(x)
        y0 = math.floor(y)
        tx = x - x0
        ty = y - y0

        def index(value: int, size: int) -> int:
            return value % size if mode == "REPEAT" else max(0, min(size - 1, value))

        x_indices = (index(x0, source_width), index(x0 + 1, source_width))
        y_indices = (index(y0, source_height), index(y0 + 1, source_height))
        result = []
        for channel in range(4):
            first = source_pixels[(y_indices[0] * source_width + x_indices[0]) * 4 + channel]
            second = source_pixels[(y_indices[0] * source_width + x_indices[1]) * 4 + channel]
            third = source_pixels[(y_indices[1] * source_width + x_indices[0]) * 4 + channel]
            fourth = source_pixels[(y_indices[1] * source_width + x_indices[1]) * 4 + channel]
            result.append(
                (first * (1 - tx) + second * tx) * (1 - ty)
                + (third * (1 - tx) + fourth * tx) * ty
            )
        return tuple(result)  # type: ignore[return-value]

    def tangent_frame(
        points: list[Vector], uvs: list[Vector]
    ) -> tuple[Vector, Vector, Vector] | None:
        first_edge = points[1] - points[0]
        second_edge = points[2] - points[0]
        normal = first_edge.cross(second_edge)
        if normal.length <= 1e-12:
            return None
        normal.normalize()
        first_uv = uvs[1] - uvs[0]
        second_uv = uvs[2] - uvs[0]
        determinant = first_uv.x * second_uv.y - first_uv.y * second_uv.x
        if abs(determinant) <= 1e-12:
            return None
        tangent = (first_edge * second_uv.y - second_edge * first_uv.y) / determinant
        bitangent_hint = (second_edge * first_uv.x - first_edge * second_uv.x) / determinant
        tangent -= normal * tangent.dot(normal)
        if tangent.length <= 1e-12:
            return None
        tangent.normalize()
        handedness = -1.0 if normal.cross(tangent).dot(bitangent_hint) < 0 else 1.0
        bitangent = normal.cross(tangent) * handedness
        return tangent, bitangent, normal

    operation_count = 0
    for triangle in obj.data.loop_triangles:
        if int(triangle.material_index) != material_index:
            continue
        loop_indices = [int(index) for index in triangle.loops]
        destination_uvs = [uv_layer.data[index].uv.copy() for index in loop_indices]
        imported_uvs = [Vector(source_uvs[index]) for index in loop_indices]
        pixel_points = [
            Vector((uv.x * (width - 1), uv.y * (height - 1)))
            for uv in destination_uvs
        ]
        x0, y0 = pixel_points[0]
        x1, y1 = pixel_points[1]
        x2, y2 = pixel_points[2]
        denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denominator) <= 1e-12:
            continue
        low_x = max(0, math.floor(min(point.x for point in pixel_points)))
        high_x = min(width - 1, math.ceil(max(point.x for point in pixel_points)))
        low_y = max(0, math.floor(min(point.y for point in pixel_points)))
        high_y = min(height - 1, math.ceil(max(point.y for point in pixel_points)))
        operation_count += max(0, high_x - low_x + 1) * max(0, high_y - low_y + 1)
        if operation_count > 64 * 1024 * 1024:
            fail("Source texture UV reprojection exceeds its deterministic work budget")
        frames = None
        if tangent_normal:
            geometry = [obj.data.vertices[index].co.copy() for index in triangle.vertices]
            frames = (
                tangent_frame(geometry, imported_uvs),
                tangent_frame(geometry, destination_uvs),
            )
        for y in range(low_y, high_y + 1):
            sample_y = y + 0.5
            for x in range(low_x, high_x + 1):
                sample_x = x + 0.5
                first = ((y1 - y2) * (sample_x - x2) + (x2 - x1) * (sample_y - y2)) / denominator
                second = ((y2 - y0) * (sample_x - x2) + (x0 - x2) * (sample_y - y2)) / denominator
                third = 1.0 - first - second
                if min(first, second, third) < -1e-7:
                    continue
                imported_uv = imported_uvs[0] * first + imported_uvs[1] * second + imported_uvs[2] * third
                rgba = sample(imported_uv.x, imported_uv.y)
                if tangent_normal and frames and frames[0] is not None and frames[1] is not None:
                    source_frame, destination_frame = frames
                    sampled_normal = Vector(
                        (rgba[0] * 2 - 1, rgba[1] * 2 - 1, rgba[2] * 2 - 1)
                    )
                    if sampled_normal.length > 1e-8:
                        sampled_normal.normalize()
                        object_normal = (
                            source_frame[0] * sampled_normal.x
                            + source_frame[1] * sampled_normal.y
                            + source_frame[2] * sampled_normal.z
                        ).normalized()
                        encoded = Vector(
                            (
                                object_normal.dot(destination_frame[0]),
                                object_normal.dot(destination_frame[1]),
                                object_normal.dot(destination_frame[2]),
                            )
                        ).normalized()
                        rgba = (
                            encoded.x * 0.5 + 0.5,
                            encoded.y * 0.5 + 0.5,
                            encoded.z * 0.5 + 0.5,
                            rgba[3],
                        )
                pixel_index = y * width + x
                offset = pixel_index * 4
                destination[offset : offset + 4] = array("f", rgba)
                covered[pixel_index] = 1
    if not any(covered):
        fail("Source texture UV reprojection covered no destination texels")
    gutter = min(8, max(2, math.floor(min(width, height) * 0.003 + 0.5)))
    for _ in range(gutter):
        additions: list[tuple[int, tuple[float, float, float, float]]] = []
        for y in range(height):
            for x in range(width):
                pixel_index = y * width + x
                if covered[pixel_index]:
                    continue
                neighbour = next(
                    (
                        neighbour_y * width + neighbour_x
                        for offset_y, offset_x in ((-1, 0), (0, -1), (0, 1), (1, 0))
                        if 0 <= (neighbour_x := x + offset_x) < width
                        and 0 <= (neighbour_y := y + offset_y) < height
                        and covered[neighbour_y * width + neighbour_x]
                    ),
                    None,
                )
                if neighbour is not None:
                    start = neighbour * 4
                    additions.append(
                        (pixel_index, tuple(destination[start + channel] for channel in range(4)))
                    )
        if not additions:
            break
        for pixel_index, rgba in additions:
            destination[pixel_index * 4 : pixel_index * 4 + 4] = array("f", rgba)
            covered[pixel_index] = 1
    fill = (0.5, 0.5, 1.0, 1.0) if tangent_normal else source_average
    for pixel_index, present in enumerate(covered):
        if not present:
            destination[pixel_index * 4 : pixel_index * 4 + 4] = array("f", fill)
    return image_from_pixels(name, width, height, destination, non_color)


def hex_rgb(value: str) -> tuple[float, float, float]:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        fail("Style palette color is invalid")
    return tuple(int(value[index : index + 2], 16) / 255 for index in (1, 3, 5))


def combined_variation_strength(style: dict[str, Any], role: dict[str, Any]) -> float:
    role_strength = variation_strength(role)
    style_strength = float(style["surfaceVariation"]["intensity"])
    wear = float(style["wearPolicy"]["amount"])
    return min(1.0, role_strength + style_strength * 0.42 + wear * 0.12)


def material_adaptation_strength(role: dict[str, Any]) -> float:
    policy = role["materialAdaptation"]
    if policy["kind"] == "preserve_source":
        return 0.0
    if policy["kind"] == "harmonize":
        return float(policy["strength"])
    return 1.0


def variation_cell_pixels(
    style: dict[str, Any], role: dict[str, Any], width: int, height: int
) -> int:
    projection = role["projection"]["scaleStuds"]
    coverage = math.sqrt(float(projection["u"]) * float(projection["v"]))
    scale = float(style["surfaceVariation"]["scaleStuds"])
    return max(1, min(max(width, height), math.floor(math.sqrt(width * height) * scale / coverage + 0.5)))


def refinish_base_image(
    source: bpy.types.Image,
    name: str,
    width: int,
    height: int,
    palette_rgb: tuple[float, float, float],
    strength: float,
    seed: str,
    variation: float,
    variation_scale_pixels: int,
    wear: float,
) -> bpy.types.Image:
    image = exact_resized_copy(source, name, width, height, False)
    if strength <= 0:
        return image
    pixels = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    broad_cell = max(1, variation_scale_pixels)
    medium_cell = max(1, broad_cell // 4)
    edge_reach = max(1, min(width, height) // 12)
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 4
            source_rgb = tuple(float(pixels[offset + channel]) for channel in range(3))
            luminance = source_rgb[0] * 0.2126 + source_rgb[1] * 0.7152 + source_rgb[2] * 0.0722
            value = max(0.35, min(1.45, 0.55 + luminance * 0.9))
            broad = deterministic_unit(seed, x // broad_cell, y // broad_cell, 0) - 0.5
            medium = deterministic_unit(seed, x // medium_cell, y // medium_cell, 1) - 0.5
            variation_response = (broad * 0.7 + medium * 0.3) * variation * strength
            edge_distance = min(x, y, width - 1 - x, height - 1 - y)
            edge_wear = max(0.0, 1.0 - edge_distance / edge_reach)
            wear_response = edge_wear * wear * strength * (
                0.35 + deterministic_unit(seed, x // medium_cell, y // medium_cell, 2) * 0.65
            )
            for channel in range(3):
                palette_value = palette_rgb[channel] * value
                mixed = source_rgb[channel] * (1 - strength) + palette_value * strength
                pixels[offset + channel] = max(
                    0.0,
                    min(1.0, mixed + variation_response - wear_response * (0.14 - channel * 0.025)),
                )
    image.pixels.foreach_set(pixels)
    image.update()
    image.pack()
    return image


def refinish_orm_image(
    occlusion: dict[str, Any] | None,
    roughness_source: dict[str, Any] | None,
    metallic_source: dict[str, Any] | None,
    name: str,
    width: int,
    height: int,
    source_roughness_default: float,
    source_metallic_default: float,
    palette_roughness: float,
    palette_metallic: float,
    strength: float,
    seed: str,
    variation: float,
    variation_scale_pixels: int,
    wear: float,
) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    pixels = array("f", [0.0]) * (width * height * 4)
    occlusion_pixels = image_channel_samples(occlusion) if occlusion is not None else None
    roughness_pixels = (
        image_channel_samples(roughness_source) if roughness_source is not None else None
    )
    metallic_pixels = (
        image_channel_samples(metallic_source) if metallic_source is not None else None
    )
    broad_cell = max(1, variation_scale_pixels)
    medium_cell = max(1, broad_cell // 4)
    edge_reach = max(1, min(width, height) // 12)
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 4
            detail = deterministic_unit(seed, x // broad_cell, y // broad_cell, 0) - 0.5
            source_occlusion = (
                sampled_image_channel(occlusion_pixels, x, y, width, height)
                if occlusion_pixels is not None
                else 1.0
            )
            source_roughness = (
                sampled_image_channel(roughness_pixels, x, y, width, height)
                if roughness_pixels is not None
                else source_roughness_default
            )
            source_metallic = (
                sampled_image_channel(metallic_pixels, x, y, width, height)
                if metallic_pixels is not None
                else source_metallic_default
            )
            edge_distance = min(x, y, width - 1 - x, height - 1 - y)
            edge_wear = max(0.0, 1.0 - edge_distance / edge_reach)
            wear_response = edge_wear * wear * strength * (
                0.4 + deterministic_unit(seed, x // medium_cell, y // medium_cell, 1) * 0.6
            )
            pixels[offset] = max(0.0, min(1.0, source_occlusion))
            pixels[offset + 1] = max(
                0.0,
                min(
                    1.0,
                    source_roughness * (1 - strength)
                    + palette_roughness * strength
                    + detail * variation * strength * 0.08
                    + wear_response * 0.1,
                ),
            )
            pixels[offset + 2] = max(
                0.0,
                min(
                    1.0,
                    source_metallic * (1 - strength)
                    + palette_metallic * strength
                    - wear_response * 0.08,
                ),
            )
            pixels[offset + 3] = 1.0
    image.pixels.foreach_set(pixels)
    image.update()
    image.file_format = "PNG"
    image.pack()
    return image


def generated_normal_image(
    name: str,
    width: int,
    height: int,
    seed: str,
    variation: float,
    variation_scale_pixels: int,
    wear: float,
) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    pixels = array("f")
    cell = max(1, variation_scale_pixels // 4)

    def height_sample(x: int, y: int) -> float:
        return deterministic_unit(seed, x // cell, y // cell, 0) * variation + deterministic_unit(
            seed, x // max(1, cell // 3), y // max(1, cell // 3), 1
        ) * wear * 0.25

    for y in range(height):
        for x in range(width):
            dx = height_sample(min(width - 1, x + 1), y) - height_sample(max(0, x - 1), y)
            dy = height_sample(x, min(height - 1, y + 1)) - height_sample(x, max(0, y - 1))
            normal = Vector((-dx * 0.7, -dy * 0.7, 1.0)).normalized()
            pixels.extend((normal.x * 0.5 + 0.5, normal.y * 0.5 + 0.5, normal.z, 1.0))
    image.pixels.foreach_set(pixels)
    image.file_format = "PNG"
    image.update()
    image.pack()
    return image


def gltf_occlusion_node(material: bpy.types.Material, color_output: Any) -> None:
    tree = material.node_tree
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    node = tree.nodes.new("ShaderNodeGroup")
    node.name = "glTF Material Output"
    node.node_tree = group
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(color_output, separate.inputs["Color"])
    tree.links.new(separate.outputs["Red"], node.inputs["Occlusion"])


def normalize_materials(
    obj: bpy.types.Object,
    invocation: dict[str, Any],
    mesh_id: str,
    role: dict[str, Any],
    tensor_info: dict[str, Any] | None,
    material_budget: int,
    studs_per_unit: float,
    source_uvs: list[tuple[float, float]] | None,
) -> list[dict[str, Any]]:
    material_class = role["materialClass"]
    style = invocation["styleContract"]
    policy = role["materialAdaptation"]
    palette = declared_palette_entry(style, role)
    palette_rgb = hex_rgb(palette["color"]) if palette is not None else None
    adaptation_strength = material_adaptation_strength(role)
    maximum_edge = int(invocation["delivery"]["maximumTextureEdge"])
    required = set(invocation["requiredTextureChannels"])
    # Repair identity may vary the bounded material finishing field only. It is
    # deliberately absent from geometry import, cleanup, decimation, transforms,
    # support, collision, pivots, sockets, and canonical-root derivation.
    finish_seed = material_finish_seed(invocation, role)
    surface_variation = combined_variation_strength(style, role)
    wear_amount = float(style["wearPolicy"]["amount"])
    procedural_graph = policy["graph"] if policy["kind"] == "synthesize" else None
    if not obj.data.materials:
        obj.data.materials.append(bpy.data.materials.new(f"Basalt_{mesh_id}_Material"))
    original_materials = list(obj.data.materials)
    used_materials = {
        original_materials[polygon.material_index]
        for polygon in obj.data.polygons
        if polygon.material_index < len(original_materials)
        and original_materials[polygon.material_index] is not None
    }
    materials = sorted(
        used_materials,
        key=lambda item: item.name,
    )[:material_budget]
    if not materials:
        fail("Adapted mesh has no usable material")
    keep_indices = {material.name: index for index, material in enumerate(materials)}
    fallback = materials[0]
    material_assignments = []
    for polygon in obj.data.polygons:
        source_material = (
            original_materials[polygon.material_index]
            if polygon.material_index < len(original_materials)
            and original_materials[polygon.material_index] is not None
            else fallback
        )
        material_assignments.append(keep_indices.get(source_material.name, 0))
    obj.data.materials.clear()
    for material in materials:
        obj.data.materials.append(material)
    for polygon, material_index in zip(obj.data.polygons, material_assignments, strict=True):
        polygon.material_index = material_index
    rows = []
    tensor_averages = (tensor_info or {}).get("averages", {})
    for index, material in enumerate(materials):
        profile = texture_profile(
            style,
            role,
            maximum_edge,
            obj,
            studs_per_unit,
            index,
        )
        generated_width = int(profile["width"])
        generated_height = int(profile["height"])
        variation_scale = variation_cell_pixels(
            style, role, generated_width, generated_height
        )
        triplanar_field = (
            baked_triplanar_field(
                obj,
                generated_width,
                generated_height,
                role,
                studs_per_unit,
                f"{finish_seed}:{mesh_id}:{index}:triplanar:{role['projection']['blendExponent']}",
                index,
            )
            if role["projection"]["mode"] == "asset_triplanar"
            else None
        )
        tensor_textures = (
            {
                "base": rasterized_point_color_image(
                    obj,
                    "BasaltTensorBaseColor",
                    f"Basalt_{mesh_id}_{index}_SampledBaseColor",
                    generated_width,
                    generated_height,
                    False,
                    index,
                ),
                "orm": rasterized_point_color_image(
                    obj,
                    "BasaltTensorORM",
                    f"Basalt_{mesh_id}_{index}_SampledORM",
                    generated_width,
                    generated_height,
                    True,
                    index,
                ),
            }
            if tensor_info is not None
            else None
        )
        surface_atlas = (
            procedural_surface_context_atlas(
                obj,
                generated_width,
                generated_height,
                studs_per_unit,
                tuple(material_graph_context_sources(procedural_graph)),
                material_graph_uses_triplanar_coordinates(procedural_graph),
                index,
            )
            if procedural_graph is not None
            and (
                material_graph_context_sources(procedural_graph)
                or material_graph_uses_triplanar_coordinates(procedural_graph)
            )
            else None
        )
        material.name = f"Basalt_{mesh_id}_{index:03d}"
        source_tree, source_principled = ensure_principled(material)
        base_binding = linked_image_channel(source_principled.inputs.get("Base Color"), False)
        source_base_color = tuple(
            float(value) for value in source_principled.inputs.get("Base Color").default_value[:3]
        )
        roughness_binding = linked_image_channel(source_principled.inputs.get("Roughness"), True)
        metallic_binding = linked_image_channel(source_principled.inputs.get("Metallic"), True)
        source_roughness = float(source_principled.inputs.get("Roughness").default_value)
        source_metallic = float(source_principled.inputs.get("Metallic").default_value)
        opacity_binding = linked_image_channel(source_principled.inputs.get("Alpha"), True)
        emission_socket = source_principled.inputs.get("Emission Color") or source_principled.inputs.get(
            "Emission"
        )
        emissive_binding = linked_image_channel(emission_socket, False)
        if emissive_binding is None:
            retained_emissive_image = first_linked_image(emission_socket)
            if retained_emissive_image is not None:
                emissive_binding = {"image": retained_emissive_image, "channel": "color"}
        occlusion_binding = material_occlusion_binding(source_tree)
        normal_binding = linked_image_channel(source_principled.inputs.get("Normal"), False)
        if source_uvs is not None:
            reprojection_cache: dict[tuple[int, bool, bool], bpy.types.Image] = {}

            def reproject_binding(
                binding: dict[str, Any] | None,
                label: str,
                non_color: bool,
                tangent_normal: bool = False,
            ) -> dict[str, Any] | None:
                if binding is None:
                    return None
                key = (binding["image"].as_pointer(), non_color, tangent_normal)
                image = reprojection_cache.get(key)
                if image is None:
                    image = reprojected_uv_image(
                        obj,
                        binding["image"],
                        source_uvs,
                        index,
                        f"Basalt_{mesh_id}_{index}_Reprojected{label}",
                        generated_width,
                        generated_height,
                        non_color,
                        str(binding.get("extension", "REPEAT")),
                        tangent_normal,
                    )
                    reprojection_cache[key] = image
                return {**binding, "image": image, "extension": "EXTEND"}

            base_binding = reproject_binding(base_binding, "BaseColor", False)
            roughness_binding = reproject_binding(roughness_binding, "Roughness", True)
            metallic_binding = reproject_binding(metallic_binding, "Metallic", True)
            opacity_binding = reproject_binding(opacity_binding, "Opacity", True)
            emissive_binding = reproject_binding(emissive_binding, "Emissive", False)
            occlusion_binding = reproject_binding(occlusion_binding, "Occlusion", True)
            normal_binding = reproject_binding(normal_binding, "Normal", True, True)
        existing_base = base_binding["image"] if base_binding is not None else None
        existing_normal = normal_binding["image"] if normal_binding is not None else None
        source_alpha = float(source_principled.inputs.get("Alpha").default_value)
        source_emission = (
            tuple(float(value) for value in emission_socket.default_value[:3])
            if emission_socket is not None
            else (0.0, 0.0, 0.0)
        )
        source_emission_strength_socket = source_principled.inputs.get("Emission Strength")
        source_emission_strength = (
            float(source_emission_strength_socket.default_value)
            if source_emission_strength_socket is not None
            else 1.0
        )
        source_tree.nodes.clear()
        output = source_tree.nodes.new("ShaderNodeOutputMaterial")
        principled = source_tree.nodes.new("ShaderNodeBsdfPrincipled")
        source_tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
        tree = source_tree
        base_socket = principled.inputs.get("Base Color")
        recipe = procedural_graph
        recipe_images = (
            procedural_material_images(
                recipe,
                style,
                f"Basalt_{mesh_id}_{index}_Procedural",
                generated_width,
                generated_height,
                surface_atlas,
                float(profile["uPixelsPerStud"]),
                float(profile["vPixelsPerStud"]),
            )
            if recipe is not None
            else None
        )
        source_base_image = (
            tensor_textures["base"] if tensor_textures is not None else existing_base
        )
        if source_base_image is None:
            source_base_image = generated_image(
                f"Basalt_{mesh_id}_{index}_RetainedConstantBaseColor",
                generated_width,
                generated_height,
                source_base_color + (1.0,),
                False,
                f"{finish_seed}:{mesh_id}:{index}:source-base",
            )
        if policy["kind"] == "preserve_source":
            base_color_handling = "baked_sampled" if tensor_textures is not None else "retained"
            base_image = exact_resized_copy(
                source_base_image,
                f"Basalt_{mesh_id}_{index}_RetainedBaseColor",
                generated_width,
                generated_height,
                False,
            )
        elif policy["kind"] == "harmonize":
            base_color_handling = "harmonized"
            base_image = refinish_base_image(
                source_base_image,
                f"Basalt_{mesh_id}_{index}_StyleBaseColor",
                generated_width,
                generated_height,
                palette_rgb,
                adaptation_strength,
                f"{finish_seed}:{mesh_id}:{index}:base",
                surface_variation,
                variation_scale,
                wear_amount,
            )
        else:
            base_color_handling = "synthesized"
            base_image = recipe_images["base"]
        if recipe is None:
            apply_triplanar_field(
                base_image,
                triplanar_field,
                surface_variation * adaptation_strength * 0.35,
                (0, 1, 2),
            )
        node = image_texture(material, "BasaltAdaptedBaseColor", base_image)
        tree.links.new(node.outputs["Color"], base_socket)
        alpha = principled.inputs.get("Alpha")
        if alpha is None:
            fail("Pinned Principled material lacks an Alpha input")
        opacity_policy = role["opacity"]
        source_opacity_binding = (
            {"image": recipe_images["base"], "channel": 3}
            if recipe_images is not None
            else {"image": tensor_textures["base"], "channel": 3}
            if tensor_textures is not None
            else opacity_binding
        )
        if opacity_policy["kind"] == "opaque":
            opacity_handling = "opaque"
            minimum_opacity = apply_constant_opacity(base_image, 1.0)
            opacity = 1.0
            alpha.default_value = 1.0
        elif opacity_policy["kind"] == "mask":
            if source_opacity_binding is None:
                fail("Masked material requires a source opacity texture or attribute")
            opacity_handling = "baked_sampled" if tensor_textures is not None else "retained"
            minimum_opacity = apply_opacity_channel(base_image, source_opacity_binding)
            opacity = image_channel_mean(source_opacity_binding)
            cutoff = tree.nodes.new("ShaderNodeMath")
            cutoff.name = f"BasaltAlphaCutoff_{mesh_id}_{index}"
            cutoff.operation = "LESS_THAN"
            cutoff.inputs[1].default_value = float(opacity_policy["cutoff"])
            tree.links.new(node.outputs["Alpha"], cutoff.inputs[0])
            invert = tree.nodes.new("ShaderNodeMath")
            invert.name = f"BasaltAlphaMask_{mesh_id}_{index}"
            invert.operation = "SUBTRACT"
            invert.inputs[0].default_value = 1.0
            tree.links.new(cutoff.outputs[0], invert.inputs[1])
            tree.links.new(invert.outputs[0], alpha)
            material.surface_render_method = "DITHERED"
        elif opacity_policy["source"]["kind"] == "source_texture_or_attribute":
            if source_opacity_binding is None:
                fail("Texture-backed blend requires a source opacity texture or attribute")
            opacity_handling = "baked_sampled" if tensor_textures is not None else "retained"
            minimum_opacity = apply_opacity_channel(base_image, source_opacity_binding)
            opacity = image_channel_mean(source_opacity_binding)
            tree.links.new(node.outputs["Alpha"], alpha)
            material.surface_render_method = "BLENDED"
        else:
            opacity_handling = "declared_constant"
            opacity = float(opacity_policy["source"]["alpha"])
            minimum_opacity = opacity
            apply_constant_opacity(base_image, 1.0)
            alpha.default_value = opacity
            material.surface_render_method = "BLENDED"

        roughness_socket = principled.inputs["Roughness"]
        metallic_socket = principled.inputs["Metallic"]
        if tensor_textures is not None:
            roughness_binding = {"image": tensor_textures["orm"], "channel": 1}
            metallic_binding = {"image": tensor_textures["orm"], "channel": 2}
            source_roughness = float(tensor_averages.get("roughness", (source_roughness,))[0])
            source_metallic = float(tensor_averages.get("metallic", (source_metallic,))[0])
        palette_roughness = (
            float(palette["roughness"]) if palette is not None else source_roughness
        )
        palette_metallic = (
            float(palette["metallic"]) if palette is not None else source_metallic
        )
        roughness_socket.default_value = palette_roughness
        metallic_socket.default_value = palette_metallic
        if policy["kind"] == "synthesize":
            metallic_roughness_handling = "synthesized"
            orm = recipe_images["orm"]
            occlusion_handling = "synthesized"
        else:
            metallic_roughness_handling = (
                "harmonized"
                if policy["kind"] == "harmonize"
                else ("baked_sampled" if tensor_textures is not None else "retained")
            )
            orm = refinish_orm_image(
                occlusion_binding,
                roughness_binding,
                metallic_binding,
                f"Basalt_{mesh_id}_{index}_StyleORM",
                generated_width,
                generated_height,
                source_roughness,
                source_metallic,
                palette_roughness,
                palette_metallic,
                adaptation_strength,
                f"{finish_seed}:{mesh_id}:{index}:orm",
                surface_variation,
                variation_scale,
                wear_amount,
            )
            occlusion_handling = "retained" if occlusion_binding is not None else "neutral_default"
        if recipe is None:
            apply_triplanar_field(
                orm,
                triplanar_field,
                min(0.08, surface_variation * adaptation_strength * 0.08),
                (1, 2),
            )
        orm_node = image_texture(material, "BasaltAdaptedOcclusionRoughnessMetallic", orm)
        separate = tree.nodes.new("ShaderNodeSeparateColor")
        tree.links.new(orm_node.outputs["Color"], separate.inputs["Color"])
        tree.links.new(separate.outputs["Green"], roughness_socket)
        tree.links.new(separate.outputs["Blue"], metallic_socket)
        gltf_occlusion_node(material, orm_node.outputs["Color"])

        normal_socket = principled.inputs["Normal"]
        normal_policy = role["shading"]["normalTexture"]
        if normal_policy["kind"] == "preserve_source":
            if existing_normal is None and tensor_info is None:
                fail("Normal-texture preservation was requested but the source has no normal map")
            if existing_normal is None:
                # TRELLIS mesh bundles carry sampled surface normals rather
                # than a tangent-space image. The repaired delivery mesh owns
                # those geometric normals; a neutral tangent texture retains
                # that response while satisfying the explicit channel
                # contract without inventing unsupported micro-detail.
                normal_handling = "synthesized"
                normal_image = generated_image(
                    f"Basalt_{mesh_id}_{index}_GeometryNormal",
                    generated_width,
                    generated_height,
                    (0.5, 0.5, 1.0, 1.0),
                    True,
                    f"{finish_seed}:{mesh_id}:{index}:geometry-normal",
                )
            else:
                normal_handling = "retained"
                normal_image = exact_resized_copy(
                    existing_normal,
                    f"Basalt_{mesh_id}_{index}_StyleNormal",
                    generated_width,
                    generated_height,
                    True,
                )
            normal_texture = image_texture(material, "BasaltRetainedStyleNormal", normal_image)
            normal_map = tree.nodes.new("ShaderNodeNormalMap")
            normal_map.inputs["Strength"].default_value = 1.0
            tree.links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], normal_socket)
        elif normal_policy["kind"] == "synthesize":
            normal_handling = "synthesized"
            normal_image = (
                recipe_images["normal"]
                if recipe_images is not None
                else generated_normal_image(
                    f"Basalt_{mesh_id}_{index}_Normal",
                    generated_width,
                    generated_height,
                    f"{finish_seed}:{mesh_id}:{index}:normal",
                    surface_variation,
                    variation_scale,
                    wear_amount,
                )
            )
            normal_texture = image_texture(material, "BasaltNormalTexture", normal_image)
            normal_map = tree.nodes.new("ShaderNodeNormalMap")
            normal_map.inputs["Strength"].default_value = float(normal_policy["strength"])
            tree.links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], normal_socket)
        else:
            normal_handling = "omitted"

        emissive_handling = "not_required"
        emission = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
        emission_strength = principled.inputs.get("Emission Strength")
        if emission:
            if policy["kind"] != "synthesize" and emissive_binding is not None:
                emissive_handling = "retained"
                emissive_image = exact_resized_copy(
                    emissive_binding["image"],
                    f"Basalt_{mesh_id}_{index}_RetainedEmissive",
                    generated_width,
                    generated_height,
                    False,
                )
                emissive_node = image_texture(material, "BasaltRetainedEmissive", emissive_image)
                tree.links.new(emissive_node.outputs["Color"], emission)
                if emission_strength is not None:
                    emission_strength.default_value = source_emission_strength
            elif (
                policy["kind"] != "synthesize"
                and max(source_emission) * source_emission_strength > 1e-6
            ):
                emissive_handling = "retained"
                emissive_image = generated_image(
                    f"Basalt_{mesh_id}_{index}_RetainedConstantEmissive",
                    generated_width,
                    generated_height,
                    source_emission + (1.0,),
                    False,
                    f"{finish_seed}:{mesh_id}:{index}:source-emissive",
                )
                emissive_node = image_texture(material, "BasaltRetainedConstantEmissive", emissive_image)
                tree.links.new(emissive_node.outputs["Color"], emission)
                if emission_strength is not None:
                    emission_strength.default_value = source_emission_strength
            elif policy["kind"] == "synthesize" and "emissive" in recipe_images:
                emissive_handling = "synthesized"
                emissive_image = recipe_images["emissive"]
                emissive_node = image_texture(material, "BasaltEmissive", emissive_image)
                tree.links.new(emissive_node.outputs["Color"], emission)
                if emission_strength is not None:
                    emission_strength.default_value = 1.0
        rows.append(
            {
                "name": material.name,
                "materialClass": material_class,
                "materialRoleIds": [role["id"]],
                "materialAdaptation": policy,
                "shading": role["shading"],
                "opacity": opacity_policy,
                "harmonizationPaletteEntryId": (
                    palette["id"] if palette is not None else None
                ),
                "proceduralGraph": (
                    {
                        "hash": recipe["hash"],
                        "nodeCount": len(recipe["nodes"]),
                        "evaluationCost": material_graph_evaluation_cost(recipe),
                        "paletteEntryIds": material_graph_palette_entry_ids(recipe),
                        "robloxLowering": material_graph_lowering_report(
                            recipe, profile, role
                        ),
                    }
                    if recipe is not None
                    else None
                ),
                "generatedTextureEdge": max(generated_width, generated_height),
                "generatedTextureSize": {
                    "width": generated_width,
                    "height": generated_height,
                },
                "styleResponse": {
                    "surfaceVariationScaleStuds": style["surfaceVariation"]["scaleStuds"],
                    "appliedSurfaceVariationIntensity": float(
                        style["surfaceVariation"]["intensity"]
                    )
                    * adaptation_strength
                    if recipe is None
                    else 0.0,
                    "appliedWearAmount": float(style["wearPolicy"]["amount"])
                    * adaptation_strength
                    if recipe is None
                    else 0.0,
                },
                "projection": role["projection"],
                "variationStrength": (
                    surface_variation * adaptation_strength if recipe is None else 0.0
                ),
                "textureHandling": {
                    "baseColor": base_color_handling,
                    "metallicRoughness": metallic_roughness_handling,
                    "normal": normal_handling,
                    "occlusion": occlusion_handling,
                    "opacity": opacity_handling,
                    "emissive": emissive_handling,
                },
                "response": {
                    "adaptationStrength": adaptation_strength,
                    "paletteRoughness": (
                        float(palette["roughness"]) if palette is not None else None
                    ),
                    "paletteMetallic": (
                        float(palette["metallic"]) if palette is not None else None
                    ),
                    "opacity": opacity,
                },
            }
        )
    return rows


def set_surface_normals(obj: bpy.types.Object, policy: str) -> None:
    if policy not in ("preserve_source", "flat", "smooth"):
        fail("Surface-normal policy is invalid")
    if policy != "preserve_source":
        for polygon in obj.data.polygons:
            polygon.use_smooth = policy == "smooth"
    activate(obj, edit=True)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.update()


def export_glb(obj: bpy.types.Object, path: pathlib.Path) -> None:
    activate(obj)
    result = bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
        export_materials="EXPORT",
        export_tangents=True,
    )
    if "FINISHED" not in result or not path.is_file() or path.stat().st_size > MAX_OUTPUT_BYTES:
        fail("Blender did not produce a bounded canonical GLB")


def repair_exported_tangent_frames(path: pathlib.Path) -> int:
    """Normalize glTF tangents and repair exporter zeros on minute UV faces."""
    data = bytearray(path.read_bytes())
    if len(data) < 28 or struct.unpack_from("<I", data, 0)[0] != 0x46546C67:
        fail("Tangent repair requires a GLB 2.0 file")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A or 20 + json_length + 8 > len(data):
        fail("Tangent repair found an invalid GLB JSON chunk")
    document = json.loads(bytes(data[20 : 20 + json_length]).decode("utf-8").rstrip(" \t\r\n\0"))
    binary_header = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", data, binary_header)
    binary_start = binary_header + 8
    if binary_type != 0x004E4942 or binary_start + binary_length > len(data):
        fail("Tangent repair found an invalid GLB binary chunk")
    accessors = document.get("accessors", [])
    views = document.get("bufferViews", [])

    def accessor_layout(index: int, components: int) -> tuple[int, int, int]:
        accessor = accessors[index]
        view = views[accessor["bufferView"]]
        if (
            accessor.get("componentType") != 5126
            or accessor.get("type") != ("VEC4" if components == 4 else "VEC3")
            or view.get("buffer", 0) != 0
        ):
            fail("Tangent repair requires float tangent and normal accessors")
        stride = int(view.get("byteStride", components * 4))
        start = binary_start + int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
        return start, stride, int(accessor["count"])

    repaired = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            tangent_index = attributes.get("TANGENT")
            normal_index = attributes.get("NORMAL")
            if tangent_index is None or normal_index is None:
                continue
            tangent_start, tangent_stride, tangent_count = accessor_layout(tangent_index, 4)
            normal_start, normal_stride, normal_count = accessor_layout(normal_index, 3)
            if tangent_count != normal_count:
                fail("Tangent and normal accessor counts differ")
            for index in range(tangent_count):
                tangent_offset = tangent_start + index * tangent_stride
                normal_offset = normal_start + index * normal_stride
                x, y, z, handedness = struct.unpack_from("<4f", data, tangent_offset)
                length = math.sqrt(x * x + y * y + z * z)
                if math.isfinite(length) and length > 1e-8:
                    normalized = (x / length, y / length, z / length)
                    sign = -1.0 if handedness < 0 else 1.0
                    if abs(length - 1.0) <= 1e-6 and handedness in (-1.0, 1.0):
                        continue
                else:
                    normal = Vector(struct.unpack_from("<3f", data, normal_offset))
                    if normal.length <= 1e-8:
                        fail("Tangent repair found an invalid vertex normal")
                    normal.normalize()
                    axes = (Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0)))
                    reference = min(axes, key=lambda axis: abs(axis.dot(normal)))
                    tangent = reference.cross(normal).normalized()
                    normalized = (tangent.x, tangent.y, tangent.z)
                    sign = -1.0 if handedness < 0 else 1.0
                struct.pack_into("<4f", data, tangent_offset, *normalized, sign)
                repaired += 1
    if repaired:
        path.write_bytes(data)
    return repaired


def prepared_source_object(
    invocation: dict[str, Any],
    variant: dict[str, Any],
    variant_count: int,
) -> tuple[bpy.types.Object, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    source = variant["source"]
    role = variant["materialRole"]
    mesh_id = variant["id"]
    triangle_target = min(
        20_000, int(invocation["delivery"]["maximumUniqueTriangles"]) // variant_count
    )
    if triangle_target < 1:
        fail("Unique triangle budget is smaller than the material variant inventory")
    reset_scene()
    if source["kind"] == "mesh_attribute_bundle":
        obj, source_evidence = import_tensor_source(
            source,
            max_triangles=max(triangle_target * 8, 100_000),
            expected_world_size=(
                float(invocation["delivery"]["expectedBounds"]["size"]["x"]),
                float(invocation["delivery"]["expectedBounds"]["size"]["y"]),
                float(invocation["delivery"]["expectedBounds"]["size"]["z"]),
            ),
        )
        obj.matrix_world = IDENTITY
    else:
        imported, source_evidence = import_glb_source(source)
        extra_transform = source_canonical_matrix(source)
        obj = evaluated_baked_mesh(imported, extra_transform)
    neural_cleanup = None
    neural_source_bound = None
    if source["kind"] == "mesh_attribute_bundle":
        # Keep an 8x detail reserve for the final adapter pass, but never let
        # an untrusted neural mesh enter loose-component or UV analysis at
        # multi-million-triangle scale.
        neural_source_bound = bound_neural_source(obj, max(triangle_target * 8, 100_000))
        obj, neural_cleanup = remove_neural_dust(obj)
        # Component count alone is a poor neural-quality signal: O-Voxel
        # outputs often contain thousands of one-pixel slivers around a
        # single coherent surface. Reject only when cleanup removes a
        # material fraction of the triangles; tiny disconnected dust is safe
        # to discard and should not block a visually coherent candidate.
        if neural_cleanup["removedTriangleFraction"] > 0.02:
            fail(
                "Neural surface fragmented: "
                f"componentCount={neural_cleanup['componentCount']} "
                f"removedComponents={neural_cleanup['removedComponents']} "
                f"removedTriangleFraction={neural_cleanup['removedTriangleFraction']:.6f}"
            )
    obj.name = mesh_id
    obj.data.name = f"{mesh_id}_Mesh"
    geometry = clean_geometry(obj)
    edge = apply_edge_policy(obj, [role], invocation["delivery"]["expectedBounds"]["size"])
    if edge["applied"]:
        clean_geometry(obj)
    decimation = decimate_to_budget(
        obj,
        triangle_target,
        preserve_neural_surface=source["kind"] == "mesh_attribute_bundle",
    )
    set_surface_normals(obj, role["shading"]["surfaceNormals"])
    if neural_cleanup is not None:
        decimation["looseComponentCleanup"] = neural_cleanup
    if neural_source_bound is not None:
        decimation["neuralSourceBound"] = neural_source_bound
    return obj, source_evidence, geometry, edge, decimation


def measure_source_geometry(
    invocation: dict[str, Any], variant: dict[str, Any], variant_count: int
) -> dict[str, Any]:
    obj, _, _, _, _ = prepared_source_object(invocation, variant, variant_count)
    low, high = object_bounds_gltf(obj)
    return {
        "id": variant["id"],
        "sourceId": variant["source"]["id"],
        "materialRoleId": variant["materialRole"]["id"],
        "bounds": {"minimum": low, "maximum": high},
        "collisionSupportPatches": collision_support_patches(obj),
        "assetContactPatches": asset_contact_patches(obj, invocation["surfacePlacement"]),
    }


def exported_physical_proxy(
    path: pathlib.Path,
    node_name: str,
    surface_placement: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Measure proxy surfaces from the float-encoded delivery GLB itself."""
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    candidates = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    target = next((obj for obj in candidates if obj.name == node_name), None)
    if target is None or len(candidates) != 1:
        fail(f"Adapted GLB round trip lost its physical-proxy node: {node_name}")
    return (
        collision_support_patches(target),
        asset_contact_patches(target, surface_placement),
    )


def apply_contact_blend_vertex_colors(
    obj: bpy.types.Object, falloff_meters: float = 0.5
) -> dict[str, Any]:
    """Encode a linear bottom contact falloff in a retained vertex-color layer.

    The canonical delivery frame is Y-up. Values below the measured bottom are
    opaque to the blend (alpha 0), values at or above the falloff height are
    fully present (alpha 1). This is a mesh attribute only; it never deforms or
    resizes the source geometry at runtime.
    """
    if falloff_meters <= 0 or not math.isfinite(falloff_meters):
        fail("Contact blend falloff must be a positive finite distance")
    mesh = obj.data
    existing = mesh.attributes.get("BasaltContactBlend")
    if existing is not None:
        mesh.attributes.remove(existing)
    # Use the generic attribute collection so Blender's active-color exporter
    # cannot reinterpret a source base-color/opacity texture as COLOR_0.
    attribute = mesh.attributes.new(name="BasaltContactBlend", type="FLOAT_COLOR", domain="POINT")
    low, _ = object_bounds_gltf(obj)
    bottom_y = float(low[1])
    blender_to_gltf = GLTF_TO_BLENDER.inverted()
    for vertex in mesh.vertices:
        world_point = obj.matrix_world @ vertex.co.to_4d()
        canonical_point = blender_to_gltf @ world_point
        alpha = max(0.0, min(1.0, (float(canonical_point.y) - bottom_y) / falloff_meters))
        attribute.data[vertex.index].color = (1.0, 1.0, 1.0, alpha)
    mesh.update()
    return {
        "attribute": "BasaltContactBlend",
        "domain": "POINT",
        "falloffMeters": falloff_meters,
        "bottomY": bottom_y,
        "minimumAlpha": 0.0,
        "maximumAlpha": 1.0,
    }


def process_source(
    invocation: dict[str, Any],
    variant: dict[str, Any],
    output: pathlib.Path,
    variant_index: int,
    variant_count: int,
    studs_per_unit: float,
) -> dict[str, Any]:
    source = variant["source"]
    role = variant["materialRole"]
    mesh_id = variant["id"]
    obj, source_evidence, geometry, edge, decimation = prepared_source_object(
        invocation, variant, variant_count
    )
    uv_generation, source_uvs = ensure_uv(
        obj,
        role,
        invocation["styleContract"],
        int(invocation["delivery"]["maximumTextureEdge"]),
        studs_per_unit,
    )
    material_target = max(
        1, int(invocation["delivery"]["maximumMaterials"]) // variant_count
    )
    materials = normalize_materials(
        obj,
        invocation,
        mesh_id,
        role,
        source_evidence.get("tensorAttributes"),
        material_target,
        studs_per_unit,
        source_uvs,
    )
    uv = measured_uv_report(obj, materials, studs_per_unit, uv_generation, role)
    assert_uv_admission(uv, invocation["styleContract"])
    # Blender's glTF importer treats an unbound custom color layer as the
    # active COLOR_0 stream and can drop source base-color/opacity textures.
    # Tensor routes have no source COLOR_0 and retain the vertex layer safely;
    # authored GLB routes carry the same falloff as a material contact mask.
    contact_blend = (
        apply_contact_blend_vertex_colors(obj)
        if source["kind"] == "mesh_attribute_bundle"
        else {
            "attribute": "BasaltContactBlend",
            "domain": "POINT",
            "falloffMeters": 0.5,
            "storage": "material_contact_mask",
        }
    )
    # Neural point attributes are an adaptation input. Their values have now
    # been baked into the admitted base-color and ORM textures, so retaining
    # them would leak an unsupported COLOR_0 stream into the delivery GLB.
    for attribute_name in ("BasaltTensorBaseColor", "BasaltTensorORM"):
        if attribute := obj.data.color_attributes.get(attribute_name):
            obj.data.color_attributes.remove(attribute)
    obj.matrix_world = IDENTITY
    output_path = output / f"mesh-{variant_index:03d}.glb"
    low, high = object_bounds_gltf(obj)
    triangles = triangle_count(obj)
    export_glb(obj, output_path)
    repaired_tangent_frames = repair_exported_tangent_frames(output_path)
    collision_surfaces, contact_surfaces = exported_physical_proxy(
        output_path,
        mesh_id,
        invocation["surfacePlacement"],
    )
    return {
        "id": mesh_id,
        "sourceId": source["id"],
        "materialRoleId": role["id"],
        "file": output_path.name,
        "sha256": sha256(output_path),
        "bytes": output_path.stat().st_size,
        "nodeName": mesh_id,
        "bounds": {"minimum": low, "maximum": high},
        "triangles": triangles,
        "geometry": geometry,
        "decimation": decimation,
        "uv": uv,
        "normals": {
            "recalculated": True,
            "canonicalWinding": "outward",
            "surfacePolicy": role["shading"]["surfaceNormals"],
        },
        "tangents": {
            "exported": True,
            "basis": "uv0",
            "repairedFrames": repaired_tangent_frames,
        },
        "edgeTreatment": edge,
        "collisionSupportPatches": collision_surfaces,
        "assetContactPatches": contact_surfaces,
        "materials": materials,
        "contactBlend": contact_blend,
        "tensorAttributes": source_evidence.get("tensorAttributes"),
        "transform": {
            "sourceOwnership": source["transformOwnership"],
            "bakedExactlyOnce": True,
            "outputNodeTransform": "identity",
        },
    }


def canonical_transform_matrix(transform: dict[str, Any], pivot: dict[str, Any]) -> Matrix:
    position = transform["position"]
    rotation = transform["rotation"]
    scale = transform["scale"]
    # A part transform names the root-space position of its mesh-local pivot.
    # Subtract that pivot once. Rx @ Ry @ Rz matches the fixed TypeScript
    # asset/scene transform convention.
    translation = Matrix.Translation(Vector((position["x"], position["y"], position["z"])))
    rotate_x = Matrix.Rotation(math.radians(rotation["xDegrees"]), 4, "X")
    rotate_y = Matrix.Rotation(math.radians(rotation["yDegrees"]), 4, "Y")
    rotate_z = Matrix.Rotation(math.radians(rotation["zDegrees"]), 4, "Z")
    scaling = Matrix.Diagonal(Vector((scale["x"], scale["y"], scale["z"], 1)))
    unpivot = Matrix.Translation(Vector((-pivot["x"], -pivot["y"], -pivot["z"])))
    canonical = translation @ rotate_x @ rotate_y @ rotate_z @ scaling @ unpivot
    return GLTF_TO_BLENDER @ canonical @ GLTF_TO_BLENDER.inverted()


def preview_instances(
    parts: list[dict[str, Any]], output: pathlib.Path, meshes: list[dict[str, Any]]
) -> list[bpy.types.Object]:
    reset_scene()
    variants: dict[str, bpy.types.Object] = {}
    for mesh in meshes:
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=str(output / mesh["file"]), import_pack_images=True)
        added = [item for item in bpy.context.scene.objects if item not in before and item.type == "MESH"]
        target = next((item for item in added if item.name == mesh["id"]), None)
        if target is None:
            fail(f"Adapted GLB round trip lost its node: {mesh['id']}")
        variants[mesh["id"]] = target
    instances = []
    for part in parts:
        source = variants[part["meshId"]]
        for index, transform in enumerate(part["placements"]):
            instance = source.copy()
            instance.data = source.data
            instance.name = f"Preview_{part['id']}_{index:04d}"
            bpy.context.scene.collection.objects.link(instance)
            instance.matrix_world = canonical_transform_matrix(transform, part["pivot"])
            instances.append(instance)
    for source in variants.values():
        bpy.data.objects.remove(source, do_unlink=True)
    return instances


def combined_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        fail("Preview has no geometry")
    return (
        Vector(tuple(min(point[index] for point in points) for index in range(3))),
        Vector(tuple(max(point[index] for point in points) for index in range(3))),
    )


def add_preview_ground(low: Vector, high: Vector) -> None:
    size = max(high.x - low.x, high.y - low.y, 1) * 3.0
    bpy.ops.mesh.primitive_plane_add(size=size, location=((low.x + high.x) / 2, (low.y + high.y) / 2, low.z - 0.0125))
    ground = bpy.context.object
    ground.name = "BasaltPreviewGround"
    material = bpy.data.materials.new("BasaltPreviewGroundMaterial")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.022, 0.03, 0.045, 1)
    principled.inputs["Roughness"].default_value = 0.86
    ground.data.materials.append(material)


def render_previews(
    parts: list[dict[str, Any]], output: pathlib.Path, meshes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    objects = preview_instances(parts, output, meshes)
    scene = bpy.context.scene
    low, high = combined_bounds(objects)
    center = (low + high) * 0.5
    span = high - low
    radius = max(span.length * 0.6, 0.5)
    add_preview_ground(low, high)
    camera_data = bpy.data.cameras.new("BasaltAdmissionCamera")
    camera = bpy.data.objects.new("BasaltAdmissionCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for name, direction, color, energy, extent in (
        ("Key", Vector((-1.0, -1.2, 1.5)), (1.0, 0.77, 0.56), 72, 0.72),
        ("Fill", Vector((1.15, -0.15, 0.65)), (0.46, 0.65, 1.0), 28, 0.9),
        ("Rim", Vector((-0.55, 1.1, 1.05)), (0.62, 0.76, 1.0), 42, 0.7),
    ):
        data = bpy.data.lights.new(f"BasaltAdmission{name}", "AREA")
        data.energy = max(300, radius * radius * energy)
        data.color = color
        data.shape = "DISK"
        data.size = radius * extent
        light = bpy.data.objects.new(f"BasaltAdmission{name}", data)
        scene.collection.objects.link(light)
        light.location = center + direction * radius
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    scene.world = bpy.data.worlds.new("BasaltAdmissionWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.014, 0.024, 0.045, 1)
    background.inputs["Strength"].default_value = 0.3
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.45
    results = []
    for view, direction, distance, lens in PREVIEW_VIEWS:
        camera.location = center + direction.normalized() * radius * distance
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera_data.lens = lens
        path = output / f"preview-{view}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        if not path.is_file() or path.stat().st_size <= 0:
            fail(f"Admission preview was not rendered: {view}")
        results.append({"view": view, "file": path.name, "sha256": sha256(path), "bytes": path.stat().st_size})
    return results


def metadata_point(
    point: dict[str, Any], pivot: dict[str, Any], placement: dict[str, Any]
) -> Vector:
    """Compose mesh-local metadata with the exact part transform once."""
    blender_point = GLTF_TO_BLENDER @ Vector(
        (float(point["x"]), float(point["y"]), float(point["z"]), 1.0)
    )
    canonical = GLTF_TO_BLENDER.inverted() @ (
        canonical_transform_matrix(placement, pivot) @ blender_point
    )
    return Vector((canonical.x, canonical.y, canonical.z))


def metadata_normal(
    normal: dict[str, Any], placement: dict[str, Any]
) -> Vector:
    """Apply the inverse-transpose of the exact part transform to a GLTF normal."""
    gltf_normal = Vector(
        (float(normal["x"]), float(normal["y"]), float(normal["z"]))
    )
    blender_normal = GLTF_TO_BLENDER.to_3x3() @ gltf_normal
    transformed = (
        canonical_transform_matrix(
            placement, {"x": 0.0, "y": 0.0, "z": 0.0}
        )
        .to_3x3()
        .inverted()
        .transposed()
        @ blender_normal
    )
    canonical = GLTF_TO_BLENDER.inverted().to_3x3() @ transformed
    if canonical.length <= 1e-8:
        fail("Asset support normal transform is degenerate")
    return canonical.normalized()


def mesh_bounds_corners(mesh: dict[str, Any]) -> list[dict[str, float]]:
    low = mesh["bounds"]["minimum"]
    high = mesh["bounds"]["maximum"]
    return [
        {"x": x, "y": y, "z": z}
        for x in (low[0], high[0])
        for y in (low[1], high[1])
        for z in (low[2], high[2])
    ]


def derived_support(
    invocation: dict[str, Any], part: dict[str, Any], collision_mesh: dict[str, Any]
) -> dict[str, Any]:
    requirement = invocation["surfacePlacement"]
    if requirement["kind"] == "none":
        return {"kind": "none", "reason": "Asset requirement declares no surface contact"}
    patches = collision_mesh["assetContactPatches"]
    if not patches:
        return {
            "kind": "none",
            "reason": "Part has no contact topology in the required direction",
        }
    return {
        "kind": "surface_contact",
        "coordinateSpace": "asset_local",
        "mode": requirement["mode"],
        "contactPatches": patches,
    }


def resolved_collision(
    part: dict[str, Any],
    own_mesh: dict[str, Any],
    mesh_by_binding: dict[tuple[str, str], dict[str, Any]],
    source_parts: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    collision = part["collisionHint"]
    if collision["kind"] == "none":
        collision_kind = "mesh"
        collision_mesh = own_mesh
    else:
        collision_kind = collision["kind"]
        source_id = collision["meshId"]
        if source_id == part["sourceId"]:
            collision_mesh = own_mesh
        else:
            candidates = sorted(
                (
                    mesh_by_binding[(candidate["sourceId"], candidate["materialRoleId"])]
                    for candidate in source_parts.get(source_id, [])
                ),
                key=lambda candidate: candidate["id"],
            )
            if not candidates:
                fail(f"Collision source has no adapted semantic part: {part['id']}/{source_id}")
            collision_mesh = candidates[0]
    mesh_id = collision_mesh["id"]
    patches = collision_mesh["collisionSupportPatches"]
    if not patches:
        fail(f"Collision mesh has no upward support topology: {part['id']}/{mesh_id}")
    return {"kind": collision_kind, "meshId": mesh_id, "supportPatches": patches}


def source_part_metadata(
    invocation: dict[str, Any], meshes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    mesh_by_binding = {
        (mesh["sourceId"], mesh["materialRoleId"]): mesh for mesh in meshes
    }
    source_parts: dict[str, list[dict[str, Any]]] = {}
    for part in invocation["parts"]:
        source_parts.setdefault(part["sourceId"], []).append(part)
    rows = []
    for part in invocation["parts"]:
        mesh = mesh_by_binding[(part["sourceId"], part["materialRoleId"])]
        collision = resolved_collision(part, mesh, mesh_by_binding, source_parts)
        collision_mesh = next(
            candidate for candidate in meshes if candidate["id"] == collision["meshId"]
        )
        rows.append(
            {
                "id": part["id"],
                "meshId": mesh["id"],
                "placements": part["placements"],
                "pivot": part["pivotHint"],
                "sockets": part["socketHints"],
                "support": derived_support(invocation, part, collision_mesh),
                "collision": collision,
            }
        )
    patch_count = sum(
        len(row["collision"]["supportPatches"])
        for row in rows
        if row["collision"]["kind"] != "none"
    )
    if patch_count > MAX_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE:
        fail("Adapted collision support patches exceed the candidate budget")
    contact_patch_count = sum(
        len(row["support"]["contactPatches"])
        for row in rows
        if row["support"]["kind"] == "surface_contact"
    )
    if contact_patch_count > MAX_ASSET_CONTACT_PATCHES_PER_CANDIDATE:
        fail("Adapted contact patches exceed the candidate budget")
    return rows


def clean_float(value: float) -> float:
    return 0.0 if abs(value) < 1e-12 else float(value)


def canonical_root_support_origin(
    parts: list[dict[str, Any]],
    meshes: list[dict[str, Any]],
    surface_placement: dict[str, Any],
) -> dict[str, float]:
    mesh_by_id = {mesh["id"]: mesh for mesh in meshes}
    support_groups: list[dict[str, Any]] = []
    geometry_points: list[Vector] = []
    for part in parts:
        mesh = mesh_by_id[part["meshId"]]
        for placement in part["placements"]:
            geometry_points.extend(
                metadata_point(point, part["pivot"], placement)
                for point in mesh_bounds_corners(mesh)
            )
            support = part["support"]
            if support["kind"] == "surface_contact":
                for patch in support["contactPatches"]:
                    support_groups.append(
                        {
                            "points": [
                                metadata_point(point, part["pivot"], placement)
                                for point in patch["polygon"]
                            ],
                            "outwardNormal": metadata_normal(
                                patch["outwardNormal"], placement
                            ),
                        }
                    )
    if not geometry_points:
        fail("Adapted asset has no placed geometry")
    if surface_placement["kind"] == "none":
        minimum_y = min(point.y for point in geometry_points)
        points = [point for point in geometry_points if point.y <= minimum_y + 1e-5]
        return {
            "x": clean_float(
                (min(point.x for point in points) + max(point.x for point in points)) / 2
            ),
            "y": clean_float(minimum_y),
            "z": clean_float(
                (min(point.z for point in points) + max(point.z for point in points)) / 2
            ),
        }
    normal = surface_placement["outwardNormal"]
    direction = Vector((float(normal["x"]), float(normal["y"]), float(normal["z"])))
    aligned = [
        group
        for group in support_groups
        if group["outwardNormal"].dot(direction) > 1e-5
    ]
    if not aligned:
        fail("Adapted asset has no contact patch facing the required root direction")
    projections = [
        point.dot(direction) for group in aligned for point in group["points"]
    ]
    extreme = max(projections)
    tolerance = max(1e-6, (max(projections) - min(projections)) * 1e-6)
    points = [
        point
        for group in aligned
        if all(point.dot(direction) >= extreme - tolerance for point in group["points"])
        for point in group["points"]
    ]
    if not points:
        fail("Adapted asset contact topology has no common extreme plane")
    center = Vector(
        (
            (min(point.x for point in points) + max(point.x for point in points)) / 2,
            (min(point.y for point in points) + max(point.y for point in points)) / 2,
            (min(point.z for point in points) + max(point.z for point in points)) / 2,
        )
    )
    center += direction * (extreme - center.dot(direction))
    return {axis: clean_float(center[index]) for index, axis in enumerate(("x", "y", "z"))}


def placed_asset_bounds(
    parts: list[dict[str, Any]], meshes: list[dict[str, Any]]
) -> tuple[list[float], list[float]]:
    mesh_by_id = {mesh["id"]: mesh for mesh in meshes}
    points = [
        metadata_point(point, part["pivot"], placement)
        for part in parts
        for placement in part["placements"]
        for point in mesh_bounds_corners(mesh_by_id[part["meshId"]])
    ]
    if not points:
        fail("Adapted candidate has no measurable placed geometry")
    return (
        [min(point[index] for point in points) for index in range(3)],
        [max(point[index] for point in points) for index in range(3)],
    )


def derive_uniform_studs_per_unit(
    parts: list[dict[str, Any]],
    meshes: list[dict[str, Any]],
    expected: dict[str, Any],
) -> float:
    low, high = placed_asset_bounds(parts, meshes)
    measured = [high[index] - low[index] for index in range(3)]
    wanted = [float(expected[axis]) for axis in ("x", "y", "z")]
    if any(not math.isfinite(value) or value <= 0 for value in measured + wanted):
        fail("Adapted aggregate bounds are degenerate")
    scale = min(wanted[index] / measured[index] for index in range(3))
    if scale <= 0 or scale > 10000:
        fail("Adapted bounds cannot derive a finite conservative uniform scale")
    # Keep the source proportions intact. PreparedAsset owns the per-axis
    # 0.67x-1.0x intent envelope after fixed-camera candidate assessment.
    return scale


def rebase_parts(
    parts: list[dict[str, Any]], origin: dict[str, float]
) -> list[dict[str, Any]]:
    result = []
    for part in parts:
        placements = []
        for placement in part["placements"]:
            placements.append(
                {
                    **placement,
                    "position": {
                        axis: clean_float(float(placement["position"][axis]) - origin[axis])
                        for axis in ("x", "y", "z")
                    },
                }
            )
        result.append({**part, "placements": placements})
    return result


def adapt(invocation_path: pathlib.Path, output: pathlib.Path) -> None:
    invocation = validate_invocation(canonical_json(invocation_path))
    if not output.is_absolute() or not output.is_dir() or output.is_symlink() or any(output.iterdir()):
        fail("Adaptation output must be an empty absolute directory")
    variants = material_variants(invocation)
    measured_meshes = [
        measure_source_geometry(invocation, variant, len(variants)) for variant in variants
    ]
    measured_parts = source_part_metadata(invocation, measured_meshes)
    studs_per_unit = derive_uniform_studs_per_unit(
        measured_parts,
        measured_meshes,
        invocation["delivery"]["expectedBounds"]["size"],
    )
    meshes = [
        process_source(
            invocation, variant, output, index, len(variants), studs_per_unit
        )
        for index, variant in enumerate(variants)
    ]
    if sum(mesh["triangles"] for mesh in meshes) > invocation["delivery"]["maximumUniqueTriangles"]:
        fail("Adapted source inventory exceeds the unique triangle budget")
    unrebased_parts = source_part_metadata(invocation, meshes)
    source_support_origin = canonical_root_support_origin(
        unrebased_parts, meshes, invocation["surfacePlacement"]
    )
    parts = rebase_parts(unrebased_parts, source_support_origin)
    output_support_origin = canonical_root_support_origin(
        parts, meshes, invocation["surfacePlacement"]
    )
    if any(abs(output_support_origin[axis]) > 1e-5 for axis in ("x", "y", "z")):
        fail("Canonical support-origin rebase was not applied exactly once")
    previews = render_previews(parts, output, meshes)
    write_json(
        output / "report.json",
        {
            "kind": "FixedBlenderAssetAdaptationReport",
            "abi": REPORT_ABI,
            "workerId": WORKER_ID,
            "workerRevision": WORKER_REVISION,
            "blenderVersion": bpy.app.version_string,
            "sourceCandidateHash": invocation["sourceCandidateHash"],
            "intentHash": invocation["intentHash"],
            "repair": invocation.get("repair"),
            "styleContractId": invocation["styleContract"]["id"],
            "styleContractHash": invocation["styleContract"]["hash"],
            "requiredTextureChannels": invocation["requiredTextureChannels"],
            "policies": {
                "coordinateFrame": "gltf-y-up-asset-units",
                "canonicalAxes": {"handedness": "right_handed", "up": "+Y", "forward": "-Z"},
                "transformOwnership": "canonical_identity_nodes",
                "rootOrigin": "single-support-origin-rebase-in-part-placements",
                "geometry": "finite-weld-degenerate-clean-triangulate-outward-normal-decimate",
                "uv": "measured-final-uv0-repair-or-asset-local-projection",
                "materials": "declared-per-role-typed-procedural-pbr-final-glb-metric-texture-contract",
                "collisionSupport": "bounded-physical-proxy-upward-surfaces",
                "assetContact": "bounded-physical-proxy-contact-surfaces",
                "preview": "fixed-three-view-admission-rig",
            },
            "meshes": meshes,
            "canonicalRoot": {
                "kind": "support_origin",
                "sourceSupportOrigin": source_support_origin,
                "outputSupportOrigin": {"x": 0, "y": 0, "z": 0},
                "application": "subtract_once_from_part_placement_positions",
            },
            "parts": parts,
            "previews": previews,
        },
    )


def main() -> None:
    if "--" not in sys.argv:
        fail("Adaptation worker requires arguments after --")
    arguments = sys.argv[sys.argv.index("--") + 1 :]
    if len(arguments) != 2:
        fail("Adaptation worker requires invocation and output paths")
    adapt(pathlib.Path(arguments[0]), pathlib.Path(arguments[1]))


if __name__ == "__main__":
    try:
        main()
    except AdaptationFailure as error:
        print(f"BASALT_ASSET_ADAPTATION_ERROR: {error}", file=sys.stderr)
        raise SystemExit(73) from error
