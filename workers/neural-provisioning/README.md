# Basalt neural provisioning control plane

This directory owns the provider-neutral step between a pinned upstream
revision and an immutable input Volume. It does not qualify a model, execute
inference, adapt geometry, or make a route eligible.

The control plane declares exact source and model snapshots for TRELLIS.2,
Pixal3D, Hunyuan3D 2.1, Qwen Image 2512, Qwen Image Edit 2511, FLUX.2 Klein 4B,
LongCat Image Edit, FireRed Image Edit 1.1, and SAM 3. Qwen Edit, FLUX, and
LongCat are the active regional-composition trial. FireRed bytes remain an
unregistered reserve research snapshot; provisioning them does not create a
runtime producer or route alias. The single DINOv3 snapshot is shared by
TRELLIS.2 and Pixal3D. All qualified neural workers publish through one
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

| Artifact                             | Upstream                                   | Revision                                   |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| TRELLIS.2 source                     | `microsoft/TRELLIS.2`                      | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` |
| TRELLIS.2 model                      | `microsoft/TRELLIS.2-4B`                   | `af44b45f2e35a493886929c6d786e563ec68364d` |
| Pixal3D source                       | `TencentARC/Pixal3D`                       | `f7cf38429b0bd264f1995f0f8743a88b1c728b94` |
| Pixal3D model                        | `TencentARC/Pixal3D`                       | `b0cb2e1b794cab9aa0ac38a95d794a4d9337437f` |
| Hunyuan3D 2.1 source                 | `Tencent-Hunyuan/Hunyuan3D-2.1`            | `82920d643c0dc2f7bfd7255f45f62d386edfe60c` |
| Hunyuan3D 2.1 model                  | `tencent/Hunyuan3D-2.1`                    | `0b94677654c57bb9a6b6845cd7b704ccf551d327` |
| Shared DINOv3 model                  | `facebook/dinov3-vitl16-pretrain-lvd1689m` | `ea8dc2863c51be0a264bab82070e3e8836b02d51` |
| Qwen Image source                    | `QwenLM/Qwen-Image`                        | `6b5e1f5cec987d404be5ac6657db3b9aacb56a89` |
| Qwen Image 2512 model                | `Qwen/Qwen-Image-2512`                     | `25468b98e3276ca6700de15c6628e51b7de54a26` |
| Qwen Image Edit 2511 model           | `Qwen/Qwen-Image-Edit-2511`                | `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9` |
| FLUX.2 source                        | `black-forest-labs/flux2`                  | `50fe5162777813d869182b139e83b10743caef15` |
| FLUX.2 Klein 4B model                | `black-forest-labs/FLUX.2-klein-4B`        | `e7b7dc27f91deacad38e78976d1f2b499d76a294` |
| LongCat Image source                 | `meituan-longcat/LongCat-Image`            | `f0e4c43c5ef74b011ff71570fbfc2bdffbc9ab06` |
| LongCat Image Edit model             | `meituan-longcat/LongCat-Image-Edit`       | `7b54ef423aa7854be7861600024be5c56ab7875a` |
| FireRed Image Edit reserve source    | `FireRedTeam/FireRed-Image-Edit`           | `456d010bd3f9bd727f1ab7fe60838caf6ee479e6` |
| FireRed Image Edit 1.1 reserve model | `FireRedTeam/FireRed-Image-Edit-1.1`       | `3bc3f2a12722fd9883eb6357500de191d56baaf5` |
| SAM 3 source                         | `facebookresearch/sam3`                    | `660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7` |
| SAM 3 model                          | `facebook/sam3`                            | `3c879f39826c281e95690f02c7821c4de09afae7` |

Every input gets its own revision-named Volume and a `snapshot/` payload. The
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
