from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple


def compute_mismatch_energy(
    island_aspect_ratio: float,
    island_3d_area: float,
    band: Dict[str, Any],
    aspect_ratio_penalty: float = 1.0,
    area_distortion_penalty: float = 0.5,
) -> float:
    metric_w = float(band.get("metricWidth", 1.0))
    metric_h = float(band.get("metricHeight", 1.0))
    band_ratio = metric_w / max(1e-6, metric_h)
    band_area = metric_w * metric_h

    safe_island_ratio = max(1e-6, island_aspect_ratio)
    safe_band_ratio = max(1e-6, band_ratio)
    ratio_diff = abs(math.log(safe_island_ratio / safe_band_ratio))
    area_diff = abs(island_3d_area / max(1e-6, band_area) - 1.0)

    return aspect_ratio_penalty * ratio_diff + area_distortion_penalty * area_diff


def match_optimal_band(
    island_aspect_ratio: float,
    island_3d_area: float,
    bands: List[Dict[str, Any]],
    semantic_role: Optional[str] = None,
    aspect_ratio_penalty: float = 1.0,
    area_distortion_penalty: float = 0.5,
) -> Optional[Dict[str, Any]]:
    if not bands:
        return None

    eligible = [
        b
        for b in bands
        if semantic_role is None or semantic_role in b.get("semanticRoles", [])
    ]
    pool = eligible if eligible else bands

    best_band = None
    lowest_energy = float("inf")

    for band in pool:
        energy = compute_mismatch_energy(
            island_aspect_ratio,
            island_3d_area,
            band,
            aspect_ratio_penalty,
            area_distortion_penalty,
        )
        if energy < lowest_energy:
            lowest_energy = energy
            best_band = band

    return best_band


def apply_hotspot_to_mesh(
    mesh_obj: Any,
    trim_spec: Dict[str, Any],
    uv_layer_name: str = "UVMap",
) -> Dict[str, Any]:
    """
    Applies Hotspot texturing in Blender to an active mesh object.
    Groups faces by coplanar angle threshold, fits each group
    to optimal trim band, scales UVs to target texel density, and clamps
    the non-tiling axis into band bounds while wrapping along tiling axis.
    """
    import bmesh
    from mathutils import Vector

    target_td = float(trim_spec.get("targetTexelDensity", 64.0))
    resolution = trim_spec.get("resolution", {"width": 2048, "height": 2048})
    tex_w = float(resolution.get("width", 2048))
    tex_h = float(resolution.get("height", 2048))
    bands = trim_spec.get("bands", [])
    weights = trim_spec.get("energyWeights", {})
    alpha = float(weights.get("aspectRatioPenalty", 1.0))
    beta = float(weights.get("areaDistortionPenalty", 0.5))

    bm = bmesh.new()
    bm.from_mesh(mesh_obj.data)
    uv_layer = (
        bm.loops.layers.uv.get(uv_layer_name) or bm.loops.layers.uv.new(uv_layer_name)
    )

    unvisited = set(bm.faces)
    islands: List[List[bmesh.types.BMFace]] = []
    angle_threshold = math.radians(25.0)

    while unvisited:
        start_face = unvisited.pop()
        island = [start_face]
        queue = [start_face]

        while queue:
            current = queue.pop()
            for edge in current.edges:
                for neighbor in edge.link_faces:
                    if neighbor in unvisited:
                        if current.normal.angle(neighbor.normal) <= angle_threshold:
                            unvisited.remove(neighbor)
                            island.append(neighbor)
                            queue.append(neighbor)
        islands.append(island)

    assignments = []
    for island in islands:
        area_3d = sum(face.calc_area() for face in island)

        avg_normal = Vector((0.0, 0.0, 0.0))
        for f in island:
            avg_normal += f.normal
        if avg_normal.length > 1e-6:
            avg_normal.normalize()
        else:
            avg_normal = Vector((0.0, 1.0, 0.0))

        tangent = Vector((1.0, 0.0, 0.0))
        if abs(avg_normal.dot(tangent)) > 0.9:
            tangent = Vector((0.0, 0.0, 1.0))
        bitangent = avg_normal.cross(tangent).normalized()
        tangent = bitangent.cross(avg_normal).normalized()

        local_pts: List[Tuple[float, float]] = []
        for face in island:
            for loop in face.loops:
                co = loop.vert.co
                u = co.dot(tangent)
                v = co.dot(bitangent)
                local_pts.append((u, v))

        if not local_pts:
            continue

        min_u = min(p[0] for p in local_pts)
        max_u = max(p[0] for p in local_pts)
        min_v = min(p[1] for p in local_pts)
        max_v = max(p[1] for p in local_pts)

        extent_u = max(1e-4, max_u - min_u)
        extent_v = max(1e-4, max_v - min_v)
        aspect_ratio = extent_u / extent_v

        band = match_optimal_band(
            aspect_ratio,
            area_3d,
            bands,
            aspect_ratio_penalty=alpha,
            area_distortion_penalty=beta,
        )
        if not band:
            continue

        scale_u = target_td / tex_w
        scale_v = target_td / tex_h

        tiling_axis = band.get("tilingAxis", "u")
        u_min = float(band.get("uMin", 0.0))
        u_max = float(band.get("uMax", 1.0))
        v_min = float(band.get("vMin", 0.0))
        v_max = float(band.get("vMax", 1.0))

        for face in island:
            for loop in face.loops:
                co = loop.vert.co
                local_u = (co.dot(tangent) - min_u) * scale_u
                local_v = (co.dot(bitangent) - min_v) * scale_v

                if tiling_axis == "u":
                    uv_u = u_min + (local_u % max(1e-6, u_max - u_min))
                    uv_v = min(v_max, max(v_min, v_min + local_v))
                elif tiling_axis == "v":
                    uv_u = min(u_max, max(u_min, u_min + local_u))
                    uv_v = v_min + (local_v % max(1e-6, v_max - v_min))
                else:
                    norm_u = (co.dot(tangent) - min_u) / extent_u
                    norm_v = (co.dot(bitangent) - min_v) / extent_v
                    uv_u = u_min + norm_u * (u_max - u_min)
                    uv_v = v_min + norm_v * (v_max - v_min)

                loop[uv_layer].uv = (uv_u, uv_v)

        assignments.append(
            {
                "bandId": band.get("bandId"),
                "faceCount": len(island),
                "area3d": area_3d,
                "aspectRatio": aspect_ratio,
            }
        )

    bm.to_mesh(mesh_obj.data)
    bm.free()

    return {
        "status": "applied",
        "islandCount": len(islands),
        "assignedBands": assignments,
    }
