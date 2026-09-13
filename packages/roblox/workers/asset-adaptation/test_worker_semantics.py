from __future__ import annotations

import importlib.util
import hashlib
import json
import pathlib
import struct
import tempfile

import bpy


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER_PATH = ROOT / "workers/asset-adaptation/worker.py"
SPEC = importlib.util.spec_from_file_location("basalt_asset_adaptation_worker", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load fixed asset adaptation worker")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def make_glb(path: pathlib.Path) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=2, location=(1, -3, 2))
    obj = bpy.context.object
    obj.name = "InputNode"
    material = bpy.data.materials.new("UnfinishedSource")
    material.use_nodes = True
    tree = material.node_tree
    principled = tree.nodes.get("Principled BSDF")
    base = worker.generated_image(
        "SourceBase", 8, 8, (0.7, 0.16, 0.05, 0.41), False, "source-base"
    )
    base_node = worker.image_texture(material, "SourceBaseTexture", base)
    tree.links.new(base_node.outputs["Color"], principled.inputs["Base Color"])
    tree.links.new(base_node.outputs["Alpha"], principled.inputs["Alpha"])
    orm = worker.generated_image(
        "SourceORM", 8, 8, (0.43, 0.23, 0.79, 1), True, "source-orm"
    )
    orm_node = worker.image_texture(material, "SourceORMTexture", orm)
    orm_separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(orm_node.outputs["Color"], orm_separate.inputs["Color"])
    tree.links.new(orm_separate.outputs["Green"], principled.inputs["Roughness"])
    tree.links.new(orm_separate.outputs["Blue"], principled.inputs["Metallic"])
    worker.gltf_occlusion_node(material, orm_node.outputs["Color"])
    material.surface_render_method = "DITHERED"
    normal = worker.generated_image("SourceNormal", 8, 8, (0.5, 0.5, 1, 1), True, "source-normal")
    normal_node = worker.image_texture(material, "SourceNormalTexture", normal)
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    emissive = worker.generated_image(
        "SourceEmissive", 8, 8, (0.07, 0.29, 0.83, 1), False, "source-emissive"
    )
    emissive_node = worker.image_texture(material, "SourceEmissiveTexture", emissive)
    emission = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
    tree.links.new(emissive_node.outputs["Color"], emission)
    obj.data.materials.append(material)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_materials="EXPORT",
    )
    raw = path.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20 : 20 + json_size])
    exported_material = document["materials"][0]
    assert "occlusionTexture" in exported_material, exported_material
    assert "emissiveTexture" in exported_material, exported_material
    assert exported_material.get("alphaMode") == "BLEND", exported_material


def make_safetensors(path: pathlib.Path) -> None:
    tensors = {
        "positions": ("F32", [4, 3], [(-1, 0, -1), (1, 0, -1), (0, 0, 1), (0, 2, 0)]),
        "triangle_indices": ("I32", [4, 3], [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)]),
        "base_color": ("F32", [4, 3], [(0.15, 0.4, 0.08)] * 4),
        "roughness": ("F32", [4, 1], [(0.82,)] * 4),
        "metallic": ("F32", [4, 1], [(0.04,)] * 4),
        "opacity": ("F32", [4, 1], [(1.0,)] * 4),
        "normals": ("F32", [4, 3], [(0, 1, 0)] * 4),
    }
    payload = bytearray()
    header = {}
    for name, (dtype, shape, rows) in tensors.items():
        start = len(payload)
        code = "f" if dtype == "F32" else "i"
        for row in rows:
            payload.extend(struct.pack("<" + code * len(row), *row))
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [start, len(payload)]}
    header_bytes = json.dumps(header, separators=(",", ":")).encode()
    path.write_bytes(struct.pack("<Q", len(header_bytes)) + header_bytes + payload)


