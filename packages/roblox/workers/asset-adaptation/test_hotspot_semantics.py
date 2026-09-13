from __future__ import annotations

import importlib.util
import pathlib
import bpy

ROOT = pathlib.Path(__file__).resolve().parents[2]
HOTSPOT_PATH = ROOT / "workers/asset-adaptation/hotspot_unwrap.py"
SPEC = importlib.util.spec_from_file_location("hotspot_unwrap", HOTSPOT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load hotspot_unwrap module")
hotspot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hotspot)

# Initialize factory settings
bpy.ops.wm.read_factory_settings(use_empty=True)

# Create a test cube (2x2x2)
bpy.ops.mesh.primitive_cube_add(size=2.0)
obj = bpy.context.object

test_trim_spec = {
    "targetTexelDensity": 64.0,
    "resolution": {"width": 2048, "height": 2048},
    "bands": [
        {
            "bandId": "band_bevel",
            "semanticRoles": ["bevel"],
            "uMin": 0.0,
            "vMin": 0.0,
            "uMax": 1.0,
            "vMax": 0.2,
            "tilingAxis": "u",
            "metricWidth": 4.0,
            "metricHeight": 0.4,
        },
        {
            "bandId": "band_wall",
            "semanticRoles": ["wall"],
            "uMin": 0.0,
            "vMin": 0.2,
            "uMax": 1.0,
            "vMax": 1.0,
            "tilingAxis": "u",
            "metricWidth": 4.0,
            "metricHeight": 3.2,
        },
    ],
    "energyWeights": {
        "aspectRatioPenalty": 1.0,
        "areaDistortionPenalty": 0.5,
    },
}

result = hotspot.apply_hotspot_to_mesh(obj, test_trim_spec)

assert result["status"] == "applied", f"Unexpected status: {result}"
assert result["islandCount"] == 6, f"Expected 6 coplanar islands for cube, got {result['islandCount']}"
assert len(result["assignedBands"]) == 6, f"Expected 6 assigned bands, got {len(result['assignedBands'])}"

# Verify UV coordinates exist and are populated
mesh = obj.data
uv_layer = mesh.uv_layers.get("UVMap")
assert uv_layer is not None, "UVMap layer must exist"
assert len(uv_layer.data) == len(mesh.loops), "Every loop must have a UV coordinate"

for loop_uv in uv_layer.data:
    u, v = loop_uv.uv
    assert 0.0 <= u <= 1.0, f"U coordinate {u} out of [0, 1] range"
    assert 0.0 <= v <= 1.0, f"V coordinate {v} out of [0, 1] range"

print("Hotspot unwrap semantics test passed successfully!")
