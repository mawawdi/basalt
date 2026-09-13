"""Render deterministic, material-aware multiview evidence for catalog GLBs."""

import argparse
import contextlib
import io
import json
import math
import os
from pathlib import Path

import bpy
import OpenImageIO as oiio
from mathutils import Vector


def arguments():
    values = os.sys.argv[os.sys.argv.index("--") + 1 :] if "--" in os.sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--source-hash")
    return parser.parse_args(values)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for group in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.worlds,
    ):
        for value in list(group):
            group.remove(value)


def look_at(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def area_light(name, center, extent, direction, energy):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy * extent * extent
    data.shape = "DISK"
    data.size = extent * 1.75
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = center + Vector(direction).normalized() * extent * 3
    look_at(light, center)


def neutralize_non_color_channels():
    """Preserve imported albedo/alpha while avoiding packed-map metallic washout."""
    for material in bpy.data.materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            for name, value in (("Metallic", 0.0), ("Roughness", 0.72), ("Emission Strength", 0.0)):
                socket = node.inputs.get(name)
                if socket is None:
                    continue
                for link in list(material.node_tree.links):
                    if link.to_socket == socket:
                        material.node_tree.links.remove(link)
                socket.default_value = value
            emission = node.inputs.get("Emission Color")
            if emission is not None:
                for link in list(material.node_tree.links):
                    if link.to_socket == emission:
                        material.node_tree.links.remove(link)
                emission.default_value = (0.0, 0.0, 0.0, 1.0)


def configure_compositor(scene, temporary_directory, camera):
    tree = scene.compositing_node_group
    if tree is None:
        tree = bpy.data.node_groups.new("BasaltReviewCompositor", "CompositorNodeTree")
        scene.compositing_node_group = tree
    tree.nodes.clear()
    layers = tree.nodes.new("CompositorNodeRLayers")
    alpha = tree.nodes.new("CompositorNodeOutputFile")
    alpha.directory = str(temporary_directory)
    alpha.file_name = "silhouette"
    alpha.file_output_items.new("FLOAT", "Alpha")
    tree.links.new(layers.outputs["Alpha"], alpha.inputs["Alpha"])

    depth_map = tree.nodes.new("ShaderNodeMapRange")
    depth_map.inputs[1].default_value = camera.data.clip_start
    depth_map.inputs[2].default_value = camera.data.clip_end
    depth_map.inputs[3].default_value = 0.0
    depth_map.inputs[4].default_value = 1.0
    depth_map.clamp = True
    tree.links.new(layers.outputs["Depth"], depth_map.inputs[0])
    depth = tree.nodes.new("CompositorNodeOutputFile")
    depth.directory = str(temporary_directory)
    depth.file_name = "depth"
    depth.file_output_items.new("FLOAT", "Depth")
    tree.links.new(depth_map.outputs[0], depth.inputs["Depth"])

    normal_channels = tree.nodes.new("CompositorNodeSeparateColor")
    normal_channels.mode = "RGB"
    tree.links.new(layers.outputs["Normal"], normal_channels.inputs["Image"])
    encoded_channels = []
    for channel in ("Red", "Green", "Blue"):
        encode = tree.nodes.new("ShaderNodeMath")
        encode.operation = "MULTIPLY_ADD"
        encode.inputs[1].default_value = 0.5
        encode.inputs[2].default_value = 0.5
        tree.links.new(normal_channels.outputs[channel], encode.inputs[0])
        encoded_channels.append(encode)
    encoded_normal = tree.nodes.new("CompositorNodeCombineColor")
    encoded_normal.mode = "RGB"
    for channel, encode in zip(("Red", "Green", "Blue"), encoded_channels):
        tree.links.new(encode.outputs[0], encoded_normal.inputs[channel])
    normal = tree.nodes.new("CompositorNodeOutputFile")
    normal.directory = str(temporary_directory)
    normal.file_name = "normal"
    normal.file_output_items.new("VECTOR", "Normal")
    tree.links.new(encoded_normal.outputs["Image"], normal.inputs["Normal"])

    base_color = tree.nodes.new("CompositorNodeOutputFile")
    base_color.directory = str(temporary_directory)
    base_color.file_name = "base-color"
    base_color.file_output_items.new("RGBA", "BaseColor")
    tree.links.new(layers.outputs["Diffuse Color"], base_color.inputs["BaseColor"])


def convert_compositor_output(directory, stem, destination, pixel_type):
    candidates = sorted(directory.glob(f"{stem}.*"))
    if len(candidates) != 1:
        raise RuntimeError(f"expected one {stem} compositor output, found {len(candidates)}")
    temporary = destination.parent / f".{destination.stem}.{os.getpid()}.tmp.png"
    image = oiio.ImageBuf(str(candidates[0]))
    if image.has_error:
        raise RuntimeError(f"cannot read {stem} compositor output: {image.geterror()}")
    if not image.write(str(temporary), pixel_type):
        raise RuntimeError(f"cannot encode {stem} PNG: {image.geterror()}")
    os.replace(temporary, destination)
    candidates[0].unlink(missing_ok=True)
    if png_signature(destination) != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"{stem} output did not produce a real PNG")


