#!/usr/bin/env python3
"""Execute host-routed, qualified procedures over curated modular source packs.

The host starts Blender with factory settings and passes a sealed invocation plus
a host-issued source inventory. The invocation names one qualified procedure and
a deterministic variation seed. It cannot name files, Blender data, operators,
scripts, providers, recipes, or scene scale.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import random
import re
import sys
from typing import Any, Callable

import bpy
from mathutils import Vector


WORKER_ID = "basalt-trusted-asset-procedure-worker"
WORKER_REVISION = "2026-09-09.4"
MAX_PART_TRIANGLES = 18_000
MAX_IMAGE_EDGE = 1024

MEDIEVAL = "quaternius_medieval_village_standard"
PROPS = "quaternius_fantasy_props_standard"
NATURE = "quaternius_stylized_nature_standard"

HOUSE_MODULES = (
    "Balcony_Cross_Straight.gltf", "Corner_ExteriorWide_Wood.gltf",
    "DoorFrame_Round_WoodDark.gltf", "Door_4_Round.gltf",
    "Floor_UnevenBrick.gltf", "Floor_WoodDark.gltf", "Prop_Chimney2.gltf",
    "Prop_Crate.gltf", "Prop_Support.gltf", "Prop_Vine1.gltf",
    "Prop_Vine2.gltf", "Prop_Vine4.gltf", "Roof_Dormer_RoundTile.gltf",
    "Roof_FrontSupports.gltf", "Roof_Front_Brick8.gltf",
    "Roof_RoundTiles_8x8.gltf", "Wall_Plaster_Window_Thin_Round.gltf",
    "Wall_Plaster_Window_Wide_Round.gltf", "Wall_Plaster_WoodGrid.gltf",
    "Wall_UnevenBrick_Door_Round.gltf", "Wall_UnevenBrick_Straight.gltf",
    "Wall_UnevenBrick_Window_Thin_Round.gltf",
    "Wall_UnevenBrick_Window_Wide_Round.gltf",
    "WindowShutters_Thin_Round_Open.gltf", "WindowShutters_Wide_Round_Open.gltf",
    "Window_Thin_Round1.gltf", "Window_Wide_Round1.gltf",
)
BRIDGE_MODULES = (
    "Balcony_Cross_Straight.gltf", "Floor_WoodDark.gltf",
    "Prop_Support.gltf", "Stairs_Exterior_Straight.gltf",
    "Wall_UnevenBrick_Straight.gltf",
)
TOWER_MODULES = (
    "Balcony_Cross_Straight.gltf", "Corner_ExteriorWide_Wood.gltf",
    "DoorFrame_Round_WoodDark.gltf", "Door_4_Round.gltf",
    "Floor_WoodDark.gltf", "Prop_Vine4.gltf",
    "Roof_Tower_RoundTiles.gltf", "Wall_Plaster_Window_Thin_Round.gltf",
    "Wall_Plaster_WoodGrid.gltf", "Wall_UnevenBrick_Door_Round.gltf",
    "Wall_UnevenBrick_Straight.gltf", "Wall_UnevenBrick_Window_Thin_Round.gltf",
    "Wall_UnevenBrick_Window_Wide_Round.gltf",
    "WindowShutters_Thin_Round_Open.gltf", "WindowShutters_Wide_Round_Open.gltf",
    "Window_Thin_Round1.gltf", "Window_Wide_Round1.gltf",
)
GATEHOUSE_MODULES = (
    "Corner_ExteriorWide_Wood.gltf", "Floor_WoodDark.gltf", "Prop_Vine1.gltf",
    "Roof_FrontSupports.gltf", "Roof_Front_Brick6.gltf", "Roof_RoundTiles_6x4.gltf",
    "Wall_Arch.gltf", "Wall_Plaster_Window_Thin_Round.gltf",
    "Wall_Plaster_Window_Wide_Round.gltf", "Wall_Plaster_WoodGrid.gltf",
    "Wall_UnevenBrick_Straight.gltf", "WindowShutters_Wide_Round_Open.gltf",
    "Window_Thin_Round1.gltf", "Window_Wide_Round1.gltf",
)
MARKET_MODULES = (
    "Bag.gltf", "Barrel_Apples.gltf", "Crate_Wooden.gltf",
    "FarmCrate_Apple.gltf", "FarmCrate_Carrot.gltf", "FarmCrate_Empty.gltf",
    "Stall_Cart_Empty.gltf",
)
MASONRY_PLATFORM_MODULES = (
    "Corner_ExteriorWide_Wood.gltf", "Floor_UnevenBrick.gltf",
    "Prop_Crate.gltf", "Prop_Support.gltf", "Prop_Vine1.gltf",
    "Stairs_Exterior_Straight.gltf", "Wall_UnevenBrick_Straight.gltf",
)
WOODLAND_MODULES = (
    "Bush_Common.gltf", "Bush_Common_Flowers.gltf", "CommonTree_1.gltf",
    "CommonTree_2.gltf", "CommonTree_4.gltf", "Fern_1.gltf", "Rock_Medium_2.gltf",
)
OUTCROP_MODULES = (
    "Bush_Common.gltf", "Bush_Common_Flowers.gltf", "Fern_1.gltf",
    "Grass_Common_Short.gltf", "Rock_Medium_1.gltf", "Rock_Medium_2.gltf",
    "Rock_Medium_3.gltf",
)

PROCEDURE_SPECS: dict[str, dict[str, Any]] = {
    "CuratedGatehouse": {"package": MEDIEVAL, "modules": GATEHOUSE_MODULES},
    "CuratedMarketStall": {"package": PROPS, "modules": MARKET_MODULES},
    "CuratedMasonryPlatform": {"package": MEDIEVAL, "modules": MASONRY_PLATFORM_MODULES},
    "CuratedMedievalHouse": {"package": MEDIEVAL, "modules": HOUSE_MODULES},
    "CuratedRockOutcrop": {"package": NATURE, "modules": OUTCROP_MODULES},
    "CuratedWatchtower": {"package": MEDIEVAL, "modules": TOWER_MODULES},
    "CuratedWoodenBridge": {"package": MEDIEVAL, "modules": BRIDGE_MODULES},
    "CuratedWoodlandCluster": {"package": NATURE, "modules": WOODLAND_MODULES},
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def canonical_json(path: pathlib.Path, maximum_bytes: int) -> Any:
    raw = path.read_bytes()
    if not raw or len(raw) > maximum_bytes or not raw.endswith(b"\n"):
        fail(f"Canonical JSON is missing, oversized, or incomplete: {path.name}")
    value = json.loads(raw)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if raw != (encoded + "\n").encode("utf-8"):
        fail(f"JSON is not canonical: {path.name}")
    return value


def write_json(path: pathlib.Path, value: Any) -> None:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(encoded + "\n")


def safe_relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        fail("Qualified source contains an invalid relative path")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail("Qualified source path escapes its package root")
    return path.as_posix()


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class QualifiedProcedureSources:
    def __init__(self, value: Any):
        if not isinstance(value, dict) or set(value) != {"kind", "packages"}:
            fail("Qualified source manifest has an unexpected shape")
        if value["kind"] != "QualifiedTrustedAssetSources" or not isinstance(value["packages"], list):
            fail("Qualified source manifest is invalid")
        self.packages: dict[str, tuple[pathlib.Path, dict[str, str]]] = {}
        self.verified: set[tuple[str, str]] = set()
        for item in value["packages"]:
            if not isinstance(item, dict) or set(item) != {"id", "rootPath", "files"}:
                fail("Qualified source package has an unexpected shape")
            package_id = item["id"]
            if package_id not in {MEDIEVAL, PROPS, NATURE}:
                fail("Qualified source package identity is not supported")
            root = pathlib.Path(item["rootPath"])
            if not root.is_absolute() or not root.is_dir():
                fail("Qualified source package root is not an absolute directory")
            files: dict[str, str] = {}
            if not isinstance(item["files"], list) or not item["files"]:
                fail("Qualified source package file inventory is empty")
            for entry in item["files"]:
                if not isinstance(entry, dict) or set(entry) != {"relativePath", "sha256"}:
                    fail("Qualified source file has an unexpected shape")
                relative = safe_relative(entry["relativePath"])
                digest = entry["sha256"]
                if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                    fail("Qualified source file hash is invalid")
                if relative in files:
                    fail("Qualified source file inventory contains a duplicate path")
                files[relative] = digest
            if package_id in self.packages:
                fail("Qualified source manifest contains a duplicate package")
            self.packages[package_id] = (root.resolve(), files)

    def path(self, package_id: str, relative_value: str) -> pathlib.Path:
        relative = safe_relative(relative_value)
        if package_id not in self.packages:
            fail(f"Required qualified package is absent: {package_id}")
        root, files = self.packages[package_id]
        if relative not in files:
            fail(f"Required source file is absent from the qualified inventory: {relative}")
        result = root.joinpath(*pathlib.PurePosixPath(relative).parts).resolve()
        try:
            result.relative_to(root)
        except ValueError:
            fail("Qualified source file resolved outside its package root")
        key = (package_id, relative)
        if key not in self.verified:
            if not result.is_file() or sha256(result) != files[relative]:
                fail(f"Qualified source file changed: {relative}")
            self.verified.add(key)
        return result

    def required_files(self, procedure_id: str) -> list[str]:
        spec = PROCEDURE_SPECS[procedure_id]
        package_id = spec["package"]
        required: set[str] = set()
        for module in spec["modules"]:
            path = self.path(package_id, module)
            required.add(module)
            if path.suffix.lower() != ".gltf":
                continue
            document = json.loads(path.read_text(encoding="utf-8"))
            for record in [*document.get("buffers", []), *document.get("images", [])]:
                uri = record.get("uri")
                if not isinstance(uri, str) or uri.startswith("data:"):
                    continue
                dependency = safe_relative(uri)
                self.path(package_id, dependency)
                required.add(dependency)
        return sorted(required)

    def records(self, package_id: str, paths: list[str]) -> list[dict[str, str]]:
        _, files = self.packages[package_id]
        return [
            {"packageId": package_id, "relativePath": path, "sha256": files[path]}
            for path in sorted(paths)
        ]


def read_request(path: pathlib.Path) -> dict[str, Any]:
    value = canonical_json(path, 64 * 1024)
    expected = {"kind", "assetId", "procedureId", "variationSeed"}
    if not isinstance(value, dict) or set(value) != expected:
        fail("Trusted procedure invocation has an unexpected shape")
    if value["kind"] != "TrustedAssetProcedureInvocation":
        fail("Trusted procedure invocation kind is invalid")
    if value["procedureId"] not in PROCEDURE_SPECS:
        fail("Trusted procedure identity is not qualified by this worker")
    if (not isinstance(value["variationSeed"], int) or isinstance(value["variationSeed"], bool)
            or value["variationSeed"] < 0 or value["variationSeed"] > 2_147_483_647):
        fail("Trusted procedure variation seed is invalid")
    if not isinstance(value["assetId"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", value["assetId"]):
        fail("Trusted procedure asset identity is invalid")
    return value


def fold_vertex_colors_to_materials(obj: bpy.types.Object, maximum_clusters: int = 10) -> None:
    """Bake unsupported COLOR_0 tint into a bounded set of standard PBR materials."""
    if not obj.data.color_attributes:
        return
    layer = obj.data.color_attributes.active_color or obj.data.color_attributes[0]
    if layer.domain != "CORNER":
        fail(f"Expected corner-domain source tint data: {obj.name}")
    source_slots = list(obj.material_slots)
    per_material: dict[int, list[tuple[float, ...]]] = {}
    polygon_colors: dict[int, tuple[float, ...]] = {}
    for polygon in obj.data.polygons:
        colors = [layer.data[index].color[:] for index in polygon.loop_indices]
        color = tuple(sum(item[channel] for item in colors) / len(colors) for channel in range(4))
        polygon_colors[polygon.index] = color
        per_material.setdefault(polygon.material_index, []).append(color)

    def clusters(colors: list[tuple[float, ...]]) -> list[tuple[float, ...]]:
        unique = sorted(set(tuple(round(value, 6) for value in color) for color in colors))
        if len(unique) <= maximum_clusters:
            return unique
        centers = [tuple(sum(color[i] for color in colors) / len(colors) for i in range(4))]
        while len(centers) < maximum_clusters:
            centers.append(max(unique, key=lambda color: min(
                sum((color[i] - center[i]) ** 2 for i in range(3)) for center in centers
            )))
        for _ in range(16):
            buckets: list[list[tuple[float, ...]]] = [[] for _ in centers]
            for color in colors:
                target = min(range(len(centers)), key=lambda j: sum(
                    (color[i] - centers[j][i]) ** 2 for i in range(3)
                ))
                buckets[target].append(color)
            updated = [
                old if not bucket else tuple(
                    sum(color[i] for color in bucket) / len(bucket) for i in range(4)
                )
                for old, bucket in zip(centers, buckets)
            ]
            movement = max(sum((updated[j][i] - centers[j][i]) ** 2 for i in range(3))
                           for j in range(len(centers)))
            centers = updated
            if movement < 1e-10:
                break
        return centers

    slot_maps: dict[int, tuple[list[tuple[float, ...]], list[int]]] = {}
    for source_index, colors in sorted(per_material.items()):
        base = source_slots[source_index].material
        if base is None:
            fail(f"Tinted polygon has no material: {obj.name}")
        palette = clusters(colors)
        variant_indices: list[int] = []
        for palette_index, color in enumerate(palette):
            variant = base.copy()
            variant.name = f"{Assembly.base_name(base.name)}__Tint{palette_index + 1:02d}"
            multiply = next((node for node in variant.node_tree.nodes
                             if node.bl_idname == "ShaderNodeMix"
                             and node.data_type == "RGBA" and node.blend_type == "MULTIPLY"), None)
            if multiply is None:
                fail(f"Tinted source material lacks its imported multiply node: {base.name}")
            socket = next((item for item in multiply.inputs if item.name == "B" and item.type == "RGBA"), None)
            if socket is None:
                fail(f"Tinted source material lacks a color input: {base.name}")
            for link in list(socket.links):
                variant.node_tree.links.remove(link)
            socket.default_value = tuple(max(0, min(1, value)) for value in color)
            obj.data.materials.append(variant)
            variant_indices.append(len(obj.data.materials) - 1)
        slot_maps[source_index] = (palette, variant_indices)
    for polygon in obj.data.polygons:
        palette, variant_indices = slot_maps[polygon.material_index]
        color = polygon_colors[polygon.index]
        target = min(range(len(palette)), key=lambda j: sum(
            (color[i] - palette[j][i]) ** 2 for i in range(3)
        ))
        polygon.material_index = variant_indices[target]
    for attribute in list(obj.data.color_attributes):
        obj.data.color_attributes.remove(attribute)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.material_slot_remove_unused()
    obj.select_set(False)


class Assembly:
    def __init__(self, asset_id: str, package_id: str,
                 sources: QualifiedProcedureSources, variation_seed: int):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.scene.name = "BasaltTrustedAssetProcedure"
        self.asset_id = asset_id
        self.package_id = package_id
        self.sources = sources
        self.variation_seed = variation_seed
        self.rng = random.Random(variation_seed)
        self.templates: dict[str, bpy.types.Object] = {}
        self.materials: dict[tuple[str, tuple[str, ...]], bpy.types.Material] = {}
        self.groups: dict[str, list[bpy.types.Object]] = {}

    @staticmethod
    def base_name(value: str) -> str:
        return re.sub(r"\.\d{3}$", "", value)

    @staticmethod
    def material_key(material: bpy.types.Material) -> tuple[str, tuple[str, ...]]:
        image_hashes: list[str] = []
        if material.use_nodes:
            for node in material.node_tree.nodes:
                image = getattr(node, "image", None)
                if image is None:
                    continue
                source = pathlib.Path(bpy.path.abspath(image.filepath, library=image.library))
                image_hashes.append(sha256(source) if source.is_file() else image.name)
        return Assembly.base_name(material.name), tuple(sorted(image_hashes))

    def template(self, module: str) -> bpy.types.Object:
        if module in self.templates:
            return self.templates[module]
        path = self.sources.path(self.package_id, module)
        before = set(bpy.data.objects)
        bpy.context.window.scene = self.scene
        bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=path.suffix.lower() == ".glb")
        imported = [obj for obj in bpy.data.objects if obj not in before and obj.type == "MESH"]
        if not imported:
            fail(f"Qualified module contains no mesh: {module}")
        for obj in imported:
            for slot in obj.material_slots:
                material = slot.material
                if material is None:
                    continue
                key = self.material_key(material)
                if key in self.materials:
                    slot.material = self.materials[key]
                else:
                    material.name = key[0]
                    self.materials[key] = material
        if len(imported) > 1:
            bpy.ops.object.select_all(action="DESELECT")
            for obj in imported:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = imported[0]
            bpy.ops.object.join()
        result = imported[0]
        result.name = "TEMPLATE__" + pathlib.Path(module).stem
        result.hide_render = True
        result.hide_viewport = True
        self.templates[module] = result
        return result

    def add(self, module: str, group: str, location=(0, 0, 0), rotation_z=0.0,
            scale=(1, 1, 1), label: str | None = None) -> bpy.types.Object:
        template = self.template(module)
        result = template.copy()
        result.data = template.data.copy()
        if self.package_id == PROPS and not result.data.color_attributes:
            color = result.data.color_attributes.new(
                name="Color", type="BYTE_COLOR", domain="CORNER"
            )
            for value in color.data:
                value.color = (1.0, 1.0, 1.0, 1.0)
        self.scene.collection.objects.link(result)
        result.hide_render = False
        result.hide_viewport = False
        result.location = location
        result.rotation_mode = "XYZ"
        result.rotation_euler = (0, 0, rotation_z)
        result.scale = scale
        items = self.groups.setdefault(group, [])
        result.name = label or f"{group}__{pathlib.Path(module).stem}__{len(items) + 1:03d}"
        items.append(result)
        return result

    def finish(self) -> list[bpy.types.Object]:
        parts: list[bpy.types.Object] = []
        for group, objects in self.groups.items():
            if not objects:
                fail(f"Trusted procedure semantic part is empty: {group}")
            bpy.ops.object.select_all(action="DESELECT")
            for obj in objects:
                obj.hide_viewport = False
                obj.hide_render = False
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
                obj.select_set(False)
            for obj in objects:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = objects[0]
            bpy.ops.object.join()
            part = objects[0]
            part.name = f"{self.asset_id}__{group}"
            part.data.name = part.name + "__mesh"
            part["semanticPart"] = group
            while len(part.data.uv_layers) > 1:
                part.data.uv_layers.remove(part.data.uv_layers[-1])
            if self.package_id == PROPS:
                fold_vertex_colors_to_materials(part)
            else:
                for attribute in list(part.data.color_attributes):
                    part.data.color_attributes.remove(attribute)
            part.data.calc_loop_triangles()
            if not part.data.loop_triangles:
                fail(f"Trusted procedure semantic part contains no triangles: {group}")
            if len(part.data.loop_triangles) > MAX_PART_TRIANGLES:
                fail(f"Trusted procedure semantic part exceeds {MAX_PART_TRIANGLES} triangles: {group}")
            parts.append(part)
        for template in self.templates.values():
            template.hide_render = True
            template.hide_viewport = True
        return parts


SIDES = {
    "front": ((0.0, -4.0, 0.0), 0.0), "right": ((4.0, 0.0, 0.0), math.radians(90)),
    "back": ((0.0, 4.0, 0.0), math.radians(180)), "left": ((-4.0, 0.0, 0.0), math.radians(-90)),
}


def facade_transform(side: str, offset: float, z: float):
    (base_x, base_y, _), angle = SIDES[side]
    return (base_x + math.cos(angle) * offset, base_y + math.sin(angle) * offset, z), angle


def facade_add(assembly: Assembly, module: str, group: str, side: str,
               offset: float, z: float, label: str | None = None):
    location, angle = facade_transform(side, offset, z)
    return assembly.add(module, group, location, angle, label=label)


def house_wall(assembly: Assembly, wall: str, side: str, offset: float, z: float,
               fill: str | None = None, shutters: str | None = None,
               frame: str | None = None) -> None:
    facade_add(assembly, wall, "shell", side, offset, z)
    if fill:
        if fill.startswith("Door_"):
            location, angle = facade_transform(side, offset, z)
            location = (location[0] + math.cos(angle) * -0.514,
                        location[1] + math.sin(angle) * -0.514, location[2])
            assembly.add(fill, "openings", location, angle)
        else:
            facade_add(assembly, fill, "openings", side, offset, z)
    if shutters:
        facade_add(assembly, shutters, "openings", side, offset, z)
    if frame:
        facade_add(assembly, frame, "openings", side, offset, z)


def build_house(assembly: Assembly) -> None:
    ground = {
        "front": [
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf", None),
            ("Wall_UnevenBrick_Door_Round.gltf", "Door_4_Round.gltf", None, "DoorFrame_Round_WoodDark.gltf"),
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
        ],
        "right": [
            ("Wall_UnevenBrick_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", "WindowShutters_Thin_Round_Open.gltf", None),
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", None, None),
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
        ],
        "back": [
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf", None),
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", None, None),
        ],
        "left": [
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf", None),
            ("Wall_UnevenBrick_Straight.gltf", None, None, None),
            ("Wall_UnevenBrick_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", None, None),
        ],
    }
    upper = {
        "front": [
            ("Wall_Plaster_WoodGrid.gltf", None, None),
            ("Wall_Plaster_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf"),
            ("Wall_Plaster_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf"),
            ("Wall_Plaster_WoodGrid.gltf", None, None),
        ],
        "right": [
            ("Wall_Plaster_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", "WindowShutters_Thin_Round_Open.gltf"),
            ("Wall_Plaster_WoodGrid.gltf", None, None),
            ("Wall_Plaster_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", None),
            ("Wall_Plaster_WoodGrid.gltf", None, None),
        ],
        "back": [
            ("Wall_Plaster_WoodGrid.gltf", None, None),
            ("Wall_Plaster_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf"),
            ("Wall_Plaster_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", "WindowShutters_Thin_Round_Open.gltf"),
            ("Wall_Plaster_WoodGrid.gltf", None, None),
        ],
        "left": [
            ("Wall_Plaster_WoodGrid.gltf", None, None),
            ("Wall_Plaster_Window_Wide_Round.gltf", "Window_Wide_Round1.gltf", None),
            ("Wall_Plaster_WoodGrid.gltf", None, None),
            ("Wall_Plaster_Window_Thin_Round.gltf", "Window_Thin_Round1.gltf", "WindowShutters_Thin_Round_Open.gltf"),
        ],
    }
    for side, modules in ground.items():
        for offset, spec in zip((-3, -1, 1, 3), modules):
            house_wall(assembly, spec[0], side, offset, 0, spec[1], spec[2], spec[3])
    for side, modules in upper.items():
        for offset, spec in zip((-3, -1, 1, 3), modules):
            house_wall(assembly, spec[0], side, offset, 3, spec[1], spec[2])
    for z in (0, 3):
        for x in (-4, 4):
            for y in (-4, 4):
                assembly.add("Corner_ExteriorWide_Wood.gltf", "shell", (x, y, z))
    for x in (-3, -1, 1, 3):
        for y in (-3, -1, 1, 3):
            assembly.add("Floor_UnevenBrick.gltf", "floors", (x, y, 0.01))
            assembly.add("Floor_WoodDark.gltf", "floors", (x, y, 3.01))
    for x in (-1, 1):
        assembly.add("Floor_WoodDark.gltf", "floors", (x, -5, 3.01))
    assembly.add("Roof_RoundTiles_8x8.gltf", "roof", (0, 0, 6.05), label="roof__main")
    facade_add(assembly, "Roof_Front_Brick8.gltf", "roof", "front", 0, 6.05)
    facade_add(assembly, "Roof_Front_Brick8.gltf", "roof", "back", 0, 6.05)
    facade_add(assembly, "Roof_FrontSupports.gltf", "details", "front", 0, 6.02)
    facade_add(assembly, "Roof_FrontSupports.gltf", "details", "back", 0, 6.02)
    detail_mirror = -1 if assembly.rng.randrange(2) else 1
    dormer_shift = assembly.rng.uniform(-0.28, 0.28)
    assembly.add(
        "Roof_Dormer_RoundTile.gltf", "roof",
        (detail_mirror * (2.75 + dormer_shift), -1.65, 6.7)
    )
    assembly.add(
        "Roof_Dormer_RoundTile.gltf", "roof",
        (-detail_mirror * (2.75 - dormer_shift), 1.55, 6.7), math.radians(180)
    )
    assembly.add(
        "Prop_Chimney2.gltf", "roof",
        (detail_mirror * (-1.65 - assembly.rng.uniform(0.0, 0.5)),
         assembly.rng.uniform(-0.45, 0.45), 7.75)
    )
    for x in (-1, 1):
        assembly.add("Balcony_Cross_Straight.gltf", "details", (x, -4, 3.02))
    assembly.add("Balcony_Cross_Straight.gltf", "details", (-3, -5, 3.02), math.radians(90))
    assembly.add("Balcony_Cross_Straight.gltf", "details", (3, -5, 3.02), math.radians(-90))
    for x in (-2, 0, 2):
        assembly.add("Prop_Support.gltf", "details", (x, -4.02, 0.04))
    facade_add(
        assembly, "Prop_Vine1.gltf", "details", "front",
        detail_mirror * (2.65 + assembly.rng.uniform(0.0, 0.5)), 5.45
    )
    facade_add(
        assembly, "Prop_Vine2.gltf", "details", "right",
        assembly.rng.uniform(-2.8, 2.8), 5.35
    )
    facade_add(
        assembly, "Prop_Vine4.gltf", "details", "back",
        assembly.rng.uniform(-3.0, 3.0), 3.0
    )
    crate_x = detail_mirror * (2.75 + assembly.rng.uniform(0.0, 0.35))
    assembly.add(
        "Prop_Crate.gltf", "details", (crate_x, -4.8, 0),
        math.radians(assembly.rng.uniform(-18, 18))
    )
    assembly.add(
        "Prop_Crate.gltf", "details", (crate_x - detail_mirror * 0.68, -4.62, 0),
        math.radians(assembly.rng.uniform(-18, 18)), (0.72, 0.72, 0.72)
    )


def build_market(assembly: Assembly) -> None:
    assembly.add("Stall_Cart_Empty.gltf", "structure")
    mirror = -1 if assembly.rng.randrange(2) else 1
    produce = ["FarmCrate_Apple.gltf", "FarmCrate_Carrot.gltf"]
    assembly.rng.shuffle(produce)

    def varied(base_x: float, base_y: float, base_z: float, spread: float = 0.08):
        return (
            mirror * (base_x + assembly.rng.uniform(-spread, spread)),
            base_y + assembly.rng.uniform(-spread, spread), base_z,
        )

    assembly.add(produce[0], "produce", varied(-0.55, -0.58, 0.72),
                 math.radians(assembly.rng.uniform(-8, 8)))
    assembly.add(produce[1], "produce", varied(0.22, -0.60, 0.67),
                 math.radians(assembly.rng.uniform(-8, 8)))
    assembly.add("FarmCrate_Empty.gltf", "clutter", varied(0.76, -0.72, 0.04),
                 math.radians(assembly.rng.uniform(-16, 16)))
    assembly.add("Barrel_Apples.gltf", "produce", varied(-1.55, -0.72, 0.02),
                 math.radians(assembly.rng.uniform(-14, 14)),
                 (assembly.rng.uniform(0.76, 0.88),) * 3)
    assembly.add("Crate_Wooden.gltf", "clutter", varied(1.12, 0.03, 0),
                 math.radians(assembly.rng.uniform(-18, 18)),
                 (assembly.rng.uniform(0.65, 0.78),) * 3)
    assembly.add("Bag.gltf", "clutter", varied(-1.02, -0.72, 0.02),
                 math.radians(assembly.rng.uniform(-24, 24)),
                 (assembly.rng.uniform(0.62, 0.74),) * 3)


def build_masonry_platform(assembly: Assembly) -> None:
    """Build one 16 by 8 unit dressed terrace without generated filler geometry."""
    for x in range(-7, 8, 2):
        for y in range(-3, 4, 2):
            assembly.add("Floor_UnevenBrick.gltf", "paving", (x, y, 3.02))

    for x in range(-7, 8, 2):
        if x not in (-1, 1):
            assembly.add("Wall_UnevenBrick_Straight.gltf", "retaining_walls", (x, -4, 0))
        assembly.add(
            "Wall_UnevenBrick_Straight.gltf", "retaining_walls", (x, 4, 0), math.pi
        )
    for y in range(-3, 4, 2):
        assembly.add(
            "Wall_UnevenBrick_Straight.gltf", "retaining_walls", (-8, y, 0), -math.pi / 2
        )
        assembly.add(
            "Wall_UnevenBrick_Straight.gltf", "retaining_walls", (8, y, 0), math.pi / 2
        )

    for x in (-8, 8):
        for y in (-4, 4):
            assembly.add("Corner_ExteriorWide_Wood.gltf", "edge_details", (x, y, 0))
    for x in (-2, 2):
        assembly.add("Corner_ExteriorWide_Wood.gltf", "edge_details", (x, -4, 0))
    for x in (-6, -4, 4, 6):
        assembly.add("Prop_Support.gltf", "edge_details", (x, -4.04, 0))
    for y in (-2, 2):
        assembly.add(
            "Prop_Support.gltf", "edge_details", (8.04, y, 0), math.pi / 2
        )
    assembly.add("Prop_Vine1.gltf", "edge_details", (-5.5, -4.08, 2.52))
    assembly.add(
        "Prop_Vine1.gltf", "edge_details", (-8.08, 1.5, 2.52), -math.pi / 2
    )
    assembly.add("Prop_Crate.gltf", "edge_details", (5.7, 2.45, 3.04), math.radians(8))
    assembly.add(
        "Prop_Crate.gltf", "edge_details", (6.45, 2.35, 3.04), math.radians(-11),
        (0.72, 0.72, 0.72)
    )

    for y, z in ((-6.85, 0.0), (-5.45, 0.98), (-4.05, 1.96)):
        for x in (-1, 1):
            assembly.add("Stairs_Exterior_Straight.gltf", "access", (x, y, z))


def build_woodland(assembly: Assembly) -> None:
    tree_modules = ["CommonTree_1.gltf", "CommonTree_4.gltf", "CommonTree_2.gltf"]
    assembly.rng.shuffle(tree_modules)
    for module, location, base_scale in zip(
        tree_modules, ((-2.5, 0.3, 0), (2.45, 1.0, 0), (0.1, 3.15, 0)),
        (0.92, 0.76, 0.64)
    ):
        jittered = (location[0] + assembly.rng.uniform(-0.35, 0.35),
                    location[1] + assembly.rng.uniform(-0.35, 0.35), 0)
        scale = base_scale * assembly.rng.uniform(0.9, 1.1)
        assembly.add(module, "trees", jittered,
                     math.radians(assembly.rng.uniform(-35, 35)), (scale,) * 3)
    for module, location, rotation, scale in (
        ("Bush_Common_Flowers.gltf", (-3.8, -1.5, 0), 12, 0.9),
        ("Bush_Common.gltf", (-1.0, -2.5, 0), -22, 0.72),
        ("Bush_Common_Flowers.gltf", (2.2, -1.7, 0), 35, 0.88),
        ("Bush_Common.gltf", (3.8, 2.0, 0), -18, 0.7),
        ("Fern_1.gltf", (-2.2, -2.2, 0), 5, 0.6),
        ("Fern_1.gltf", (0.4, -2.5, 0), 35, 0.55),
        ("Fern_1.gltf", (3.0, -0.7, 0), -24, 0.52),
    ):
        jittered = (location[0] + assembly.rng.uniform(-0.3, 0.3),
                    location[1] + assembly.rng.uniform(-0.3, 0.3), 0)
        varied_scale = scale * assembly.rng.uniform(0.88, 1.12)
        assembly.add(module, "understory", jittered,
                     math.radians(rotation + assembly.rng.uniform(-18, 18)),
                     (varied_scale,) * 3)
    for location, rotation, scale in (
        ((-4.0, 0.4, 0), 8, 0.55),
        ((1.1, -2.1, 0), -12, 0.48),
        ((3.7, 0.0, 0), 31, 0.44),
    ):
        jittered = (location[0] + assembly.rng.uniform(-0.25, 0.25),
                    location[1] + assembly.rng.uniform(-0.25, 0.25), 0)
        assembly.add("Rock_Medium_2.gltf", "rocks", jittered,
                     math.radians(rotation + assembly.rng.uniform(-20, 20)),
                     (scale * assembly.rng.uniform(0.9, 1.1),) * 3)


def build_outcrop(assembly: Assembly) -> None:
    rock_rows = [
        ("Rock_Medium_1.gltf", (0, 0, 0), (0, 0, 8), (1.65,) * 3),
        ("Rock_Medium_3.gltf", (2.5, 0.2, 0), (0, 8, -25), (1.2,) * 3),
        ("Rock_Medium_2.gltf", (-2.5, 0.25, 0.05), (4, 0, 28), (1.28,) * 3),
        ("Rock_Medium_3.gltf", (0.9, 1.8, 0), (0, 0, 52), (0.9,) * 3),
        ("Rock_Medium_1.gltf", (-1.2, 1.65, 0), (0, 0, -38), (0.82,) * 3),
        ("Rock_Medium_2.gltf", (2.8, -1.3, 0), (0, 0, 5), (0.65,) * 3),
        ("Rock_Medium_1.gltf", (-2.8, -1.45, 0), (0, 0, -14), (0.58,) * 3),
    ]
    mirror = -1 if assembly.rng.randrange(2) else 1
    for module, location, rotation, scale in rock_rows:
        varied_location = (
            mirror * (location[0] + assembly.rng.uniform(-0.22, 0.22)),
            location[1] + assembly.rng.uniform(-0.22, 0.22), location[2],
        )
        factor = assembly.rng.uniform(0.92, 1.08)
        obj = assembly.add(module, "rocks", varied_location, 0,
                           tuple(value * factor for value in scale))
        obj.rotation_euler = tuple(math.radians(
            value + assembly.rng.uniform(-7, 7) if index < 2 else
            mirror * value + assembly.rng.uniform(-12, 12)
        ) for index, value in enumerate(rotation))
    for module, location, rotation, scale in (
        ("Bush_Common.gltf", (-3.2, 0.9, 0), 12, 0.7),
        ("Bush_Common_Flowers.gltf", (3.5, 0.75, 0), -26, 0.65),
        ("Bush_Common.gltf", (-0.8, -2.2, 0), 38, 0.54),
        ("Bush_Common.gltf", (1.3, -2.1, 0), -10, 0.5),
        ("Fern_1.gltf", (-2.2, -1.9, 0), -12, 0.43),
        ("Fern_1.gltf", (2.1, -1.8, 0), 31, 0.43),
        ("Fern_1.gltf", (3.4, -0.2, 0), 6, 0.43),
    ):
        varied_location = (
            mirror * (location[0] + assembly.rng.uniform(-0.28, 0.28)),
            location[1] + assembly.rng.uniform(-0.28, 0.28), location[2],
        )
        varied_scale = scale * assembly.rng.uniform(0.88, 1.12)
        assembly.add(module, "vegetation", varied_location,
                     math.radians(mirror * rotation + assembly.rng.uniform(-16, 16)),
                     (varied_scale,) * 3)


def build_bridge(assembly: Assembly) -> None:
    for y in (-3, -1, 1, 3):
        assembly.add("Floor_WoodDark.gltf", "deck", (0, y, 1.8))
        assembly.add("Balcony_Cross_Straight.gltf", "rails", (0, y, 1.83), -math.pi / 2)
        assembly.add("Balcony_Cross_Straight.gltf", "rails", (0, y, 1.83), math.pi / 2)
    assembly.add("Wall_UnevenBrick_Straight.gltf", "supports", (0, -4.25, 0.2), 0, (1, 1, 0.52))
    assembly.add("Wall_UnevenBrick_Straight.gltf", "supports", (0, 4.25, 0.2), math.pi, (1, 1, 0.52))
    assembly.add("Stairs_Exterior_Straight.gltf", "approaches", (0, -5.35, 0.8))
    assembly.add("Stairs_Exterior_Straight.gltf", "approaches", (0, 5.35, 0.8), math.pi)
    for x, rotation in ((-1.12, math.pi / 2), (1.12, -math.pi / 2)):
        for y in (-2.25, 1.75):
            assembly.add("Prop_Support.gltf", "supports", (x, y, -1.08), rotation, (0.85,) * 3)


def build_watchtower(assembly: Assembly) -> None:
    small_sides = {
        "front": ((0.0, -2.0), 0.0), "right": ((2.0, 0.0), math.pi / 2),
        "back": ((0.0, 2.0), math.pi), "left": ((-2.0, 0.0), -math.pi / 2),
    }

    def small_facade(module: str, group: str, side: str, offset: float, z: float) -> None:
        (base_x, base_y), angle = small_sides[side]
        assembly.add(module, group,
                     (base_x + math.cos(angle) * offset,
                      base_y + math.sin(angle) * offset, z), angle)

    def wall(module: str, side: str, offset: float, z: float,
             fill: str | None = None, shutters: str | None = None) -> None:
        small_facade(module, "shell", side, offset, z)
        if fill:
            small_facade(fill, "openings", side, offset, z)
        if shutters:
            small_facade(shutters, "openings", side, offset, z)

    for side in small_sides:
        for offset in (-1, 1):
            if side == "front" and offset == 1:
                wall("Wall_UnevenBrick_Door_Round.gltf", side, offset, 0, "Door_4_Round.gltf")
                small_facade("DoorFrame_Round_WoodDark.gltf", "openings", side, offset, 0)
            elif offset == -1:
                wall("Wall_UnevenBrick_Window_Thin_Round.gltf", side, offset, 0, "Window_Thin_Round1.gltf")
            else:
                wall("Wall_UnevenBrick_Straight.gltf", side, offset, 0)
            if offset == -1:
                wall("Wall_UnevenBrick_Window_Wide_Round.gltf", side, offset, 3,
                     "Window_Wide_Round1.gltf", "WindowShutters_Wide_Round_Open.gltf")
            else:
                wall("Wall_UnevenBrick_Straight.gltf", side, offset, 3)
            if offset == 1:
                wall("Wall_Plaster_Window_Thin_Round.gltf", side, offset, 6,
                     "Window_Thin_Round1.gltf", "WindowShutters_Thin_Round_Open.gltf")
            else:
                wall("Wall_Plaster_WoodGrid.gltf", side, offset, 6)
    for z in (0, 3, 6):
        for x in (-2, 2):
            for y in (-2, 2):
                assembly.add("Corner_ExteriorWide_Wood.gltf", "shell", (x, y, z))
    for x in (-1, 1):
        for y in (-1, 1):
            assembly.add("Floor_WoodDark.gltf", "floors", (x, y, 6.04))
    for side in small_sides:
        for offset in (-1, 1):
            small_facade("Balcony_Cross_Straight.gltf", "balcony", side, offset, 6.05)
    assembly.add("Roof_Tower_RoundTiles.gltf", "roof", (0, 0, 9.48))
    small_facade("Prop_Vine4.gltf", "details", "left", -0.7, 3.0)


def build_gatehouse(assembly: Assembly) -> None:
    for y, rotation in ((-2, 0), (2, math.pi)):
        for x, module in ((-2, "Wall_UnevenBrick_Straight.gltf"),
                          (0, "Wall_Arch.gltf"),
                          (2, "Wall_UnevenBrick_Straight.gltf")):
            assembly.add(module, "shell", (x, y, 0), rotation)
        for x, module in ((-2, "Wall_Plaster_Window_Wide_Round.gltf"),
                          (0, "Wall_Plaster_WoodGrid.gltf"),
                          (2, "Wall_Plaster_Window_Wide_Round.gltf")):
            assembly.add(module, "shell", (x, y, 3), rotation)
            if "Window" in module:
                assembly.add("Window_Wide_Round1.gltf", "openings", (x, y, 3), rotation)
                assembly.add("WindowShutters_Wide_Round_Open.gltf", "openings", (x, y, 3), rotation)
    for x, rotation in ((-3, -math.pi / 2), (3, math.pi / 2)):
        for y in (-1, 1):
            assembly.add("Wall_UnevenBrick_Straight.gltf", "shell", (x, y, 0), rotation)
            assembly.add("Wall_Plaster_Window_Thin_Round.gltf", "shell", (x, y, 3), rotation)
            assembly.add("Window_Thin_Round1.gltf", "openings", (x, y, 3), rotation)
    for z in (0, 3):
        for x in (-3, 3):
            for y in (-2, 2):
                assembly.add("Corner_ExteriorWide_Wood.gltf", "shell", (x, y, z))
    for x in (-2, 0, 2):
        for y in (-1, 1):
            assembly.add("Floor_WoodDark.gltf", "floors", (x, y, 3.02))
    assembly.add("Roof_RoundTiles_6x4.gltf", "roof", (0, 2.36, 6.72))
    assembly.add("Roof_Front_Brick6.gltf", "roof", (0, -2, 6.72))
    assembly.add("Roof_Front_Brick6.gltf", "roof", (0, 2, 6.72), math.pi)
    assembly.add("Roof_FrontSupports.gltf", "details", (0, -2, 6.68))
    assembly.add("Roof_FrontSupports.gltf", "details", (0, 2, 6.68), math.pi)
    assembly.add("Prop_Vine1.gltf", "details", (-2.7, -2.08, 3.1))


BUILDERS: dict[str, Callable[[Assembly], None]] = {
    "CuratedGatehouse": build_gatehouse,
    "CuratedMarketStall": build_market,
    "CuratedMasonryPlatform": build_masonry_platform,
    "CuratedMedievalHouse": build_house,
    "CuratedRockOutcrop": build_outcrop,
    "CuratedWatchtower": build_watchtower,
    "CuratedWoodenBridge": build_bridge,
    "CuratedWoodlandCluster": build_woodland,
}


def triangle_count(obj: bpy.types.Object) -> int:
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def bounds(objects: list[bpy.types.Object]):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def generated_texture(name: str, color: tuple[float, float, float, float],
                      non_color: bool) -> bpy.types.Image:
    image = bpy.data.images.new(name, width=4, height=4, alpha=True)
    image.generated_type = "BLANK"
    image.generated_color = color
    image.pixels = list(color) * 16
    image.file_format = "PNG"
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    image.pack()
    return image


def texture_node(material: bpy.types.Material, label: str,
                 image: bpy.types.Image):
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.name = label
    node.label = label
    node.image = image
    node.interpolation = "Linear"
    return node


def ensure_material_texture_contract(material: bpy.types.Material) -> None:
    """Retain source shading while completing the finisher's texture ABI."""
    material.use_nodes = True
    tree = material.node_tree
    principled = next(
        (node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None
    )
    if principled is None:
        fail(f"Trusted source material lacks a Principled BSDF: {material.name}")
    safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", material.name)

    base = principled.inputs.get("Base Color")
    if base is None:
        fail(f"Trusted source material lacks Base Color: {material.name}")
    if not base.is_linked:
        value = tuple(float(component) for component in base.default_value)
        image = generated_texture(
            f"Basalt_{safe_name}_BaseColor", (value[0], value[1], value[2], value[3]), False
        )
        node = texture_node(material, "BasaltContractBaseColor", image)
        tree.links.new(node.outputs["Color"], base)

    normal = principled.inputs.get("Normal")
    if normal is None:
        fail(f"Trusted source material lacks Normal: {material.name}")
    if not normal.is_linked:
        image = generated_texture(
            f"Basalt_{safe_name}_Normal", (0.5, 0.5, 1.0, 1.0), True
        )
        node = texture_node(material, "BasaltContractNormalTexture", image)
        normal_map = tree.nodes.new("ShaderNodeNormalMap")
        normal_map.name = "BasaltContractNormalMap"
        normal_map.inputs["Strength"].default_value = 1.0
        tree.links.new(node.outputs["Color"], normal_map.inputs["Color"])
        tree.links.new(normal_map.outputs["Normal"], normal)

    metallic = principled.inputs.get("Metallic")
    roughness = principled.inputs.get("Roughness")
    if metallic is None or roughness is None:
        fail(f"Trusted source material lacks metallic-roughness inputs: {material.name}")
    if not metallic.is_linked and not roughness.is_linked:
        value = max(0.0, min(1.0, float(roughness.default_value)))
        image = generated_texture(
            f"Basalt_{safe_name}_Roughness", (value, value, value, 1.0), True
        )
        node = texture_node(material, "BasaltContractRoughness", image)
        tree.links.new(node.outputs["Color"], roughness)


def normalize_resources(parts: list[bpy.types.Object]) -> None:
    used = {slot.material for part in parts for slot in part.material_slots if slot.material is not None}
    ordered_used = sorted(used, key=lambda material: material.name)
    for material in list(bpy.data.materials):
        if material not in used and material.users == 0:
            bpy.data.materials.remove(material)
    for material in ordered_used:
        ensure_material_texture_contract(material)
    canonical_images: dict[tuple[str, str], bpy.types.Image] = {}
    for material in ordered_used:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            image = getattr(node, "image", None)
            if image is None:
                continue
            source = pathlib.Path(bpy.path.abspath(image.filepath, library=image.library))
            digest = sha256(source) if source.is_file() else image.name
            key = (Assembly.base_name(image.name), digest)
            if key in canonical_images:
                node.image = canonical_images[key]
            else:
                image.name = key[0]
                canonical_images[key] = image
    for image in list(bpy.data.images):
        if image.users == 0:
            bpy.data.images.remove(image)
    for image in bpy.data.images:
        width, height = image.size[:]
        if width > 0 and height > 0 and max(width, height) > MAX_IMAGE_EDGE:
            factor = MAX_IMAGE_EDGE / max(width, height)
            image.scale(max(1, round(width * factor)), max(1, round(height * factor)))
            image.update()
        if image.source == "FILE":
            image.pack()


def export_glb(parts: list[bpy.types.Object], path: pathlib.Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_cameras=False, export_lights=False,
        export_animations=False, export_extras=True, export_materials="EXPORT",
        export_tangents=False,
    )


def part_rows(parts: list[bpy.types.Object]) -> list[dict[str, Any]]:
    rows = []
    for part in parts:
        low, high = bounds([part])
        rows.append({
            "bounds": {"maximum": list(high), "minimum": list(low)},
            "materials": sorted({slot.material.name for slot in part.material_slots if slot.material is not None}),
            "nodeName": part.name, "triangles": triangle_count(part),
        })
    return rows


def gltf_part_rows(parts: list[bpy.types.Object]) -> list[dict[str, Any]]:
    """Report bounds in the exported glTF Y-up frame: (x, z, -y)."""
    rows = part_rows(parts)
    for row in rows:
        low = row["bounds"]["minimum"]
        high = row["bounds"]["maximum"]
        row["bounds"] = {
            "minimum": [low[0], low[2], -high[1]],
            "maximum": [high[0], high[2], -low[1]],
        }
    return rows


def report_for(request: dict[str, Any], parts: list[bpy.types.Object],
               source_files: list[dict[str, str]]) -> dict[str, Any]:
    rows = gltf_part_rows(parts)
    return {
        "assetId": request["assetId"], "kind": "TrustedAssetProcedureWorkerReport",
        "coordinateFrame": "gltf-y-up-asset-units",
        "parts": rows, "procedureId": request["procedureId"],
        "sourceFiles": source_files,
        "totalTriangles": sum(row["triangles"] for row in rows),
        "variationSeed": request["variationSeed"],
        "workerId": WORKER_ID, "workerRevision": WORKER_REVISION,
    }


def assert_roundtrip(expected: list[dict[str, Any]], parts: list[bpy.types.Object]) -> None:
    actual = {row["nodeName"]: row for row in part_rows(parts)}
    wanted = {row["nodeName"]: row for row in expected}
    if set(actual) != set(wanted):
        fail("Trusted procedure GLB round trip changed semantic part identities")
    for name, before in wanted.items():
        after = actual[name]
        if after["triangles"] != before["triangles"]:
            fail(f"Trusted procedure GLB round trip changed triangle count: {name}")
        if after["materials"] != before["materials"]:
            fail(f"Trusted procedure GLB round trip changed material identities: {name}")
        for boundary in ("minimum", "maximum"):
            if any(abs(a - b) > 1e-4 for a, b in zip(
                after["bounds"][boundary], before["bounds"][boundary]
            )):
                fail(f"Trusted procedure GLB round trip changed bounds: {name}")


def probe(sources: QualifiedProcedureSources, output: pathlib.Path) -> None:
    procedures = []
    for procedure_id, spec in sorted(PROCEDURE_SPECS.items()):
        procedures.append({
            "packageId": spec["package"], "procedureId": procedure_id,
            "requiredFiles": sources.required_files(procedure_id),
        })
    write_json(output, {
        "blenderVersion": bpy.app.version_string, "kind": "TrustedAssetProcedureWorkerProbe",
        "procedures": procedures, "workerId": WORKER_ID, "workerRevision": WORKER_REVISION,
    })


def produce(request_path: pathlib.Path, sources_path: pathlib.Path, output: pathlib.Path) -> None:
    request = read_request(request_path)
    sources = QualifiedProcedureSources(canonical_json(sources_path, 4 * 1024 * 1024))
    if not output.is_absolute() or not output.is_dir() or any(output.iterdir()):
        fail("Trusted procedure output must be an empty absolute directory")
    spec = PROCEDURE_SPECS[request["procedureId"]]
    required = sources.required_files(request["procedureId"])
    assembly = Assembly(
        request["assetId"], spec["package"], sources, request["variationSeed"]
    )
    BUILDERS[request["procedureId"]](assembly)
    parts = assembly.finish()
    normalize_resources(parts)
    source_rows = part_rows(parts)
    report = report_for(request, parts, sources.records(spec["package"], required))
    asset_path = output / "asset.glb"
    export_glb(parts, asset_path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(asset_path), import_pack_images=True)
    roundtrip = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    assert_roundtrip(source_rows, roundtrip)
    write_json(output / "report.json", report)


def main() -> None:
    if "--" not in sys.argv:
        fail("Trusted procedure worker requires arguments after --")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) == 3 and args[0] == "--probe":
        sources = QualifiedProcedureSources(
            canonical_json(pathlib.Path(args[1]), 4 * 1024 * 1024)
        )
        probe(sources, pathlib.Path(args[2]))
        return
    if len(args) != 3:
        fail("Trusted procedure worker requires invocation, qualified sources, and output")
    produce(pathlib.Path(args[0]), pathlib.Path(args[1]), pathlib.Path(args[2]))


if __name__ == "__main__":
    main()
