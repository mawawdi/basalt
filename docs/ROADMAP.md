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
- Keep content-addressed Merkle records in `.basalt/creator-graph-v1`.

**Gate:** declaration order, platform locale, and repeated runs produce the
same field, surface, placement, and artifact hashes.

## M2 — Asset family registry and canonical adapter

- Ingest CC0 or creator-owned sources offline into measured catalog records.
- Resolve bounded families through inverted postings and hard physical filters.
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

The deterministic compiler and connector contracts are implemented. The next
evidence-producing task is to ingest a real `.basalt/trusted-sources` family
manifest, compile a partitioned region, and lower accepted geometry through the
connector. Neural inference can then fill only missing sub-8-stud family slots.
