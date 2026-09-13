"""Deterministic Unity FBX to GLB materialization worker for trusted catalog packs."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
from pathlib import Path
from typing import Any

import bpy


def _arguments() -> argparse.Namespace:
    values = []
    if "--" in os.sys.argv:
        values = os.sys.argv[os.sys.argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    return parser.parse_args(values)


def _clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for value in list(collection):
            collection.remove(value)


def _finite_color(value: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, list) or len(value) != 4:
        return (1.0, 1.0, 1.0, 1.0)
    numbers = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in numbers):
        return (1.0, 1.0, 1.0, 1.0)
    return tuple(max(0.0, min(1.0, component)) for component in numbers)  # type: ignore[return-value]


def _image(path: str | None, color_space: str) -> bpy.types.Image | None:
    if not path:
        return None
    source = Path(path)
    if not source.is_file() or source.is_symlink():
        raise RuntimeError(f"Material texture is not a regular file: {source}")
    image = bpy.data.images.load(str(source), check_existing=True)
    image.colorspace_settings.name = color_space
    width, height = image.size
    if width > 4096 or height > 4096:
        scale = min(4096 / width, 4096 / height)
        image.scale(max(1, round(width * scale)), max(1, round(height * scale)))
    return image


def _texture_node(nodes: Any, image: bpy.types.Image, label: str) -> Any:
    node = nodes.new("ShaderNodeTexImage")
    node.image = image
    node.label = label
    node.name = label
    return node


def _material(specification: dict[str, Any], suffix: str) -> bpy.types.Material:
    material = bpy.data.materials.new(f"{specification.get('name', 'UnityMaterial')}__{suffix}")
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if principled is None:
        principled = nodes.new("ShaderNodeBsdfPrincipled")
    color = _finite_color(specification.get("baseColor"))
    material.diffuse_color = color
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Alpha"].default_value = color[3]
    principled.inputs["Metallic"].default_value = max(
        0.0, min(1.0, float(specification.get("metallic", 0.0)))
    )
    principled.inputs["Roughness"].default_value = max(
        0.0, min(1.0, float(specification.get("roughness", 0.5)))
    )
    textures = specification.get("textures", {})
    base_color = _image(textures.get("baseColor"), "sRGB")
    if base_color is not None:
        node = _texture_node(nodes, base_color, "Unity Base Color")
        links.new(node.outputs["Color"], principled.inputs["Base Color"])
        if specification.get("alphaMode") == "MASK":
            links.new(node.outputs["Alpha"], principled.inputs["Alpha"])
    normal = _image(textures.get("normal"), "Non-Color")
    if normal is not None:
        texture = _texture_node(nodes, normal, "Unity Normal")
        normal_map = nodes.new("ShaderNodeNormalMap")
        links.new(texture.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    metallic = _image(textures.get("metallicRoughness"), "Non-Color")
    if metallic is not None:
        texture = _texture_node(nodes, metallic, "Unity Metallic")
        links.new(texture.outputs["Color"], principled.inputs["Metallic"])
    emissive = _image(textures.get("emissive"), "sRGB")
    if emissive is not None:
        texture = _texture_node(nodes, emissive, "Unity Emissive")
        links.new(texture.outputs["Color"], principled.inputs["Emission Color"])
        principled.inputs["Emission Strength"].default_value = 1.0
    if specification.get("alphaMode") == "MASK":
        material.surface_render_method = "DITHERED"
        material.alpha_threshold = max(
            0.0, min(1.0, float(specification.get("alphaCutoff", 0.5)))
        )
    elif specification.get("alphaMode") == "BLEND":
        material.surface_render_method = "DITHERED"
    return material


def _apply_materials(specifications: list[dict[str, Any]]) -> None:
    if not specifications:
        return
    materials = [
        _material(specification, f"{index:03d}")
        for index, specification in enumerate(specifications)
    ]
    for value in sorted(bpy.context.scene.objects, key=lambda item: item.name):
        if value.type != "MESH":
            continue
        slots = value.data.materials
        if len(slots) == 0:
            slots.append(materials[0])
            continue
        for index in range(len(slots)):
            slots[index] = materials[min(index, len(materials) - 1)]


def _bake_scale() -> None:
    for value in sorted(bpy.context.scene.objects, key=lambda item: item.name):
        if value.type != "MESH":
            continue
        bpy.ops.object.select_all(action="DESELECT")
        value.select_set(True)
        bpy.context.view_layer.objects.active = value
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def _convert(item: dict[str, Any]) -> None:
    _clear_scene()
    source = Path(item["sourcePath"])
    destination = Path(item["outputPath"])
    if not source.is_file() or source.is_symlink():
        raise RuntimeError(f"FBX source is not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    operation_output = io.StringIO()
    unity_global_scale = float(item["unityGlobalScale"])
    if not math.isfinite(unity_global_scale) or not 0 < unity_global_scale <= 10_000:
        raise RuntimeError(f"Invalid Unity global scale: {unity_global_scale}")
    with contextlib.redirect_stdout(operation_output), contextlib.redirect_stderr(operation_output):
        result = bpy.ops.import_scene.fbx(
            filepath=str(source),
            global_scale=unity_global_scale,
            use_anim=False,
            ignore_leaf_bones=True,
        )
    if "FINISHED" not in result:
        raise RuntimeError(f"FBX import did not finish: {source}")
    mesh_objects = [value for value in bpy.context.scene.objects if value.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError(f"FBX contains no renderable meshes: {source}")
    _bake_scale()
    _apply_materials(item.get("materials", []))
    temporary = destination.with_name(f".{destination.stem}.tmp.glb")
    operation_output = io.StringIO()
    with contextlib.redirect_stdout(operation_output), contextlib.redirect_stderr(operation_output):
        result = bpy.ops.export_scene.gltf(
            filepath=str(temporary),
            export_format="GLB",
            export_animations=False,
            export_cameras=False,
            export_lights=False,
            export_materials="EXPORT",
        )
    if "FINISHED" not in result or not temporary.is_file():
        raise RuntimeError(f"GLB export did not finish: {destination}")
    os.replace(temporary, destination)


def main() -> None:
    arguments = _arguments()
    job_path = Path(arguments.job).resolve()
    if not job_path.is_file() or job_path.is_symlink():
        raise RuntimeError(f"Import job is not a regular file: {job_path}")
    with job_path.open("r", encoding="utf8") as handle:
        job = json.load(handle)
    if job.get("kind") != "UnityCatalogImportJob" or not isinstance(job.get("jobs"), list):
        raise RuntimeError("Invalid Unity catalog import job")
    total = len(job["jobs"])
    for index, item in enumerate(job["jobs"], start=1):
        _convert(item)
        if index == 1 or index % 25 == 0 or index == total:
            print(
                json.dumps(
                    {
                        "status": "pending" if index < total else "eligible",
                        "packageId": job.get("packageId"),
                        "converted": index,
                        "total": total,
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
