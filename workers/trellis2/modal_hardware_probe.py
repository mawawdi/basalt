#!/usr/bin/env python3
"""Minimal paid Modal hardware probe for the future TRELLIS.2 route.

Running this app without the exact execution literal performs no remote call.
The remote Function repeats the literal check so invoking it directly cannot
silently bypass the local guard. It deliberately mounts no custom image,
Volume, Secret, or repository file.
"""

from __future__ import annotations

import json

from gpu_profile import selected_gpu, selected_gpu_profile, selected_minimum_vram_gib

import modal


APP_NAME = "basalt-trellis2-hardware-probe"
GPU_PROFILE = selected_gpu_profile()
GPU_KIND = selected_gpu()
GPU_MINIMUM_VRAM_GIB = selected_minimum_vram_gib()
EXECUTION_LITERAL = f"RUN_ONE_BASALT_TRELLIS2_{GPU_PROFILE.upper().replace('-', '_')}_HARDWARE_PROBE"
TIMEOUT_SECONDS = 45

app = modal.App(APP_NAME, include_source=False)


@app.function(
    serialized=True,
    gpu=GPU_KIND,
    cpu=(0.125, 1.0),
    memory=(128, 1024),
    min_containers=0,
    max_containers=1,
    buffer_containers=0,
    scaledown_window=60,
    retries=0,
    timeout=TIMEOUT_SECONDS,
    startup_timeout=TIMEOUT_SECONDS,
    block_network=True,
    restrict_modal_access=True,
    single_use_containers=True,
    include_source=False,
)
def measure_hardware(execution_flag: str) -> dict[str, object]:
    import csv
    import io
    import platform
    import re
    import subprocess

    if execution_flag != EXECUTION_LITERAL:
        raise ValueError("hardware probe execution literal is absent or invalid")

    def nvidia_smi(*arguments: str) -> str:
        completed = subprocess.run(
            ["nvidia-smi", *arguments],
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            timeout=10,
        )
        return completed.stdout.strip()

    rows = list(
        csv.reader(
            io.StringIO(
                nvidia_smi(
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                )
            )
        )
    )
    if len(rows) != 1 or len(rows[0]) != 2:
        raise RuntimeError("hardware probe requires exactly one NVIDIA GPU")
    gpu_model = rows[0][0].strip()
    memory_mib = int(rows[0][1].strip())
    cuda_match = re.search(r"CUDA Version:\s*([0-9]+(?:\.[0-9]+)*)", nvidia_smi())
    if not cuda_match:
        raise RuntimeError("nvidia-smi did not report a CUDA compatibility version")
    return {
        "gpuModel": gpu_model,
        "vramGiB": memory_mib / 1024,
        "cudaVersion": cuda_match.group(1),
        "hostPlatform": platform.platform(),
    }


@app.local_entrypoint()
def main(execution_flag: str = "") -> None:
    if execution_flag != EXECUTION_LITERAL:
        print(
            json.dumps(
                {
                    "remoteInvocationOccurred": False,
                    "requiredExecutionFlag": EXECUTION_LITERAL,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return
    print(json.dumps(measure_hardware.remote(execution_flag), separators=(",", ":"), sort_keys=True))
