# Basalt neural provisioning control plane

This directory owns the provider-neutral step between a pinned upstream
revision and an immutable input Volume. It does not qualify a model, execute
inference, adapt geometry, or make a route eligible.

The control plane declares exact source and model snapshots only for TRELLIS.2,
Pixal3D, and Hunyuan3D 2.1. The single DINOv3 snapshot is shared by TRELLIS.2
and Pixal3D, and TRELLIS.2 has a separate sparse-decoder snapshot. Reference
image generation is a different provider-neutral subsystem and does not share
this provisioning registry. All qualified neural workers publish through one
`basalt-neural-output` Volume; input snapshots are mounted read-only during
inference.

## Safe local probe

The probe uses only the Python standard library. It exits before importing
Modal or Hugging Face, reads no credential, performs no network request or
write, creates no Volume, and allocates no GPU:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -S workers/neural-provisioning/modal_app.py --local-probe
```

The result is canonical, content-addressed JSON with `status: incomplete`. A
declaration is not evidence that any bytes have been provisioned.

Focused tests are also local and make no model or Modal calls:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s workers/neural-provisioning -p 'test_*.py'
```

## Exact artifact inventory

| Artifact                 | Upstream                                   | Revision                                   |
| ------------------------ | ------------------------------------------ | ------------------------------------------ |
| TRELLIS.2 source         | `microsoft/TRELLIS.2`                      | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` |
| TRELLIS.2 model          | `microsoft/TRELLIS.2-4B`                   | `af44b45f2e35a493886929c6d786e563ec68364d` |
| TRELLIS.2 sparse decoder | `microsoft/TRELLIS-image-large`            | `25e0d31ffbebe4b5a97464dd851910efc3002d96` |
| Pixal3D source           | `TencentARC/Pixal3D`                       | `f7cf38429b0bd264f1995f0f8743a88b1c728b94` |
| Pixal3D model            | `TencentARC/Pixal3D`                       | `b0cb2e1b794cab9aa0ac38a95d794a4d9337437f` |
| Hunyuan3D 2.1 source     | `Tencent-Hunyuan/Hunyuan3D-2.1`            | `82920d643c0dc2f7bfd7255f45f62d386edfe60c` |
| Hunyuan3D 2.1 model      | `tencent/Hunyuan3D-2.1`                    | `0b94677654c57bb9a6b6845cd7b704ccf551d327` |
| Shared DINOv3 model      | `facebook/dinov3-vitl16-pretrain-lvd1689m` | `ea8dc2863c51be0a264bab82070e3e8836b02d51` |

Every input gets its own stable Volume and a `snapshot/` payload. The retained
snapshot seal identifies the exact source or model bytes. The
snapshot is published only after Basalt writes these canonical JSON artifacts:

- a pin manifest;
- a SHA-256 and byte count for every payload file;
- a Python and operating-system dependency inventory;
- a CycloneDX 1.5 SBOM;
- a no-network Python import trace; and
- one seal binding all evidence hashes.

Existing sealed bytes are verified and reused. Unsealed or mismatched bytes
fail closed and require an explicit Volume reset; the provisioner never repairs
or overwrites them in place.

## Modal execution boundary

Provisioning is an explicit CPU task: two requested cores, four-core limit,
one container, one concurrent input, no retries, and a 60-second scale-down
window. It accepts only a declared artifact ID and the exact execution literal
`PROVISION_ONE_PINNED_BASALT_NEURAL_ARTIFACT`. No caller-supplied URL is accepted.
The model snapshot client receives the named `basalt-neural-huggingface-read`
Secret through Modal and resolves access internally; Basalt never reads, prints,
returns, or stores its value.

Provisioning has network access solely to acquire the fixed GitHub or Hugging
Face origin named by the artifact contract. The resulting inventory records the
actual bytes. Model execution remains a separate boundary with network and
Modal resource access blocked, runtime downloads disabled, input Volumes
read-only, concurrency one, retries zero, and only `basalt-neural-output`
writable.

The checked-in Modal entrypoint is intentionally not invoked by ordinary tests.
Running it later will create the declared Volumes and may download large gated
snapshots. Provisioning evidence still leaves every provider `incomplete` until
its exact inference image, dependency/import policy, output contract, common
adaptation, deterministic gates, visual pilot, and Studio evidence pass.
