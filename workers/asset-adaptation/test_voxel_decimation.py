from __future__ import annotations

import importlib.util
import math
import pathlib

import bpy


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER_PATH = ROOT / "workers/asset-adaptation/worker.py"
SPEC = importlib.util.spec_from_file_location("basalt_asset_adaptation_worker", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load fixed asset adaptation worker")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64)
obj = bpy.context.object
for name, phase in (("BasaltTensorBaseColor", 0.0), ("BasaltTensorORM", 0.37)):
    attribute = obj.data.color_attributes.new(
        name=name,
        type="FLOAT_COLOR",
        domain="POINT",
    )
    denominator = max(1, len(attribute.data) - 1)
    for index, value in enumerate(attribute.data):
        unit = index / denominator
        value.color = (
            0.1 + 0.8 * unit,
            0.2 + 0.3 * math.sin(unit * math.pi + phase) ** 2,
            0.35,
            1.0,
        )

remesh = worker.deterministic_voxel_remesh(obj, 1_200)
assert remesh["inputTriangles"] > 1_200
assert remesh["outputTriangles"] > 0
assert remesh["resolutionAcrossLargestExtent"] == 64
assert remesh["preservedAttributes"] == ["BasaltTensorBaseColor", "BasaltTensorORM"]
assert worker.retained_neural_vertex_attributes(obj) == remesh["preservedAttributes"]

passes = []
for _ in range(4):
    if worker.triangle_count(obj) <= 1_200:
        break
    passes.append(worker.apply_collapse_decimation(obj, 1_200, 0.9))
assert worker.triangle_count(obj) <= 1_200, passes
assert worker.retained_neural_vertex_attributes(obj) == remesh["preservedAttributes"]
for name in remesh["preservedAttributes"]:
    attribute = obj.data.color_attributes[name]
    values = [float(item.color[0]) for item in attribute.data]
    assert min(values) < max(values)

print(
    {
        "status": "passed",
        "remesh": remesh,
        "collapsePasses": passes,
        "outputTriangles": worker.triangle_count(obj),
    }
)