def png_signature(path):
    with path.open("rb") as handle:
        return handle.read(8)


def validate_rgb_output(path):
    if png_signature(path) != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("RGB render did not produce a real PNG")
    image = oiio.ImageBuf(str(path))
    if image.has_error:
        raise RuntimeError(f"cannot read RGB render: {image.geterror()}")
    if tuple(image.spec().channelnames) != ("R", "G", "B", "A"):
        raise RuntimeError("RGB render is not RGBA evidence")
    statistics = oiio.ImageBufAlgo.computePixelStats(image)
    if statistics.min[3] > 0.01:
        raise RuntimeError("RGB render does not retain a transparent review background")
    return statistics.max[3] >= 0.01


def render_view(scene, camera, center, extent, view, paths, quiet):
    azimuth = math.radians(view["azimuthDegrees"])
    elevation = math.radians(view["elevationDegrees"])
    direction = Vector(
        (
            math.cos(elevation) * math.cos(azimuth),
            math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
        )
    )
    camera.location = center + direction * extent * 2.5
    look_at(camera, center)
    bpy.context.view_layer.update()

    output_directory = Path(paths["rgbPath"]).parent
    temporary_directory = output_directory / f".{view['viewId']}-rendering"
    temporary_directory.mkdir(parents=True, exist_ok=True)
    configure_compositor(scene, temporary_directory, camera)
    rgb_path = Path(paths["rgbPath"])
    scene.render.filepath = str(rgb_path)
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        bpy.ops.render.render(write_still=True)
    convert_compositor_output(
        temporary_directory,
        "silhouette",
        Path(paths["silhouettePath"]),
        oiio.UINT8,
    )
    convert_compositor_output(
        temporary_directory,
        "depth",
        Path(paths["normalizedDepthPath"]),
        oiio.UINT16,
    )
    convert_compositor_output(
        temporary_directory,
        "normal",
        Path(paths["surfaceNormalPath"]),
        oiio.UINT8,
    )
    convert_compositor_output(
        temporary_directory,
        "base-color",
        Path(paths["unlitBaseColorPath"]),
        oiio.UINT8,
    )
    has_foreground = validate_rgb_output(rgb_path)
    temporary_directory.rmdir()
    return has_foreground


def render_item(item):
    clear_scene()
    quiet = io.StringIO()
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        bpy.ops.import_scene.gltf(filepath=item["sourcePath"])
    neutralize_non_color_channels()
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("no renderable mesh")
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = Vector(tuple(min(point[index] for point in corners) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in corners) for index in range(3)))
    center = (low + high) * 0.5
    extent = max((high - low).length, 0.01)

    camera_data = bpy.data.cameras.new("ReviewCamera")
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(high.x - low.x, high.y - low.y, high.z - low.z) * 1.7
    camera_data.clip_start = max(0.001, extent * 0.001)
    camera_data.clip_end = extent * 20
    bpy.context.scene.camera = camera

    area_light("ReviewKey", center, extent, (2, -3, 4), 85)
    area_light("ReviewFill", center, extent, (-3, -1, 2), 35)
    area_light("ReviewRim", center, extent, (0, 3, 1), 20)
    world = bpy.data.worlds.new("ReviewWorld")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.055, 0.065, 0.08, 1)
    background.inputs["Strength"].default_value = 0.9
    bpy.context.scene.world = world

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x = 320
    scene.render.resolution_y = 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.view_layers[0].use_pass_z = True
    scene.view_layers[0].use_pass_normal = True
    scene.view_layers[0].use_pass_diffuse_color = True
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.35

    visible_views = 0
    for view in item["views"]:
        if render_view(scene, camera, center, extent, view, view, quiet):
            visible_views += 1
    if visible_views == 0:
        raise RuntimeError("no canonical review view contains visible foreground")


def main():
    options = arguments()
    with open(options.job, encoding="utf8") as handle:
        job = json.load(handle)
    items = job["items"]
    if options.source_hash is not None:
        items = [item for item in items if item["sourceContentHash"] == options.source_hash]
        if len(items) != 1:
            raise RuntimeError(f"source hash selected {len(items)} review items")
    failures = []
    for index, item in enumerate(items, 1):
        try:
            render_item(item)
        except Exception as error:
            failures.append({"hash": item["sourceContentHash"], "reason": str(error)})
            print(json.dumps(failures[-1]), flush=True)
        if index == 1 or index % 25 == 0 or index == len(items):
            print(json.dumps({"rendered": index, "total": len(items), "failures": len(failures)}), flush=True)
    print(
        json.dumps(
            {
                "completed": len(items) - len(failures),
                "failed": len(failures),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