def inspect_adapted_glb(
    path: pathlib.Path,
    expected_node: str,
    expected_texture_size: dict[str, int],
    expected_alpha_mode: str,
) -> None:
    raw = path.read_bytes()
    assert struct.unpack_from("<I", raw, 0)[0] == 0x46546C67
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20 : 20 + json_size])
    node = next(item for item in document["nodes"] if item.get("name") == expected_node)
    assert node.get("translation", [0, 0, 0]) == [0, 0, 0]
    assert node.get("rotation", [0, 0, 0, 1]) == [0, 0, 0, 1]
    assert node.get("scale", [1, 1, 1]) == [1, 1, 1]
    primitive = document["meshes"][node["mesh"]]["primitives"][0]
    assert {"POSITION", "NORMAL", "TANGENT", "TEXCOORD_0"} <= set(primitive["attributes"])
    material = document["materials"][primitive["material"]]
    assert "baseColorTexture" in material["pbrMetallicRoughness"]
    assert "metallicRoughnessTexture" in material["pbrMetallicRoughness"]
    assert "normalTexture" in material
    assert "occlusionTexture" in material
    assert "emissiveTexture" in material
    assert material.get("alphaMode", "OPAQUE") == expected_alpha_mode
    texture = document["textures"][material["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    image = document["images"][texture["source"]]
    view = document["bufferViews"][image["bufferView"]]
    binary_offset = 20 + json_size + 8
    png_offset = binary_offset + view.get("byteOffset", 0)
    png = raw[png_offset : png_offset + view["byteLength"]]
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack_from(">II", png, 16) == (
        expected_texture_size["width"],
        expected_texture_size["height"],
    )


def image_rgb_mean(image: bpy.types.Image) -> tuple[float, float, float]:
    width, height = (int(value) for value in image.size[:])
    pixels = worker.array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    return tuple(
        sum(float(pixels[pixel * 4 + channel]) for pixel in range(width * height))
        / (width * height)
        for channel in range(3)
    )


def adapted_channel_fingerprints(path: pathlib.Path, expected_node: str) -> dict[str, object]:
    worker.reset_scene()
    result = bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    assert "FINISHED" in result
    obj = next(item for item in bpy.context.scene.objects if item.name == expected_node)
    material = obj.material_slots[0].material
    tree, principled = worker.ensure_principled(material)
    emission = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
    base = worker.linked_image_channel(principled.inputs.get("Base Color"), False)
    roughness = worker.linked_image_channel(principled.inputs.get("Roughness"), True)
    metallic = worker.linked_image_channel(principled.inputs.get("Metallic"), True)
    opacity = worker.linked_image_channel(principled.inputs.get("Alpha"), True)
    emissive = worker.linked_image_channel(emission, False)
    occlusion = worker.material_occlusion_binding(tree)
    normal = worker.first_linked_image(principled.inputs.get("Normal"))
    assert all(value is not None for value in (base, roughness, metallic, opacity, emissive, occlusion, normal))
    return {
        "base": image_rgb_mean(base["image"]),
        "roughness": worker.image_channel_mean(roughness),
        "metallic": worker.image_channel_mean(metallic),
        "opacity": worker.image_channel_mean(opacity),
        "emissive": image_rgb_mean(emissive["image"]),
        "occlusion": worker.image_channel_mean(occlusion),
        "normal": image_rgb_mean(normal),
    }


def part(identifier: str, source_id: str, role_id: str) -> dict[str, object]:
    return {
        "id": identifier,
        "name": identifier,
        "semanticRole": "generic semantics fixture",
        "role": "render_static",
        "visualGeometry": "detailed_mesh",
        "materialRoleId": role_id,
        "sourceId": source_id,
        "placements": [
            {
                "position": {"x": 0, "y": 0, "z": 0},
                "rotation": {"xDegrees": 0, "yDegrees": 0, "zDegrees": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
            }
        ],
        "pivotHint": {"x": 0, "y": 0, "z": 0},
        "socketHints": [
            {
                "id": f"{identifier}Socket",
                "type": "attachment",
                "localTransform": {
                    "position": {"x": 0, "y": 1, "z": 0},
                    "rotation": {"xDegrees": 0, "yDegrees": 0, "zDegrees": 0},
                    "scale": {"x": 1, "y": 1, "z": 1},
                },
            }
        ],
        "collisionHint": {"kind": "none", "reason": "worker derives measured collision"},
    }


def material_graph(palette_entry_id: str, seed: int = 17) -> dict[str, object]:
    material = {
        "kind": "ProceduralMaterialGraph",
        "seed": seed,
        "texelDensity": {"authority": "style_contract", "targetScale": 1},
        "robloxLowering": {
            "target": "surface_appearance",
            "proceduralState": "bake_to_textures",
            "lossPolicy": "record_exact",
        },
        "nodes": [
            {
                "id": "AccentColor",
                "kind": "color_constant",
                "value": {"kind": "literal", "color": "#9b8068"},
            },
            {
                "id": "BaseColor",
                "kind": "color_constant",
                "value": {
                    "kind": "palette",
                    "paletteEntryId": palette_entry_id,
                    "channel": "base_color",
                },
            },
            {
                "id": "Coordinates",
                "kind": "surface_coordinates",
                "projection": {
                    "kind": "triplanar",
                    "scaleStuds": {"u": 1.5, "v": 1.5},
                    "blendExponent": 4,
                },
            },
            {
                "id": "EmissiveColor",
                "kind": "color_constant",
                "value": {"kind": "literal", "color": "#101820"},
            },
            {
                "id": "MetallicValue",
                "kind": "palette_property",
                "paletteEntryId": palette_entry_id,
                "property": "metallic",
            },
            {
                "id": "NoiseField",
                "kind": "noise",
                "coordinateNodeId": "Coordinates",
                "basis": "ridged_fbm",
                "cells": {"u": 3, "v": 3},
                "octaves": 3,
                "lacunarity": 2,
                "gain": 0.5,
                "seedOffset": 9,
                "domainWarp": {
                    "cells": {"u": 2, "v": 2},
                    "amplitude": 0.08,
                    "octaves": 2,
                },
            },
            {"id": "OcclusionValue", "kind": "scalar_constant", "value": 1},
            {"id": "OpacityValue", "kind": "scalar_constant", "value": 0.82},
            {
                "id": "RoughnessValue",
                "kind": "palette_property",
                "paletteEntryId": palette_entry_id,
                "property": "roughness",
            },
            {
                "id": "SurfaceColor",
                "kind": "color_mix",
                "baseNodeId": "BaseColor",
                "layerNodeId": "AccentColor",
                "factorNodeId": "SurfaceMask",
                "operation": "overlay",
            },
            {
                "id": "SurfaceMask",
                "kind": "scalar_math",
                "operation": "maximum",
                "leftNodeId": "NoiseField",
                "rightNodeId": "WearField",
            },
            {
                "id": "WearField",
                "kind": "context_field",
                "source": "edge_wear",
                "invert": False,
            },
        ],
        "outputs": {
            "baseColorNodeId": "SurfaceColor",
            "roughnessNodeId": "RoughnessValue",
            "metallicNodeId": "MetallicValue",
            "occlusionNodeId": "OcclusionValue",
            "opacityNodeId": "OpacityValue",
            "normal": {
                "kind": "height_gradient",
                "heightNodeId": "NoiseField",
                "amplitudeStuds": 0.06,
            },
            "emissiveNodeId": "EmissiveColor",
        },
    }
    encoded = json.dumps(
        material, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return {**material, "hash": hashlib.sha256(encoded).hexdigest()}


def role(
    identifier: str,
    material_class: str,
    material_adaptation: dict[str, object] | None = None,
    surface_normals: str = "smooth",
    normal_texture: dict[str, object] | None = None,
    opacity: dict[str, object] | None = None,
) -> dict[str, object]:
    suppressed = {"kind": "suppressed", "reason": "semantics fixture"}
    return {
        "id": identifier,
        "description": "generic production material",
        "materialClass": material_class,
        "materialAdaptation": material_adaptation
        or {
            "kind": "synthesize",
            "graph": material_graph(
                "MetalPalette" if material_class == "metal" else "MineralPalette"
            ),
        },
        "shading": {
            "surfaceNormals": surface_normals,
            "normalTexture": normal_texture
            or {"kind": "synthesize", "strength": 0.5},
        },
        "opacity": opacity or {"kind": "opaque"},
        "projection": {"mode": "mesh_uv", "scaleStuds": {"u": 1, "v": 1}},
        "variationBands": {"macro": suppressed, "meso": suppressed, "micro": suppressed},
        "edgeTreatment": suppressed,
        "contextualTreatment": {"contact": suppressed, "upward": suppressed, "exposure": suppressed},
    }


def uv_span(obj: bpy.types.Object) -> tuple[float, float]:
    values = [loop.uv for loop in obj.data.uv_layers.active.data]
    return (
        max(value.x for value in values) - min(value.x for value in values),
        max(value.y for value in values) - min(value.y for value in values),
    )


def uv_repair_fixture(style: dict[str, object], mutation: str) -> str:
    worker.reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    worker.smart_uv_atlas(obj)
    layer = obj.data.uv_layers.active.data
    if mutation == "collapsed":
        for loop in layer:
            loop.uv = (0.5, 0.5)
    elif mutation in ("tiny", "huge"):
        factor = 0.01 if mutation == "tiny" else 100.0
        for loop in layer:
            loop.uv *= factor
    elif mutation == "mirrored":
        polygon = obj.data.polygons[0]
        first, second = polygon.loop_indices[:2]
        retained = layer[first].uv.copy()
        layer[first].uv = layer[second].uv
        layer[second].uv = retained
    elif mutation != "valid":
        raise AssertionError("unknown UV fixture")
    return worker.ensure_uv(obj, role("UvSurface", "stone"), style, 256, 1.0)[0]


def dominant_axes(obj: bpy.types.Object) -> set[int]:
    obj.data.calc_loop_triangles()
    return {
        max(range(3), key=lambda axis: abs(triangle.normal[axis]))
        for triangle in obj.data.loop_triangles
    }


def joined_box_mesh(
    name: str,
    boxes: list[tuple[tuple[float, float, float], tuple[float, float, float]]],
) -> bpy.types.Object:
    objects = []
    for location, dimensions in boxes:
        bpy.ops.mesh.primitive_cube_add(size=1, location=location)
        obj = bpy.context.object
        obj.dimensions = dimensions
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        objects.append(obj)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def point_in_triangle_xz(point: tuple[float, float], polygon: list[dict[str, float]]) -> bool:
    def edge(first: dict[str, float], second: dict[str, float]) -> float:
        return (point[0] - first["x"]) * (second["z"] - first["z"]) - (
            point[1] - first["z"]
        ) * (second["x"] - first["x"])

    signs = [edge(polygon[index], polygon[(index + 1) % 3]) for index in range(3)]
    return all(value >= -1e-6 for value in signs) or all(
        value <= 1e-6 for value in signs
    )


def exercise_support_topology_semantics() -> None:
    downward_contact = {
        "kind": "surface_contact",
        "mode": "resting",
        "outwardNormal": {"x": 0, "y": -1, "z": 0},
        "requiredSurfaceKinds": ["floor"],
    }
    assert worker.derived_support(
        {"surfacePlacement": downward_contact},
        {"id": "ElevatedDecoration"},
        {"assetContactPatches": []},
    ) == {
        "kind": "none",
        "reason": "Part has no contact topology in the required direction",
    }
    worker.reset_scene()
    arch = joined_box_mesh(
        "ArchCollision",
        [
            ((-1.5, 0, 1), (0.5, 1, 2)),
            ((1.5, 0, 1), (0.5, 1, 2)),
            ((0, 0, 2.5), (3.5, 1, 1)),
        ],
    )
    all_arch_downward = worker.directional_topology_patches(
        arch, worker.Vector((0, -1, 0))
    )
    arch_contacts = worker.asset_contact_patches(arch, downward_contact)
    assert len(all_arch_downward) > len(arch_contacts)
    assert arch_contacts
    assert all(
        abs(point["y"]) < 1e-6
        for patch in arch_contacts
        for point in patch["polygon"]
    )
    assert all(
        abs(sample["x"]) > 1
        for patch in arch_contacts
        for sample in patch["contactSamples"]
    )

    worker.reset_scene()
    three_legs = joined_box_mesh(
        "ThreeLegCollision",
        [
            ((-2, 0, 0.5), (0.5, 0.5, 1)),
            ((0, 0, 0.5), (0.5, 0.5, 1)),
            ((2, 0, 0.5), (0.5, 0.5, 1)),
        ],
    )
    leg_samples = [
        sample
        for patch in worker.asset_contact_patches(three_legs, downward_contact)
        for sample in patch["contactSamples"]
    ]
    assert all(
        any(abs(sample["x"] - center) < 0.3 for sample in leg_samples)
        for center in (-2, 0, 2)
    )
    assert not any(0.3 < abs(sample["x"]) < 1.7 for sample in leg_samples)

    worker.reset_scene()
    ring = joined_box_mesh(
        "RingCollision",
        [
            ((-1.5, 0, 0.5), (1, 4, 1)),
            ((1.5, 0, 0.5), (1, 4, 1)),
            ((0, -1.5, 0.5), (2, 1, 1)),
            ((0, 1.5, 0.5), (2, 1, 1)),
        ],
    )
    ring_support = worker.collision_support_patches(ring)
    assert ring_support
    assert not any(point_in_triangle_xz((0, 0), patch["polygon"]) for patch in ring_support)
    assert not any(
        abs(sample["x"]) < 0.5 and abs(sample["z"]) < 0.5
        for patch in worker.asset_contact_patches(ring, downward_contact)
        for sample in patch["contactSamples"]
    )


def exercise_explicit_material_adaptation_policies() -> None:
    worker.reset_scene()
    palette = {
        "id": "ExactPalette",
        "name": "Exact palette",
        "color": "#336699",
        "metallic": 0.9,
        "roughness": 0.28,
    }
    style = {
        "palette": [palette],
        "texelDensity": {
            "minimumPixelsPerStud": 8,
            "targetPixelsPerStud": 16,
            "maximumPixelsPerStud": 32,
        },
    }
    preserve_role = {"materialAdaptation": {"kind": "preserve_source"}}
    harmonize_role = {
        "materialAdaptation": {
            "kind": "harmonize",
            "paletteEntryId": "ExactPalette",
            "strength": 0.5,
        }
    }
    synthesize_role = {
        "materialAdaptation": {
            "kind": "synthesize",
            "graph": material_graph("ExactPalette"),
        }
    }
    assert worker.declared_palette_entry(style, preserve_role) is None
    assert worker.declared_palette_entry(style, harmonize_role) == palette
    assert worker.declared_palette_entry(style, synthesize_role) is None
    assert worker.material_adaptation_strength(preserve_role) == 0
    assert worker.material_adaptation_strength(harmonize_role) == 0.5
    assert worker.material_adaptation_strength(synthesize_role) == 1

    try:
        worker.declared_palette_entry(
            style,
            {
                "materialAdaptation": {
                    "kind": "synthesize",
                    "paletteEntryId": "ExactPalette",
                }
            },
        )
    except worker.AdaptationFailure:
        pass
    else:
        raise AssertionError("Legacy one-color synthesis must fail closed")

    source_base = worker.generated_image(
        "PolicySourceBase", 4, 4, (0.2, 0.4, 0.6, 0.7), False, "policy-source-base"
    )
    zero_strength_base = worker.refinish_base_image(
        source_base,
        "ZeroStrengthBase",
        4,
        4,
        (0.2, 0.4, 0.6),
        0,
        "zero-strength-base",
        1,
        1,
        1,
    )
    assert all(
        abs(actual - expected) < 1e-6
        for actual, expected in zip(
            image_rgb_mean(zero_strength_base), image_rgb_mean(source_base), strict=True
        )
    )
    retained_alpha = worker.image_channel_mean({"image": zero_strength_base, "channel": 3})
    source_alpha = worker.image_channel_mean({"image": source_base, "channel": 3})
    assert abs(retained_alpha - source_alpha) < 1e-6, (retained_alpha, source_alpha)
    harmonized_base = worker.refinish_base_image(
        source_base,
        "HalfStrengthBase",
        4,
        4,
        (0.8, 0.2, 0.1),
        0.5,
        "half-strength-base",
        0,
        1,
        0,
    )
    source_rgb = image_rgb_mean(source_base)
    source_luminance = source_rgb[0] * 0.2126 + source_rgb[1] * 0.7152 + source_rgb[2] * 0.0722
    palette_value = 0.55 + source_luminance * 0.9
    harmonized_rgb = image_rgb_mean(harmonized_base)
    expected_harmonized_rgb = tuple(
        source * 0.5 + target * palette_value * 0.5
        for source, target in zip(source_rgb, (0.8, 0.2, 0.1), strict=True)
    )
    assert all(
        abs(actual - expected) <= 1 / 255 + 1e-5
        for actual, expected in zip(harmonized_rgb, expected_harmonized_rgb, strict=True)
    ), (harmonized_rgb, expected_harmonized_rgb, source_rgb, palette_value)

    occlusion = worker.generated_image(
        "IndependentOcclusion", 4, 4, (0.43, 0.11, 0.17, 1), True, "independent-occlusion"
    )
    roughness = worker.generated_image(
        "IndependentRoughness", 4, 4, (0.13, 0.23, 0.31, 1), True, "independent-roughness"
    )
    metallic = worker.generated_image(
        "IndependentMetallic", 4, 4, (0.19, 0.37, 0.79, 1), True, "independent-metallic"
    )
    retained = worker.refinish_orm_image(
        {"image": occlusion, "channel": 0},
        {"image": roughness, "channel": 1},
        {"image": metallic, "channel": 2},
        "RetainedPackedORM",
        4,
        4,
        0.5,
        0.5,
        0.28,
        0.9,
        0,
        "retained-pack",
        1,
        1,
        0,
    )
    retained_means = image_rgb_mean(retained)
    source_orm_means = (
        worker.image_channel_mean({"image": occlusion, "channel": 0}),
        worker.image_channel_mean({"image": roughness, "channel": 1}),
        worker.image_channel_mean({"image": metallic, "channel": 2}),
    )
    assert all(
        abs(actual - expected) <= 1 / 255 + 1e-5
        for actual, expected in zip(retained_means, source_orm_means, strict=True)
    )

    harmonized = worker.refinish_orm_image(
        {"image": occlusion, "channel": 0},
        {"image": roughness, "channel": 1},
        {"image": metallic, "channel": 2},
        "HarmonizedPackedORM",
        4,
        4,
        0.5,
        0.5,
        0.28,
        0.9,
        0.5,
        "harmonized-pack",
        0,
        1,
        0,
    )
    harmonized_means = image_rgb_mean(harmonized)
    assert abs(harmonized_means[0] - source_orm_means[0]) <= 1 / 255 + 1e-5
    assert (
        abs(harmonized_means[1] - (source_orm_means[1] * 0.5 + 0.28 * 0.5))
        <= 1 / 255 + 1e-5
    )
    assert (
        abs(harmonized_means[2] - (source_orm_means[2] * 0.5 + 0.9 * 0.5))
        <= 1 / 255 + 1e-5
    )


def exercise_procedural_material_graph(style: dict[str, object]) -> None:
    graph = material_graph("MineralPalette", 41)
    assert worker.validate_material_graph(style, graph) == graph

    excessive_density = json.loads(json.dumps(graph))
    excessive_density["texelDensity"]["targetScale"] = 4
    excessive_density_material = {
        key: value for key, value in excessive_density.items() if key != "hash"
    }
    excessive_density["hash"] = hashlib.sha256(
        json.dumps(
            excessive_density_material,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    try:
        worker.validate_material_graph(style, excessive_density)
    except worker.AdaptationFailure:
        pass
    else:
        raise AssertionError("Graph density outside the style interval must fail closed")

    def sample(
        u: float,
        v: float,
        position: tuple[float, float, float],
        wear: float = 0.3,
    ) -> dict[str, object]:
        value = worker.procedural_surface_sample(None, 0, u, v)
        value["positionStuds"] = position
        value["normal"] = (0.0, 1.0, 0.0)
        value["normal_y"] = 1.0
        value["normal_z"] = 0.5
        value["upward_facing"] = 0.0
        value["slope"] = 0.5
        value["edge_wear"] = wear
        return value

    first_surface = sample(0.173, 0.619, (0.2595, 0.0, 0.9285))
    first = worker.evaluate_material_graph(graph, style, first_surface)
    assert first == worker.evaluate_material_graph(graph, style, first_surface)
    periodic_surface = sample(1.173, 0.619, (1.7595, 0.0, 0.9285))
    assert first == worker.evaluate_material_graph(graph, style, periodic_surface)
    second_graph = material_graph("MineralPalette", 42)
    second = worker.evaluate_material_graph(second_graph, style, first_surface)
    assert first != second
    prose_changed = json.loads(json.dumps(style))
    prose_changed["materialLanguage"] = "Entirely different advisory prose."
    prose_changed["surfaceVariation"]["guidance"] = "Different advisory prose."
    prose_changed["wearPolicy"]["placement"] = "Different advisory prose."
    assert first == worker.evaluate_material_graph(graph, prose_changed, first_surface)

    context_graph = json.loads(json.dumps(graph))
    context_graph["outputs"]["roughnessNodeId"] = "WearField"
    context_material = {
        key: value for key, value in context_graph.items() if key != "hash"
    }
    context_graph["hash"] = hashlib.sha256(
        json.dumps(
            context_material,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    unworn = worker.evaluate_material_graph(
        context_graph, style, sample(0.173, 0.619, (0.2595, 0.0, 0.9285), 0.0)
    )
    worn = worker.evaluate_material_graph(
        context_graph, style, sample(0.173, 0.619, (0.2595, 0.0, 0.9285), 1.0)
    )
    assert unworn["roughness"] == 0
    assert worn["roughness"] == 1

    worker.reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=2)
    graph_object = bpy.context.object
    worker.smart_uv_atlas(graph_object)
    graph_atlas = worker.procedural_surface_context_atlas(graph_object, 16, 16, 1.0)
    assert max(graph_atlas["contact"]) > min(graph_atlas["contact"])
    assert max(graph_atlas["curvature"]) > 0
    graph_role = role(
        "GraphDensity",
        "stone",
        {"kind": "synthesize", "graph": graph},
    )
    full_density = worker.texture_profile(style, graph_role, 256, graph_object, 1.0)
    reduced_density_graph = json.loads(json.dumps(graph))
    reduced_density_graph["texelDensity"]["targetScale"] = 0.75
    reduced_density_material = {
        key: value for key, value in reduced_density_graph.items() if key != "hash"
    }
    reduced_density_graph["hash"] = hashlib.sha256(
        json.dumps(
            reduced_density_material,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    reduced_density_role = role(
        "ReducedGraphDensity",
        "stone",
        {"kind": "synthesize", "graph": reduced_density_graph},
    )
    reduced_density = worker.texture_profile(
        style, reduced_density_role, 256, graph_object, 1.0
    )
    assert reduced_density["width"] < full_density["width"]
    assert reduced_density["uPixelsPerStud"] >= style["texelDensity"][
        "minimumPixelsPerStud"
    ]
    images = worker.procedural_material_images(
        graph, style, "GraphExercise", 16, 16, graph_atlas, 16, 16
    )
    assert set(images) == {"base", "orm", "normal", "emissive"}
    base_mean = image_rgb_mean(images["base"])
    assert max(base_mean) - min(base_mean) > 0.01
    assert abs(
        worker.image_channel_mean({"image": images["base"], "channel": 3}) - 0.82
    ) <= 1 / 255 + 1e-5
    assert worker.material_graph_evaluation_cost(graph) <= 384
    assert worker.material_graph_palette_entry_ids(graph) == ["MineralPalette"]

    # Coordinate authority is data, not an evaluator convention: the same graph
    # can rotate and stretch a directional mask or switch to polar rings without
    # adding a material-specific worker branch.
    directed = json.loads(json.dumps(graph))
    directed["nodes"].extend(
        [
            {
                "id": "DirectionalCoordinates",
                "kind": "coordinate_transform",
                "inputNodeId": "Coordinates",
                "translation": {"u": 0, "v": 0},
                "rotationDegrees": 37,
                "scale": {"u": 3, "v": 0.7},
                "pivot": {"u": 0.5, "v": 0.5},
                "wrap": "repeat",
            },
            {
                "id": "DirectionalGradient",
                "kind": "coordinate_gradient",
                "coordinateNodeId": "DirectionalCoordinates",
                "axis": "u",
                "low": 0,
                "high": 1,
                "clamp": True,
                "invert": False,
            },
            {
                "id": "PolarCoordinates",
                "kind": "polar_coordinates",
                "inputNodeId": "Coordinates",
                "center": {"u": 0.5, "v": 0.5},
                "radialScale": 2,
                "angularOffset": 0.125,
            },
            {
                "id": "RingWave",
                "kind": "wave",
                "coordinateNodeId": "PolarCoordinates",
                "waveform": "sine",
                "cycles": {"u": 0, "v": 5},
                "phase": 0,
                "dutyCycle": 0.5,
                "softness": 0.15,
            },
        ]
    )
    directed["nodes"].sort(key=lambda node: node["id"])
    directed["outputs"]["roughnessNodeId"] = "DirectionalGradient"
    directed["outputs"]["normal"] = {
        "kind": "height_gradient",
        "heightNodeId": "RingWave",
        "amplitudeStuds": 0.05,
    }
    directed_material = {key: value for key, value in directed.items() if key != "hash"}
    directed["hash"] = hashlib.sha256(
        json.dumps(
            directed_material,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    assert worker.validate_material_graph(style, directed) == directed
    directed_sample = worker.evaluate_material_graph(
        directed, style, sample(0.18, 0.63, (0.27, 0.0, 0.945))
    )

    unrotated = json.loads(json.dumps(directed))
    next(
        node for node in unrotated["nodes"] if node["id"] == "DirectionalCoordinates"
    )["rotationDegrees"] = 0
    unrotated_material = {
        key: value for key, value in unrotated.items() if key != "hash"
    }
    unrotated["hash"] = hashlib.sha256(
        json.dumps(
            unrotated_material,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    unrotated_sample = worker.evaluate_material_graph(
        unrotated, style, sample(0.18, 0.63, (0.27, 0.0, 0.945))
    )
    assert abs(
        float(directed_sample["roughness"])
        - float(unrotated_sample["roughness"])
    ) > 0.05

    first_ring = worker.evaluate_material_graph(
        directed, style, sample(0.75, 0.5, (1.125, 0.0, 0.75))
    )
    quarter_turn_ring = worker.evaluate_material_graph(
        directed, style, sample(0.5, 0.75, (0.75, 0.0, 1.125))
    )
    assert (
        abs(
            float(first_ring["normal_height"])
            - float(quarter_turn_ring["normal_height"])
        )
        < 1e-9
    )


def exercise_tensor_zero_strength_preservation(
    invocation: dict[str, object], source: dict[str, object]
) -> None:
    worker.reset_scene()
    tensor_role = role(
        "TensorPreserve",
        "stone",
        {"kind": "harmonize", "paletteEntryId": "MineralPalette", "strength": 0},
        "preserve_source",
        {"kind": "omit"},
        {"kind": "blend", "source": {"kind": "source_texture_or_attribute"}},
    )
    tensor_invocation = json.loads(json.dumps(invocation))
    tensor_invocation["materialRoles"] = [tensor_role]
    tensor_invocation["requiredTextureChannels"] = [
        "base_color",
        "metallic_roughness",
        "occlusion",
        "opacity",
    ]
    imported, source_evidence = worker.import_tensor_source(source)
    obj = worker.evaluated_baked_mesh(imported, worker.IDENTITY)
    worker.clean_geometry(obj)
    worker.ensure_uv(obj, tensor_role, tensor_invocation["styleContract"], 256, 1.0)
    rows = worker.normalize_materials(
        obj,
        tensor_invocation,
        "TensorZeroStrength",
        tensor_role,
        source_evidence["tensorAttributes"],
        1,
        1.0,
        None,
    )
    assert len(rows) == 1
    material_report = rows[0]
    assert material_report["response"]["adaptationStrength"] == 0
    assert material_report["textureHandling"] == {
        "baseColor": "harmonized",
        "metallicRoughness": "harmonized",
        "normal": "omitted",
        "occlusion": "neutral_default",
        "opacity": "baked_sampled",
        "emissive": "not_required",
    }
    material = obj.material_slots[0].material
    tree, principled = worker.ensure_principled(material)
    base = worker.linked_image_channel(principled.inputs.get("Base Color"), False)
    roughness = worker.linked_image_channel(principled.inputs.get("Roughness"), True)
    metallic = worker.linked_image_channel(principled.inputs.get("Metallic"), True)
    opacity = worker.linked_image_channel(principled.inputs.get("Alpha"), True)
    occlusion = worker.material_occlusion_binding(tree)
    assert all(value is not None for value in (base, roughness, metallic, opacity, occlusion))
    # The fixed GLB delivery path packs PNG channels at eight-bit precision.
    tolerance = 1 / 255 + 1e-5
    assert all(
        abs(actual - expected) <= tolerance
        for actual, expected in zip(image_rgb_mean(base["image"]), (0.15, 0.4, 0.08), strict=True)
    )
    assert abs(worker.image_channel_mean(roughness) - 0.82) <= tolerance
    assert abs(worker.image_channel_mean(metallic) - 0.04) <= tolerance
    assert abs(worker.image_channel_mean(opacity) - 1.0) <= tolerance
    assert abs(worker.image_channel_mean(occlusion) - 1.0) <= tolerance


def exercise_projection_semantics(style: dict[str, object]) -> None:
    assert uv_repair_fixture(style, "valid") == "retained_verified"
    for mutation in ("collapsed", "tiny", "huge", "mirrored"):
        assert uv_repair_fixture(style, mutation) == "smart_atlas_repair"

    planar = role("PlanarSurface", "stone")
    planar["projection"] = {
        "mode": "asset_planar",
        "scaleStuds": {"u": 4, "v": 4},
        "frame": {
            "origin": "canonical_asset_origin",
            "uAxis": "+X",
            "vAxis": "+Z",
        },
    }
    worker.reset_scene()
    bpy.ops.mesh.primitive_plane_add(size=4)
    full = bpy.context.object
    assert worker.ensure_uv(full, planar, style, 256, 1.0)[0] == "asset_planar_metric"
    full_span = uv_span(full)
    assert all(abs(value - 1.0) < 1e-6 for value in full_span)
    worker.reset_scene()
    bpy.ops.mesh.primitive_plane_add(size=2)
    half_source = bpy.context.object
    worker.ensure_uv(half_source, planar, style, 256, 2.0)
    assert all(abs(left - right) < 1e-6 for left, right in zip(full_span, uv_span(half_source)))

    triplanar = role("TriplanarSurface", "stone")
    triplanar["projection"] = {
        "mode": "asset_triplanar",
        "scaleStuds": {"u": 2, "v": 2},
        "blendExponent": 4,
    }
    for primitive in ("cube", "sphere"):
        worker.reset_scene()
        if primitive == "cube":
            bpy.ops.mesh.primitive_cube_add(size=2)
        else:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1)
        obj = bpy.context.object
        assert dominant_axes(obj) == {0, 1, 2}
        assert worker.ensure_uv(obj, triplanar, style, 256, 1.0)[0] == "asset_triplanar_baked_atlas"
        profile = worker.texture_profile(style, triplanar, 256, obj, 1.0)
        first = worker.baked_triplanar_field(
            obj, int(profile["width"]), int(profile["height"]), triplanar, 1.0, "field"
        )
        assert max(first) - min(first) > 0.01
        if primitive == "sphere":
            changed = json.loads(json.dumps(triplanar))
            changed["projection"]["blendExponent"] = 12
            second = worker.baked_triplanar_field(
                obj, int(profile["width"]), int(profile["height"]), changed, 1.0, "field"
            )
            assert hashlib.sha256(first.tobytes()).digest() != hashlib.sha256(second.tobytes()).digest()

    worker.reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=1000)
    huge = bpy.context.object
    worker.smart_uv_atlas(huge)
    try:
        worker.texture_profile(style, role("BudgetSurface", "stone"), 2048, huge, 1.0)
    except worker.AdaptationFailure as error:
        assert "cannot be represented" in str(error)
    else:
        raise AssertionError("2K-infeasible metric density must fail closed")


def exercise_uv_reprojection_semantics() -> None:
    worker.reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    source_layer = obj.data.uv_layers.new(name="SourceUV")
    # A planar source mapping intentionally overlaps cube faces. It defines a
    # valid appearance but cannot be admitted as a unique destination atlas.
    for loop in obj.data.loops:
        point = obj.data.vertices[loop.vertex_index].co
        source_layer.data[loop.index].uv = (point.x * 0.25 + 0.5, point.y * 0.25 + 0.5)
    source_uvs = [tuple(float(value) for value in loop.uv) for loop in source_layer.data]
    size = 64
    pixels = worker.array("f")
    for y in range(size):
        for x in range(size):
            pixels.extend(((x + 0.5) / size, (y + 0.5) / size, 0.25, 1.0))
    source = worker.image_from_pixels("AsymmetricSource", size, size, pixels, False)
    worker.smart_uv_atlas(obj)
    baked = worker.reprojected_uv_image(
        obj,
        source,
        source_uvs,
        0,
        "AsymmetricReprojected",
        256,
        256,
        False,
    )
    baked_pixels = worker.array("f", [0.0]) * (256 * 256 * 4)
    baked.pixels.foreach_get(baked_pixels)
    obj.data.calc_loop_triangles()
    destination_layer = obj.data.uv_layers.active.data
    for triangle in obj.data.loop_triangles:
        source_center = tuple(
            sum(source_uvs[index][axis] for index in triangle.loops) / 3
            for axis in range(2)
        )
        destination_center = tuple(
            sum(float(destination_layer[index].uv[axis]) for index in triangle.loops) / 3
            for axis in range(2)
        )
        x = max(0, min(255, round(destination_center[0] * 255)))
        y = max(0, min(255, round(destination_center[1] * 255)))
        offset = (y * 256 + x) * 4
        actual = (baked_pixels[offset], baked_pixels[offset + 1])
        assert all(
            abs(left - right) <= 0.035
            for left, right in zip(actual, source_center, strict=True)
        ), (actual, source_center)


with tempfile.TemporaryDirectory(prefix="basalt-adaptation-semantics-") as directory:
    root = pathlib.Path(directory)
    output = root / "output"
    output.mkdir()
    glb = root / "source.glb"
    tensors = root / "source.safetensors"
    make_glb(glb)
    source_fingerprints = adapted_channel_fingerprints(glb, "InputNode")
    assert 0.3 < source_fingerprints["occlusion"] < 0.55, source_fingerprints
    assert 0.3 < source_fingerprints["opacity"] < 0.55, source_fingerprints
    make_safetensors(tensors)
    invocation = {
        "kind": "FixedAssetAdaptationInvocation",
        "sourceCandidateHash": "1" * 64,
        "intentHash": "2" * 64,
        "styleContract": {
            "id": "FixtureStyle",
            "shapeLanguage": "Clear masses with deliberate secondary articulation.",
            "silhouetteHierarchy": [
                {"level": "primary", "guidance": "Read the complete form."},
                {"level": "secondary", "guidance": "Separate functional parts."},
                {"level": "tertiary", "guidance": "Reserve detail for close views."},
            ],
            "detailScale": [
                {"level": "object mass", "guidance": "Object-scale masses."},
                {"level": "human part", "guidance": "Human-scale parts."},
                {"level": "surface accent", "guidance": "Surface-scale accents."},
            ],
            "edgeTreatment": "Measured bevels catch the key light.",
            "materialLanguage": "Controlled physical surface groups.",
            "texelDensity": {
                "minimumPixelsPerStud": 8,
                "targetPixelsPerStud": 16,
                "maximumPixelsPerStud": 32,
            },
            "surfaceVariation": {
                "scaleStuds": 2,
                "intensity": 0.3,
                "guidance": "Variation follows material structure.",
            },
            "wearPolicy": {
                "amount": 0.2,
                "placement": "Wear follows contact edges.",
                "exclusions": ["No uniform grime"],
            },
            "lightingIntent": "Directional light reveals form.",
            "antiGoals": ["flat gray output"],
            "palette": [
                {
                    "id": "MineralPalette",
                    "name": "Mineral",
                    "color": "#59636d",
                    "metallic": 0.02,
                    "roughness": 0.82,
                },
                {
                    "id": "MetalPalette",
                    "name": "Metal",
                    "color": "#74818b",
                    "metallic": 0.9,
                    "roughness": 0.28,
                },
            ],
            "hash": "3" * 64,
        },
        "requiredTextureChannels": [
            "base_color",
            "metallic_roughness",
            "normal",
            "occlusion",
            "opacity",
            "emissive",
        ],
        "delivery": {
            "scaleClass": "human_prop",
            "expectedBounds": {"center": {"x": 0, "y": 1, "z": 0}, "size": {"x": 8, "y": 3, "z": 6}},
            "maximumUniqueTriangles": 1000,
            "maximumRenderedTriangles": 2000,
            "maximumParts": 8,
            "maximumMaterials": 8,
            "maximumTextureEdge": 256,
        },
        "surfacePlacement": {
            "kind": "surface_contact",
            "mode": "attached",
            "outwardNormal": {"x": 0, "y": -1, "z": 0},
            "requiredSurfaceKinds": ["floor"],
        },
        "materialRoles": [
            role(
                "MetalSurface",
                "metal",
                {"kind": "preserve_source"},
                "preserve_source",
                {"kind": "preserve_source"},
                {
                    "kind": "blend",
                    "source": {"kind": "source_texture_or_attribute"},
                },
            ),
            role("StoneSurface", "stone"),
        ],
        "sources": [
            {
                "id": "GlbSource",
                "kind": "glb_node",
                "path": str(glb),
                "nodeName": "InputNode",
                "transformOwnership": {
                    "kind": "requires_bake",
                    "coordinateFrame": "fixture-source-frame",
                    "sourceToCanonicalMatrixColumnMajor": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1],
                },
            },
            {
                "id": "TensorSource",
                "kind": "mesh_attribute_bundle",
                "path": str(tensors),
                "tensorSchemaHash": worker.TENSOR_SCHEMA_HASH,
                "transformOwnership": {
                    "kind": "requires_bake",
                    "coordinateFrame": "fixture-tensor-frame",
                    "sourceToCanonicalMatrixColumnMajor": [
                        1, 0, 0, 0,
                        0, 1, 0, 0,
                        0, 0, 1, 0,
                        3, 4, 5, 1,
                    ],
                },
            },
        ],
        "parts": [
            part("GlbMetalPart", "GlbSource", "MetalSurface"),
            part("GlbStonePart", "GlbSource", "StoneSurface"),
            part("TensorPart", "TensorSource", "StoneSurface"),
        ],
    }
    invocation["parts"][0]["collisionHint"] = {
        "kind": "mesh",
        "meshId": "TensorSource",
    }
    invocation["parts"][1]["placements"] = [
        {
            "position": {"x": 3, "y": 2, "z": -1},
            "rotation": {"xDegrees": 15, "yDegrees": 25, "zDegrees": 5},
            "scale": {"x": 0.75, "y": 0.75, "z": 0.75},
        }
    ]
    invocation["parts"][1]["pivotHint"] = {"x": 1, "y": 2, "z": 3}
    invocation["parts"][2]["placements"] = [
        {
            "position": {"x": -2, "y": 1, "z": 2},
            "rotation": {"xDegrees": 0, "yDegrees": 35, "zDegrees": 0},
            "scale": {"x": 0.75, "y": 0.75, "z": 0.75},
        }
    ]
    invocation["parts"][2]["pivotHint"] = {"x": 3, "y": 5, "z": 5}
    invocation_path = root / "invocation.json"
    write_json(invocation_path, invocation)
    worker.adapt(invocation_path, output)
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["kind"] == "FixedBlenderAssetAdaptationReport"
    assert report["repair"] is None
    assert report["styleContractId"] == "FixtureStyle"
    stone_variant = worker.material_variant_id("GlbSource", "StoneSurface", 1)
    assert {mesh["id"] for mesh in report["meshes"]} == {
        "GlbSource",
        stone_variant,
        "TensorSource",
    }
    assert {
        (mesh["sourceId"], mesh["materialRoleId"])
        for mesh in report["meshes"]
    } == {
        ("GlbSource", "MetalSurface"),
        ("GlbSource", "StoneSurface"),
        ("TensorSource", "StoneSurface"),
    }
    tensor_mesh = next(mesh for mesh in report["meshes"] if mesh["sourceId"] == "TensorSource")
    assert tensor_mesh["bounds"] == {
        "minimum": [2.0, 4.0, 4.0],
        "maximum": [4.0, 6.0, 6.0],
    }
    glb_mesh = next(
        mesh
        for mesh in report["meshes"]
        if mesh["sourceId"] == "GlbSource" and mesh["materialRoleId"] == "MetalSurface"
    )
    # The exported node translation and declared source-to-canonical translation
    # are each baked once. Applying either twice changes these exact bounds.
    assert glb_mesh["bounds"] == {
        "minimum": [2.0, 1.0, 2.0],
        "maximum": [4.0, 3.0, 4.0],
    }
    assert report["canonicalRoot"]["application"] == "subtract_once_from_part_placement_positions"
    assert report["canonicalRoot"]["outputSupportOrigin"] == {"x": 0, "y": 0, "z": 0}
    assert any(
        abs(report["canonicalRoot"]["sourceSupportOrigin"][axis]) > 1e-6
        for axis in ("x", "y", "z")
    )
    by_source_part = {part_row["id"]: part_row for part_row in invocation["parts"]}
    for part_row in report["parts"]:
        source_part = by_source_part[part_row["id"]]
        assert part_row["pivot"] == source_part["pivotHint"]
        assert part_row["sockets"] == source_part["socketHints"]
        for source_placement, output_placement in zip(
            source_part["placements"], part_row["placements"], strict=True
        ):
            assert output_placement["rotation"] == source_placement["rotation"]
            assert output_placement["scale"] == source_placement["scale"]
            for axis in ("x", "y", "z"):
                assert abs(
                    output_placement["position"][axis]
                    - (
                        source_placement["position"][axis]
                        - report["canonicalRoot"]["sourceSupportOrigin"][axis]
                    )
                ) < 1e-6
    output_origin = worker.canonical_root_support_origin(
        report["parts"], report["meshes"], invocation["surfacePlacement"]
    )
    assert all(abs(output_origin[axis]) < 1e-6 for axis in ("x", "y", "z"))
    assert all(mesh["transform"]["bakedExactlyOnce"] for mesh in report["meshes"])
    assert all(mesh["uv"]["layers"] == 1 for mesh in report["meshes"])
    for mesh in report["meshes"]:
        role_policy = next(
            role_row
            for role_row in invocation["materialRoles"]
            if role_row["id"] == mesh["materialRoleId"]
        )
        inspect_adapted_glb(
            output / mesh["file"],
            mesh["id"],
            mesh["materials"][0]["generatedTextureSize"],
            role_policy["opacity"]["kind"].upper(),
        )
        assert all(
            material["materialRoleIds"] == [mesh["materialRoleId"]]
            for material in mesh["materials"]
        )
        assert mesh["normals"]["surfacePolicy"] == role_policy["shading"]["surfaceNormals"]
        for material in mesh["materials"]:
            assert 1 <= material["generatedTextureSize"]["width"] <= 256
            assert 1 <= material["generatedTextureSize"]["height"] <= 256
            strength = worker.material_adaptation_strength(role_policy)
            synthesized = role_policy["materialAdaptation"]["kind"] == "synthesize"
            assert material["styleResponse"] == {
                "surfaceVariationScaleStuds": 2,
                "appliedSurfaceVariationIntensity": 0 if synthesized else 0.3 * strength,
                "appliedWearAmount": 0 if synthesized else 0.2 * strength,
            }
            assert material["materialAdaptation"] == role_policy["materialAdaptation"]
            assert material["shading"] == role_policy["shading"]
            assert material["opacity"] == role_policy["opacity"]
            assert material["response"]["adaptationStrength"] == strength
            expected_palette = (
                role_policy["materialAdaptation"]["paletteEntryId"]
                if role_policy["materialAdaptation"]["kind"] == "harmonize"
                else None
            )
            assert material["harmonizationPaletteEntryId"] == expected_palette
            if role_policy["materialAdaptation"]["kind"] == "synthesize":
                recipe = role_policy["materialAdaptation"]["graph"]
                procedural_report = material["proceduralGraph"]
                assert procedural_report["hash"] == recipe["hash"]
                assert procedural_report["nodeCount"] == len(recipe["nodes"])
                assert procedural_report[
                    "evaluationCost"
                ] == worker.material_graph_evaluation_cost(recipe)
                assert procedural_report[
                    "paletteEntryIds"
                ] == worker.material_graph_palette_entry_ids(recipe)
                lowering = procedural_report["robloxLowering"]
                assert lowering["target"] == "surface_appearance"
                assert lowering["texelDensity"]["authority"] == "style_contract"
                assert lowering["texelDensity"]["targetScale"] == 1
                assert lowering["bakedContextFields"] == ["edge_wear"]
                assert lowering["textureChannels"] == [
                    "base_color_opacity",
                    "occlusion_roughness_metallic",
                    "tangent_space_normal",
                    "emissive",
                ]
                assert "procedural_state_baked_to_raster_textures" in lowering["losses"]
                assert "context_fields_frozen_to_adapted_mesh" in lowering["losses"]
                assert "triplanar_projection_baked_to_uv0" in lowering["losses"]
                assert "height_displacement_reduced_to_tangent_normal" in lowering["losses"]
                assert material["styleResponse"]["appliedSurfaceVariationIntensity"] == 0
                assert material["styleResponse"]["appliedWearAmount"] == 0
                assert material["variationStrength"] == 0
                assert material["textureHandling"]["baseColor"] == "synthesized"
                assert material["textureHandling"]["metallicRoughness"] == "synthesized"
                assert material["textureHandling"]["normal"] == "synthesized"
                assert material["textureHandling"]["occlusion"] == "synthesized"
                assert material["textureHandling"]["emissive"] == "synthesized"
            elif role_policy["materialAdaptation"]["kind"] == "harmonize":
                assert material["proceduralGraph"] is None
                assert material["textureHandling"]["baseColor"] == "harmonized"
                assert material["textureHandling"]["metallicRoughness"] == "harmonized"
                assert material["textureHandling"]["normal"] == "retained"
                assert material["textureHandling"]["occlusion"] == "retained"
                assert material["textureHandling"]["emissive"] == "retained"
            else:
                assert material["proceduralGraph"] is None
                assert material["textureHandling"]["baseColor"] == "retained"
                assert material["textureHandling"]["metallicRoughness"] == "retained"
                assert material["textureHandling"]["normal"] == "retained"
                assert material["textureHandling"]["occlusion"] == "retained"
                assert material["textureHandling"]["emissive"] == "retained"
            if role_policy["opacity"]["kind"] == "opaque":
                assert material["textureHandling"]["opacity"] == "opaque"
            elif role_policy["opacity"].get("source", {}).get("kind") == "constant":
                assert material["textureHandling"]["opacity"] == "declared_constant"
            elif mesh["sourceId"] == "TensorSource":
                assert material["textureHandling"]["opacity"] == "baked_sampled"
            else:
                assert material["textureHandling"]["opacity"] == "retained"
        assert mesh["uv"]["studsPerUnit"] > 0
        assert mesh["uv"]["overlapPolicy"] == "unique_nonoverlap"
        assert mesh["uv"]["materials"]
        for measurement in mesh["uv"]["materials"]:
            assert measurement["degenerateSurfaceFraction"] <= 1e-6
            assert measurement["mirroredSurfaceFraction"] <= 1e-6
            assert measurement["unitAtlasOverlapFraction"] <= 0.02
            assert 8 <= measurement["pixelsPerStud"]["p05"]
            assert measurement["pixelsPerStud"]["p95"] <= 32
            assert measurement["stretchRatio"]["p95"] <= 4
    part_meshes = {part_row["id"]: part_row["meshId"] for part_row in report["parts"]}
    assert part_meshes["GlbMetalPart"] == "GlbSource"
    assert part_meshes["GlbStonePart"] == stone_variant
    metal_part = next(part_row for part_row in report["parts"] if part_row["id"] == "GlbMetalPart")
    assert metal_part["collision"]["kind"] == "mesh"
    assert metal_part["collision"]["meshId"] == "TensorSource"
    assert metal_part["collision"]["supportPatches"]
    stone_part = next(part_row for part_row in report["parts"] if part_row["id"] == "GlbStonePart")
    assert stone_part["support"]["mode"] == "attached"
    assert all(part_row["support"]["kind"] == "surface_contact" for part_row in report["parts"])
    assert {part_row["collision"]["kind"] for part_row in report["parts"]} == {"mesh"}
    assert {preview["view"] for preview in report["previews"]} == {
        "hero_three_quarter",
        "opposite_three_quarter",
        "top",
    }
    assert all((output / preview["file"]).stat().st_size > 0 for preview in report["previews"])
    fingerprints = adapted_channel_fingerprints(output / glb_mesh["file"], glb_mesh["id"])
    for channel in ("base", "roughness", "metallic", "occlusion", "opacity", "emissive", "normal"):
        actual = fingerprints[channel]
        expected = source_fingerprints[channel]
        actual_values = actual if isinstance(actual, tuple) else (actual,)
        expected_values = expected if isinstance(expected, tuple) else (expected,)
        assert all(
            abs(left - right) <= 1e-4
            for left, right in zip(actual_values, expected_values, strict=True)
        ), (channel, actual, expected)

    repair_output = root / "repair-output"
    repair_output.mkdir()
    repair_invocation = json.loads(json.dumps(invocation))
    repair_invocation["repair"] = {
        "kind": "BasaltAssetRepairContext",
        "action": "refinish",
        "requestHash": "3" * 64,
        "qualificationHash": "4" * 64,
        "repairInvocationHash": "5" * 64,
        "issueFingerprint": "6" * 64,
        "documentHash": "7" * 64,
        "anchorHash": "8" * 64,
        "sceneHash": "9" * 64,
        "observationHashes": ["a" * 64],
        "currentCatalogAssetArtifactHash": "b" * 64,
        "currentSourceCandidateHash": "c" * 64,
        "currentSourceFingerprint": "d" * 64,
        "currentVisualFingerprint": "e" * 64,
    }
    repair_invocation_path = root / "repair-invocation.json"
    write_json(repair_invocation_path, repair_invocation)
    assert worker.material_finish_seed(
        repair_invocation, repair_invocation["materialRoles"][0]
    ) != worker.material_finish_seed(invocation, invocation["materialRoles"][0])
    worker.adapt(repair_invocation_path, repair_output)
    repair_report = json.loads(
        (repair_output / "report.json").read_text(encoding="utf-8")
    )
    assert repair_report["repair"] == repair_invocation["repair"]
    assert repair_report["canonicalRoot"] == report["canonicalRoot"]
    assert repair_report["parts"] == report["parts"]
    assert [mesh["bounds"] for mesh in repair_report["meshes"]] == [
        mesh["bounds"] for mesh in report["meshes"]
    ]
    assert [mesh["triangles"] for mesh in repair_report["meshes"]] == [
        mesh["triangles"] for mesh in report["meshes"]
    ]
    # A repair receipt cannot invent a new look. Explicit preserve and recipe
    # policies remain byte-stable until the authored material policy changes.
    assert [mesh["sha256"] for mesh in repair_report["meshes"]] == [
        mesh["sha256"] for mesh in report["meshes"]
    ]
    exercise_explicit_material_adaptation_policies()
    exercise_procedural_material_graph(invocation["styleContract"])
    exercise_support_topology_semantics()
    exercise_projection_semantics(invocation["styleContract"])
    exercise_uv_reprojection_semantics()
    tensor_source = next(source for source in invocation["sources"] if source["id"] == "TensorSource")
    exercise_tensor_zero_strength_preservation(invocation, tensor_source)

print("asset adaptation worker semantics: PASS")
