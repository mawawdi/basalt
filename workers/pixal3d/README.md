# Pixal3D qualification worker

This directory is an unregistered production-inference boundary for Pixal3D.
It pins source commit `f7cf38429b0bd264f1995f0f8743a88b1c728b94` and weights revision
`b0cb2e1b794cab9aa0ac38a95d794a4d9337437f`.

Both local probes are dependency-free and make no network, Modal, model, or GPU
calls:

```sh
python3 workers/pixal3d/worker.py --local-probe
python3 workers/pixal3d/modal_app.py --local-probe
```

Inference is deliberately absent. The official path imports background-removal
and rendering/export components and can download model files at runtime. A
production worker must instead load an exact pre-provisioned source tree,
weights snapshot, DINOv3 snapshot, and dependency lock; use caller-supplied RGBA
and camera calibration; and emit only the shared route-neutral safetensors
payload. Its retained SBOM and actual Python import trace must contain no RMBG,
`nvdiffrast`, `nvdiffrec`, official renderer, or official exporter. Network
egress, runtime downloads, and `trust_remote_code` remain denied.

The repository license, weights terms, DINOv3 terms, and all transitive terms
require separate retained commercial reviews. A successful technical probe
cannot substitute for those reviews or for Roblox Studio evidence. No Pixal3D
descriptor is included in the active asset-factory registry.
