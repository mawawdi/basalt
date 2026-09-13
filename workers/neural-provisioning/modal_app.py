#!/usr/bin/env python3
"""Modal control plane for exact, CPU-only neural artifact provisioning.

Running this file directly supports only ``--local-probe``. That path exits
before Modal or Hugging Face is imported and cannot create a Volume, download
an artifact, inspect a credential, or allocate a GPU.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from control_plane import (
    ARTIFACT_SPECS,
    HF_READ_SECRET_NAME,
    OUTPUT_VOLUME_CONTRACT,
    OUTPUT_VOLUME_NAME,
    PROVISION_EXECUTION_LITERAL,
    PROVISIONING_POLICY,
    artifact_spec,
    canonical_bytes,
    local_contract,
    provision_artifact,
    require,
)


APP_NAME = "basalt-neural-provisioning"
PROVISIONER_PYTHON = "3.13"
HUGGINGFACE_HUB_VERSION = "0.35.3"
CONTROL_PLANE_SOURCE = Path(__file__).resolve().with_name("control_plane.py")


def run_local_probe() -> int:
    print(canonical_bytes(local_contract()).decode("utf-8"))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Basalt neural artifact provisioning control plane")
    parser.add_argument("--local-probe", action="store_true")
    arguments = parser.parse_args()
    if not arguments.local_probe:
        parser.error("direct execution supports only --local-probe; provisioning requires `modal run`")
    raise SystemExit(run_local_probe())


# Everything below this point is unreachable from --local-probe.
import modal  # type: ignore[import-not-found]  # noqa: E402


PROVISIONER_IMAGE = (
    modal.Image.debian_slim(python_version=PROVISIONER_PYTHON)
    .apt_install("ca-certificates", "git")
    .pip_install(f"huggingface-hub=={HUGGINGFACE_HUB_VERSION}")
    .add_local_file(CONTROL_PLANE_SOURCE, "/root/control_plane.py", copy=True)
)

INPUT_VOLUMES = {
    spec.volume_name: modal.Volume.from_name(spec.volume_name, create_if_missing=True)
    for spec in ARTIFACT_SPECS
}
OUTPUT_VOLUME = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=True)
HF_READ_SECRET = modal.Secret.from_name(HF_READ_SECRET_NAME, required_keys=["HF_TOKEN"])
app = modal.App(APP_NAME, include_source=True)


def _remote_volume_mounts() -> dict[str, Any]:
    return {
        spec.mount_path: INPUT_VOLUMES[spec.volume_name]
        for spec in ARTIFACT_SPECS
    }


@app.function(
    serialized=True,
    image=PROVISIONER_IMAGE,
    cpu=(
        PROVISIONING_POLICY["cpu"]["request"],
        PROVISIONING_POLICY["cpu"]["limit"],
    ),
    memory=(
        PROVISIONING_POLICY["memoryMiB"]["request"],
        PROVISIONING_POLICY["memoryMiB"]["limit"],
    ),
    volumes=_remote_volume_mounts(),
    secrets=[HF_READ_SECRET],
    min_containers=PROVISIONING_POLICY["minContainers"],
    max_containers=PROVISIONING_POLICY["maxContainers"],
    buffer_containers=PROVISIONING_POLICY["bufferContainers"],
    scaledown_window=PROVISIONING_POLICY["scaledownWindowSeconds"],
    retries=PROVISIONING_POLICY["retries"],
    timeout=PROVISIONING_POLICY["timeoutSeconds"],
    restrict_modal_access=True,
    include_source=True,
)
@modal.concurrent(max_inputs=PROVISIONING_POLICY["maxConcurrentInputs"])
def provision_pinned_artifact(artifact_id: str, execution_literal: str) -> dict[str, Any]:
    """Materialize one declared snapshot and return only its content identities."""

    require(
        execution_literal == PROVISION_EXECUTION_LITERAL,
        "explicit provisioning execution literal is absent or invalid",
    )
    spec = artifact_spec(artifact_id)
    seal = provision_artifact(spec.artifact_id, Path(spec.mount_path))
    INPUT_VOLUMES[spec.volume_name].commit()
    return {
        "kind": "BasaltNeuralProvisioningReceipt",
        "contract": "basalt-neural-provisioning-receipt",
        "artifactId": spec.artifact_id,
        "revision": spec.revision,
        "volumeName": spec.volume_name,
        "snapshotPath": f"{spec.mount_path}/snapshot",
        "snapshotSealHash": seal["hash"],
        "qualificationStatus": "incomplete",
        "modelWasImported": False,
        "gpuWasAllocated": False,
    }


@app.local_entrypoint()
def main(artifact_id: str, execution_literal: str = "") -> None:
    """Explicit paid entrypoint; one call provisions one exact declared artifact."""

    require(artifact_id in {spec.artifact_id for spec in ARTIFACT_SPECS}, "artifact ID is not declared")
    receipt = provision_pinned_artifact.remote(artifact_id, execution_literal)
    print(json.dumps(receipt, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True))


assert OUTPUT_VOLUME_CONTRACT["name"] == OUTPUT_VOLUME_NAME
