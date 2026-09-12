from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CollisionGateEvidence:
    syntactic: bool
    volumetric_inclusion: float
    triangle_ratio: float
    watertight: bool
    convex: bool
    convex_components: int

    @property
    def accepted(self) -> bool:
        return (
            self.syntactic
            and self.volumetric_inclusion >= 0.94
            and self.triangle_ratio <= 0.15
            and self.watertight
            and self.convex
            and self.convex_components <= 8
        )


def evaluate_collision_gates(
    syntactic: bool,
    volumetric_inclusion: float,
    render_triangles: int,
    collision_triangles: int,
    watertight: bool,
    convex: bool,
    convex_components: int,
) -> CollisionGateEvidence:
    ratio = float("inf") if render_triangles <= 0 else collision_triangles / render_triangles
    if collision_triangles > 2000:
        ratio = max(ratio, 0.16)
    return CollisionGateEvidence(syntactic, volumetric_inclusion, ratio, watertight, convex, convex_components)
