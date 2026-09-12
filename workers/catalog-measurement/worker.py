from __future__ import annotations

from typing import Iterable, Sequence


APPROVED_SCALE_CANDIDATES = (0.01, 0.1, 1.0, 3.571)


def choose_scale_candidate(raw_height: float, meters_per_source_unit: float = 1.0, avatar_height_studs: float = 5.0, stud_meters: float = 0.28) -> float:
    if raw_height <= 0.0 or meters_per_source_unit <= 0.0 or stud_meters <= 0.0:
        raise ValueError("Scale classification requires positive dimensions and unit sizes")
    target_source_height = avatar_height_studs * stud_meters / meters_per_source_unit
    return min(APPROVED_SCALE_CANDIDATES, key=lambda candidate: abs(raw_height * candidate - target_source_height))


def classify_pivot_policy(is_grounded: bool) -> str:
    return "bottom_center_obb" if is_grounded else "volumetric_center"


def validate_identity_nodes(nodes: Iterable[dict]) -> None:
    for node in nodes:
        transform = node.get("transform")
        if transform not in (None, "identity"):
            raise ValueError("Normalized worker output must contain identity nodes")
