# TRELLIS.2 qualification worker boundary

`worker.py` is the fail-closed route worker. Its dependency-free `--probe` and
`--dry-run` modes describe unavailable local execution. Its `--execute` mode is
the real qualification entry point for an isolated Linux/NVIDIA image.

Execution requires the pinned TRELLIS.2 checkout, the pinned TRELLIS.2 model
snapshot, the separately retained DINOv3 snapshot, one exact rights-bound RGBA
PNG, at least 40 GiB VRAM, and these runtime attestations:

- the container/network namespace has no egress and sets
  `BASALT_TRELLIS2_RUNTIME_EGRESS=denied`;
- the immutable source image sets
  `BASALT_TRELLIS2_SOURCE_COMMIT=75fbf0183001ed9876c8dbb35de6b68552ee08bd`;
- model files are already present; Hugging Face, Transformers, datasets, and
  diffusers all run in offline mode;
- the caller passes the expected SHA-256 of `worker.py`.

The model snapshot uses a fixed local layout. Its own checkpoints remain at
their paths from `pipeline.json`; the sparse-structure decoder from
`microsoft/TRELLIS-image-large` is mounted below
`external/microsoft/TRELLIS-image-large/`. The DINOv3 snapshot is a separate
local directory.

The worker bypasses the stock `from_pretrained` pipeline loader so it never
instantiates RMBG-2.0. It calls the pinned 1024 cascade with all three official
12-step parameter sets, samples the O-Voxel PBR field at mesh vertices, derives
normals, and writes only a route-neutral safetensors bundle plus a canonical
worker report. It does not load nvdiffrast/nvdiffrec, render previews, or invoke
the official GLB exporter. Basalt's common adaptation worker owns geometry
repair, decimation, UVs, texture baking, axes, support, collision, sockets, and
three-view previews.

The successful worker report is still research evidence. A host may turn it
into a `Trellis2ExecutionReceipt` only after checking the exact output bytes,
runtime image, dependency inventory, worker hash, qualification, and hardware.
The route remains absent from every product registry until commercial terms,
the fixed-worker probe, the three-prop pilot, and creator-run Studio evidence
all pass.

The qualification container binds TRELLIS.2 commit `75fbf0183001ed9876c8dbb35de6b68552ee08bd`, model revision `af44b45f2e35a493886929c6d786e563ec68364d`, the fixed 1024 cascade with 12 steps per stage, and at least 40 GiB of NVIDIA VRAM. It receives one read-only rights-bound RGBA8 PNG and writes one route-neutral safetensors mesh-attribute bundle.

GPU is an explicit qualification profile. Each hardware choice requires its own
hardware probe, runtime probe, and qualification hash. Select it before building
or invoking Modal:

```sh
export BASALT_TRELLIS2_GPU_PROFILE=l40s-48gb
python3 workers/trellis2/modal_app.py --local-probe
modal run --profile <profile> workers/trellis2/modal_hardware_probe.py
```

`a100-80gb` remains the default. `l40s-48gb` is the first cheaper candidate:
it satisfies the worker's 40 GiB minimum and should be used for the next
plumbing smoke, while the A100 remains the fallback for out-of-memory or
materially slower 1024 runs. A GPU profile change is never applied to an
existing receipt.

Runtime egress, downloads, and `trust_remote_code` are denied. RMBG-2.0, nvdiffrast, nvdiffrec, and the official exporter are excluded. No worker or descriptor is registered until dependency, terms, worker-probe, adaptation, and creator-run Studio evidence all pass the exact qualification contract.

## Modal boundary

Modal CLI `1.5.5` is the audited host client. Install and select an existing
profile without retaining credentials in this repository:

```sh
uv tool install modal==1.5.5
modal profile current --profile <profile>
modal token info --profile <profile>
```

Modal calls the command `modal run`; there is no `modal app run` command. The
dependency-free local contract probe neither imports Modal nor opens a remote
App:

```sh
python3 workers/trellis2/modal_app.py --local-probe
```

`modal_app.py` is a fail-closed future inference boundary. It accepts only a
previously built Modal Image by exact `im-...` ID, mounts stable seal-verified model
Volumes read-only, scales to zero, permits one container, uses no retries,
allows one input per container, caps the function at 180 seconds, and denies
both network egress and Modal resource access inside the function. The
serialized function contains its entire implementation and therefore needs no
repository source mount. It reads Modal's reserved `MODAL_IMAGE_ID` inside the
container and requires that exact ID plus the runtime-manifest hash in the
generation request, worker report, qualification, and retained handoff.
Safetensors are capped at 2 GiB and retained in the output Volume. The Modal
function returns only a small hashed handoff, keeping the serialized response
independent of mesh size.

