# Reference-image qualification workers

This directory defines one fail-closed execution boundary for three pinned
composition candidates plus isolated-reference generation and segmentation:

- `Qwen/Qwen-Image-2512@25468b98e3276ca6700de15c6628e51b7de54a26`
  for isolated object references.
- `Qwen/Qwen-Image-Edit-2511@6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`
  for terrain-conditioned regional composition images.
- `black-forest-labs/FLUX.2-klein-4B@e7b7dc27f91deacad38e78976d1f2b499d76a294`
  as the fast Apache-2.0 regional-composition peer.
- `meituan-longcat/LongCat-Image-Edit@7b54ef423aa7854be7861600024be5c56ab7875a`
  as the Apache-2.0 preservation-focused regional-composition peer.
- `facebook/sam3@3c879f39826c281e95690f02c7821c4de09afae7`
  for text-prompted open-vocabulary instance masks.

The current files are qualification scaffolds. They make no model calls and do
not make any producer eligible. The dependency-free commands below are safe to
run in ordinary tests and allocate no GPU:

```sh
python3 workers/reference-image/modal_app.py --local-probe
python3 workers/reference-image/worker.py --local-probe
python3 workers/reference-image/worker.py --dry-run /absolute/path/request.json
python3 workers/reference-image/worker.py --replay \
  /absolute/path/request.json \
  /absolute/path/receipt.json \
  /absolute/path/output.png
```

Production execution uses an already-built immutable Modal Image ID and nine
revision-named persistent Volumes. Source and model mounts are read-only,
container concurrency and fleet size are both one, idle scale-down is 60
seconds, retries are disabled, network access and Modal resource access are
blocked, and no source is uploaded at function invocation time. The production
entrypoint also requires a two-sided execution-gate commitment. It currently
rejects before model loading by design.

Eligibility still requires all of the following evidence from the exact image:

1. Preload source and weights into revision-named Volumes outside inference.
2. Retain an exact model-file inventory and a hash of every weight byte.
3. Retain a dependency inventory, CycloneDX SBOM, and Python import trace.
4. Prove the import trace performs no download, network, or remote-code load.
5. Retain Apache 2.0 source/model terms and a commercial-use review.
6. Run deterministic output-contract probes for each route.
7. Bind successful output bytes to a `ReferenceImageWorkerReceipt` and reload
   every receipt dependency from the immutable artifact stores.
8. Qualify Qwen, FLUX, and LongCat on a separate matched three-seed suite, then
   spend exactly three production proposals per region/view cell. The initial
   allocation is one proposal from each active provider. Studio evidence is
   required for delivery truth, not for evaluation inference.

Inference must never install dependencies, download weights, use
`trust_remote_code`, or enable network egress. Updating code, dependencies,
weights, or a model revision requires a new runtime image and qualification.
