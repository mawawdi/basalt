# Basalt roadmap

Basalt follows five dependency-ordered milestones. Each milestone produces a
replayable artifact and a measurable gate; research prototypes and neural
workers remain outside the live map compiler.

## M1 — Deterministic mathematical core

- Add Q32.32 fixed-point keys at spatial-index boundaries.
- Specify the MurmurHash3 PRNG and IEEE-754 rounding profile for every seeded
  operation.
- Verify `TerrainFieldArtifact`, `PlacementSurfaceIndex`, exact triangle
  raycasts, route grades, and order-independent hashes.
- Keep content-addressed Merkle records in `.basalt/creator-graph`.

**Gate:** declaration order, platform locale, and repeated runs produce the
same field, surface, placement, and artifact hashes.

## M2 — Deterministic asset registry and canonical adapter

- Ingest CC0 or creator-owned sources offline into measured catalog records.
- Resolve explicit authored or generated family cohorts through strict
  taxonomy handles, Merkle family IDs, and hard rights, kind-admission,
  treatment-coverage, collision, and budget filters.
- Serialize a bounded compact `FamilyCard` palette menu and resolve Pass 2
  `WorldPlan` exploit bindings before any regional population work.
- Finish the asset-local adapter: UV unwrap/hotspot mapping, PBR baking,
  support/contact evidence, convex proxies, and RANSAC socket clipping.
- Bind shared quad-strip trim sheets and validate family style coherence.

**Gate:** accepted archetypes have canonical axes, budgets, support, collision,
PBR, trim, and socket evidence with no visible proxy fallback.

## M3 — Hierarchical world compiler

- Compile macro terrain, water tables, Priority-Flood drainage, material and
  biome fields.
- Build meso structures with Lloyd-relaxed Centroidal Voronoi cells and
  quantized joints.
- Populate micro detail with terrain-conditioned Poisson, cluster, path, and
  socket distributions.
- Enforce the 8-stud neural bound: large landmarks are procedural assemblies;
  neural geometry is limited to socketed focal inserts.

**Gate:** one region compiles from a brief to a coherent family population with
stable routes, support, clearance, and partition hashes.

## M4 — Runtime connector and engine streaming

- Emit chunked, bounded world transactions with optional ZSTD compression.
- Preserve detached preflight, ChangeHistory recording, commit, rollback, and
  host-sealed readback reconciliation.
- Lower terrain to voxel writes and accepted families to instanced MeshParts.
- Enforce mobile streaming residency, collision-proxy, and Jetsam budgets.

**Gate:** a creator can import, stream, save/reopen, and reconcile a temporary
partition build without hash drift or transaction corruption.

## M5 — Lagoon of the Basalt Spire acid test and cloud deployment

- Freeze the held-out coastal benchmark with lagoon, basalt spire shell,
  socketed focal insert, routes, repeated families, and seasonal overlays.
- Compare catalog/procedural, neural/procedural, and full peer portfolios under
  identical deterministic planning and budget rules.
- Run qualified offline family factories through the conservative Modal
  transport with exact receipts, cost ceilings, and warm-cache reuse.
- Publish only accepted artifacts and connector manifests; Studio evidence is
  creator-supplied and remains the final appearance authority.

**Gate:** the acid test passes visual, spatial, mobile-memory, cost, lineage,
and Studio import/play criteria without fixture-specific code in Basalt core.

## Current next slice

The deterministic compiler and connector contracts are implemented. The current
trusted-source slice materializes the starter archives under one bounded
`registry/starter-assets` root and declares 235 authored
cohorts (774 members, all sealed, 89 quarantined with reasons, 0
untriaged) with canonical taxonomy handles in
`registry/family-manifest.json`. Source folders mirror the
manifests one-to-one (one folder per declared family, undeclared sources under
`_pending/`); identity still comes from declarations and Merkle evidence, never
from paths. Structural measurement, Q32.32 normalization, texture
evidence, topology diagnostics, Merkle sealing, and collision companion pairing
run without model calls.

The palette/region slice is complete: per-record admission is stamped at
measure time (692 locally qualified, 171 incomplete, 0 pending among
measured) and enforced by both resolvers (187 of 235 families
retrievable); one shared 128-band trim sheet is authored from sealed
measurements and re-sealed (703 member mappings, 71 energy rejections, 0
pending trim hashes); `visual:catalog:palette` resolves a region brief to a
7-card palette menu with exploit bindings plus CLI registry/requests; the
`slice_bay` brief compiles to one partitioned region (28 instances, 4
connector chunks) whose emission passes transaction asserts and local
bridge enqueue; registry misses record explore requirements and queue
focal-insert factory batches (no model calls), and oversize misses fail
closed naming the procedural route. Unadmitted members stay out of
retrieval until their geometry or texture evidence is repaired.
Authorial grouping is never rejected at seal: kind coherence and
treatment coverage are recorded diagnostics (28 and 13 flagged
families), and only missing support evidence blocks.

The next evidence-producing task is RANSAC socket extraction and clipping
for the sealed cohorts, then region-aware route/road assembly, then the
creator-run Studio import/save/reopen capture of the compiled slice
region. Trim atlas texture bytes stay deferred until the Blender worker
can bake them under Studio evidence.
