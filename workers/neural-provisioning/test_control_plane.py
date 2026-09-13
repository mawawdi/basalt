#!/usr/bin/env python3
"""Focused, network-free tests for the neural provisioning control plane."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(MODULE_ROOT))

from control_plane import (  # noqa: E402
    ARTIFACT_SPECS,
    DINOV3_MODEL_REVISION,
    HUNYUAN3D21_MODEL_REVISION,
    HUNYUAN3D21_SOURCE_COMMIT,
    IMPORT_TRACE_CONTRACT,
    INFERENCE_POLICY,
    OUTPUT_VOLUME_CONTRACT,
    PIXAL3D_MODEL_REVISION,
    PIXAL3D_SOURCE_COMMIT,
    PROVISIONING_POLICY,
    TRELLIS2_MODEL_REVISION,
    TRELLIS2_SOURCE_COMMIT,
    TRELLIS_IMAGE_LARGE_MODEL_REVISION,
    artifact_spec,
    assert_manifest_identity,
    build_cyclonedx_sbom,
    build_dependency_inventory,
    build_import_trace,
    capture_import_trace,
    inventory_tree,
    local_contract,
    provision_artifact,
    seal_snapshot,
)


class ProvisioningContractTests(unittest.TestCase):
    def test_exact_pins_and_complete_artifact_set(self) -> None:
        self.assertEqual(len(ARTIFACT_SPECS), 8)
        expected = {
            "trellis2.source": ("microsoft/TRELLIS.2", TRELLIS2_SOURCE_COMMIT),
            "trellis2.model": ("microsoft/TRELLIS.2-4B", TRELLIS2_MODEL_REVISION),
            "trellis2.sparse_decoder_model": (
                "microsoft/TRELLIS-image-large",
                TRELLIS_IMAGE_LARGE_MODEL_REVISION,
            ),
            "pixal3d.source": ("TencentARC/Pixal3D", PIXAL3D_SOURCE_COMMIT),
            "pixal3d.model": ("TencentARC/Pixal3D", PIXAL3D_MODEL_REVISION),
            "hunyuan3d21.source": (
                "Tencent-Hunyuan/Hunyuan3D-2.1",
                HUNYUAN3D21_SOURCE_COMMIT,
            ),
            "hunyuan3d21.model": ("tencent/Hunyuan3D-2.1", HUNYUAN3D21_MODEL_REVISION),
            "dinov3.model": (
                "facebook/dinov3-vitl16-pretrain-lvd1689m",
                DINOV3_MODEL_REVISION,
            ),
        }
        self.assertEqual(
            {spec.artifact_id: (spec.upstream_id, spec.revision) for spec in ARTIFACT_SPECS},
            expected,
        )
        self.assertTrue(all(len(spec.revision) == 40 for spec in ARTIFACT_SPECS))

    def test_dinov3_and_output_are_shared(self) -> None:
        dino = artifact_spec("dinov3.model")
        self.assertEqual(dino.consumers, ("pixal3d", "trellis2"))
        self.assertEqual(OUTPUT_VOLUME_CONTRACT["name"], "basalt-neural-output")
        self.assertNotIn(
            OUTPUT_VOLUME_CONTRACT["name"],
            {spec.volume_name for spec in ARTIFACT_SPECS},
        )
        self.assertEqual(
            len({spec.volume_name for spec in ARTIFACT_SPECS}),
            len(ARTIFACT_SPECS),
        )

    def test_execution_policies_are_bounded_and_fail_closed(self) -> None:
        self.assertIsNone(PROVISIONING_POLICY["gpu"])
        self.assertEqual(PROVISIONING_POLICY["maxContainers"], 1)
        self.assertEqual(PROVISIONING_POLICY["maxConcurrentInputs"], 1)
        self.assertEqual(PROVISIONING_POLICY["retries"], 0)
        self.assertEqual(PROVISIONING_POLICY["scaledownWindowSeconds"], 60)
        self.assertEqual(PROVISIONING_POLICY["modelImports"], "denied")
        self.assertFalse(PROVISIONING_POLICY["trustRemoteCode"])
        self.assertEqual(INFERENCE_POLICY["runtimeEgress"], "denied")
        self.assertEqual(INFERENCE_POLICY["runtimeDownloads"], "denied")
        self.assertTrue(INFERENCE_POLICY["blockNetwork"])
        self.assertEqual(INFERENCE_POLICY["maxContainers"], 1)
        self.assertEqual(INFERENCE_POLICY["maxConcurrentInputs"], 1)
        self.assertEqual(INFERENCE_POLICY["retries"], 0)
        self.assertEqual(INFERENCE_POLICY["scaledownWindowSeconds"], 60)

    def test_local_contract_is_content_addressed_and_honest(self) -> None:
        contract = local_contract()
        assert_manifest_identity(contract)
        self.assertEqual(contract["status"], "incomplete")
        self.assertFalse(contract["remoteInvocationOccurred"])
        self.assertFalse(contract["volumeCreationOccurred"])
        self.assertFalse(contract["downloadOccurred"])
        self.assertFalse(contract["gpuAllocated"])
        self.assertFalse(contract["credentialsInspected"])

    def test_dependency_inventory_and_sbom_are_deterministic(self) -> None:
        packages = [
            {
                "name": "Example_Dependency",
                "version": "2.0.0",
                "license": "Apache-2.0",
                "metadataSha256": "1" * 64,
            },
            {"name": "another", "version": "1.0", "license": "MIT"},
        ]
        first = build_dependency_inventory(packages)
        second = build_dependency_inventory(reversed(packages))
        self.assertEqual(first, second)
        assert_manifest_identity(first)
        duplicate = build_dependency_inventory([packages[0], packages[0]])
        self.assertEqual(len(duplicate["packages"]), 1)
        second_version = build_dependency_inventory(
            [packages[0], {**packages[0], "version": "9.9.9"}]
        )
        self.assertEqual(len(second_version["packages"]), 2)
        with self.assertRaisesRegex(ValueError, "conflicting metadata"):
            build_dependency_inventory(
                [packages[0], {**packages[0], "license": "Different"}]
            )
        sbom = build_cyclonedx_sbom(first, subject_name="probe", subject_version="1")
        assert_manifest_identity(sbom)
        self.assertEqual(sbom["bomFormat"], "CycloneDX")
        self.assertEqual(sbom["dependencyInventoryHash"], first["hash"])

    def test_file_inventory_hashes_every_payload_file_and_rejects_links(self) -> None:
        spec = artifact_spec("trellis2.source")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "nested" / "data.bin").write_bytes(b"payload")
            (root / ".basalt-evidence").mkdir()
            (root / ".basalt-evidence" / "ignored.json").write_text("{}", encoding="utf-8")
            first = inventory_tree(root, spec)
            self.assertEqual(first["fileCount"], 1)
            self.assertEqual(first["files"][0]["path"], "nested/data.bin")
            assert_manifest_identity(first)
            (root / "nested" / "data.bin").write_bytes(b"changed")
            second = inventory_tree(root, spec)
            self.assertNotEqual(first["hash"], second["hash"])

            linked = root / "linked.bin"
            os.symlink(root / "nested" / "data.bin", linked)
            with self.assertRaisesRegex(ValueError, "linked or special file"):
                inventory_tree(root, spec)

    def test_import_trace_is_content_addressed_and_network_denied(self) -> None:
        synthetic = build_import_trace(
            ("example",),
            [{"name": "example", "origin": None}],
        )
        assert_manifest_identity(synthetic)
        self.assertEqual(synthetic["contract"], IMPORT_TRACE_CONTRACT)
        self.assertEqual(synthetic["networkAttempts"], 0)

        captured = capture_import_trace(("fractions",))
        assert_manifest_identity(captured)
        self.assertEqual(captured["probes"], ["fractions"])
        self.assertEqual(captured["networkAttempts"], 0)
        self.assertTrue(any(item["name"] == "fractions" for item in captured["modules"]))

    def test_interrupted_volume_requires_an_explicit_reset_before_network(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            (mount / ".trellis2.source-interrupted").mkdir()
            with self.assertRaisesRegex(ValueError, "explicit reset"):
                provision_artifact("trellis2.source", mount)

    def test_snapshot_seal_binds_all_evidence_without_inventory_recursion(self) -> None:
        spec = artifact_spec("trellis2.source")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "payload.txt").write_text("exact payload", encoding="utf-8")
            seal = seal_snapshot(root, spec, import_probes=("fractions",))
            assert_manifest_identity(seal)
            self.assertEqual(seal["qualificationStatus"], "incomplete")
            evidence = root / ".basalt-evidence"
            self.assertTrue((evidence / "snapshot-seal.json").is_file())
            inventory_files = list(evidence.glob("file-inventory-*.json"))
            dependency_files = list(evidence.glob("dependency-inventory-*.json"))
            sbom_files = list(evidence.glob("sbom-*.cdx.json"))
            trace_files = list(evidence.glob("import-trace-*.json"))
            self.assertEqual(
                [len(inventory_files), len(dependency_files), len(sbom_files), len(trace_files)],
                [1, 1, 1, 1],
            )
            retained_inventory = json.loads(inventory_files[0].read_text(encoding="utf-8"))
            self.assertEqual(retained_inventory["fileCount"], 2)
            self.assertNotIn(
                ".basalt-evidence",
                {item["path"].split("/")[0] for item in retained_inventory["files"]},
            )

    def test_local_probe_needs_only_the_standard_library(self) -> None:
        modal_token_sentinel = "must-never-appear-from-modal-credential"
        huggingface_token_sentinel = "must-never-appear-from-huggingface-credential"
        completed = subprocess.run(
            [sys.executable, "-S", str(MODULE_ROOT / "modal_app.py"), "--local-probe"],
            check=True,
            capture_output=True,
            text=True,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PYTHONDONTWRITEBYTECODE": "1",
                "MODAL_TOKEN_ID": modal_token_sentinel,
                "MODAL_TOKEN_SECRET": modal_token_sentinel,
                "HF_TOKEN": huggingface_token_sentinel,
            },
        )
        contract = json.loads(completed.stdout)
        assert_manifest_identity(contract)
        self.assertFalse(contract["remoteInvocationOccurred"])
        self.assertFalse(contract["credentialsInspected"])
        self.assertNotIn(modal_token_sentinel, completed.stdout)
        self.assertNotIn(huggingface_token_sentinel, completed.stdout)


if __name__ == "__main__":
    unittest.main()
