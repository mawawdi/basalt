"""Explicit GPU profiles for TRELLIS.2 qualification runs."""

from __future__ import annotations

import os
from typing import Final


GPU_PROFILES: Final = {
    "a100-80gb": {"modalGpu": "A100-80GB", "minimumVramGiB": 40},
    "l40s-48gb": {"modalGpu": "L40S", "minimumVramGiB": 40},
}
GPU_PROFILE_ENV = "BASALT_TRELLIS2_GPU_PROFILE"
DEFAULT_GPU_PROFILE = "a100-80gb"


def selected_gpu_profile() -> str:
    profile = os.environ.get(GPU_PROFILE_ENV, DEFAULT_GPU_PROFILE).strip().lower()
    if profile not in GPU_PROFILES:
        supported = ", ".join(sorted(GPU_PROFILES))
        raise ValueError(f"{GPU_PROFILE_ENV} must be one of: {supported}")
    return profile


def selected_gpu() -> str:
    return str(GPU_PROFILES[selected_gpu_profile()]["modalGpu"])


def selected_minimum_vram_gib() -> int:
    return int(GPU_PROFILES[selected_gpu_profile()]["minimumVramGiB"])
