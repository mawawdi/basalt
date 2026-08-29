# Hunyuan3D 2.1 research worker

This directory defines Basalt's research-only Hunyuan3D 2.1 boundary. It pins
official source commit `82920d643c0dc2f7bfd7255f45f62d386edfe60c` and model
revision `0b94677654c57bb9a6b6845cd7b704ccf551d327`.

The local probe is dependency-free and makes no network, Modal, model, or GPU
calls:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 workers/hunyuan3d/worker.py --local-probe
```

Inference is intentionally absent in this worker revision. A runnable research
worker must use pre-provisioned immutable source, model, dependency, and native
extension inventories; accept a caller-supplied rights-bound RGBA image; disable
background removal, downloads, egress, `trust_remote_code`, and the native
exporter; and emit only `basalt-mesh-attribute-tensor-bundle@2`. Basalt's common
adaptation worker remains responsible for transforms, normals, UVs, decimation,
PBR baking, support, collision, previews, and Roblox delivery budgets.

The Tencent Hunyuan 3D 2.1 Community License is retained with every trial. Basalt
allows these artifacts in internal research comparisons while marking their
model/source claims `research_only`. They cannot enter a production asset
factory registry, become a `PreparedAsset`, or support commercial or Studio
release evidence. Buffalo 1.0 stays pending because Tencent has not published a
runnable official source-and-weights artifact at the pinned project revision.