The paid execution gate is distinct from the Modal account token. Store it in
a Modal Secret named `basalt-trellis2-execution-gate` and in a local file or
credential manager outside the checkout. If using the CLI, prefer
`modal secret create --from-dotenv <absolute-path-outside-repository>` so the
value is not put in a repository file. The host sends only the gate's SHA-256
commitment to the function; the plaintext remains in the local process and the
Modal Secret environment.

The isolated hardware smoke entry point mounts no custom Image, Volume,
Secret, or repository file. Running it without the exact literal takes the
zero-invocation branch:

```sh
modal run --profile <profile> workers/trellis2/modal_hardware_probe.py
```

The one reviewed paid invocation uses this explicit literal (the literal is
profile-derived; the default A100 value is shown here):

```sh
modal run --profile <profile> workers/trellis2/modal_hardware_probe.py \
  --execution-flag RUN_ONE_BASALT_TRELLIS2_A100_80GB_HARDWARE_PROBE
```

The exact TRELLIS.2, sparse-decoder, and approved DINOv3 snapshots are sealed
in stable Volumes and mounted read-only. Their retained snapshot hashes, not
their operational paths, identify the bytes. The `basalt-neural-output`
Volume and the separate paid-run gate Secret are the intended output boundary.
There is no currently qualified runtime image for the rewritten worker bytes.
Evaluation execution remains blocked on a complete runtime qualification, one
rights-bound RGBA input, and the common finishing spine. Product admission also
requires the measured pilot, commercial review, and creator-run Studio evidence.
Modal Volumes are mutable storage; retained content seals, rather than names,
are the evidence identities.

Once those gates close, the reviewed shape of a single run is:

```sh
BASALT_TRELLIS2_MODAL_IMAGE_ID=<exact-im-id> \
modal run --profile <profile> workers/trellis2/modal_app.py \
  --request <canonical-request.json> \
  --runtime-qualification <canonical-runtime-qualification.json> \
  --reference <rights-bound-rgba.png> \
  --output-root <existing-output-directory> \
  --execution-flag RUN_ONE_QUALIFIED_BASALT_TRELLIS2_ASSET
```

The local entry point creates one absent directory named by the request hash
and writes an `attempt-claim.json` before it makes the paid remote call. The
worker writes the tensor and report under the same attempt key in the shared
`basalt-neural-output` Volume and returns only a small hashed manifest. The host
then copies and verifies those exact bytes into the claimed local directory. That
claim is retained if the remote outcome is uncertain, so repeating the same
command fails before allocating another GPU. After a completed call the
directory also contains `candidate.safetensors`, `worker-result.json`, and
`modal-handoff.json`. Basalt then admits those bytes through
`retainTrellis2WorkerCandidate`; neither the small Modal response nor unverified
Volume contents become a catalog asset directly.

Retry the exact request only after inspecting the claimed attempt and choosing
a fresh 16-to-64-character lowercase hexadecimal identifier:

```sh
BASALT_TRELLIS2_MODAL_IMAGE_ID=<exact-im-id> \
modal run --profile <profile> workers/trellis2/modal_app.py \
  --request <canonical-request.json> \
  --runtime-qualification <canonical-runtime-qualification.json> \
  --reference <rights-bound-rgba.png> \
  --output-root <existing-output-directory> \
  --execution-flag RUN_ONE_QUALIFIED_BASALT_TRELLIS2_ASSET \
  --new-attempt-override <fresh-hex-identifier>
```

Each override claims a separate immutable attempt directory. It is an explicit
authorization to incur another run for the same request; an empty or reused
override fails closed.

Official references: [Modal GPU configuration](https://modal.com/docs/guide/gpu),
[restricted functions](https://modal.com/docs/guide/restricted-functions),
[runtime environment variables](https://modal.com/docs/guide/environment_variables),
[function scaling](https://modal.com/docs/guide/scale),
[Volumes](https://modal.com/docs/guide/volumes), and
[`modal.Image.from_id`](https://modal.com/docs/reference/modal.Image).
