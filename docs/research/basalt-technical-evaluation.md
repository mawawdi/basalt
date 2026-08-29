# Basalt technical evaluation

**Status:** current reference specification. This document defines the
mathematical, economic, and device-budget gates for the hierarchical world
compiler. It does not grant visual or Studio acceptance by itself.

## Determinism and unit economics

All spatial indices use signed Q32.32 fixed-point coordinates at their storage
boundary. Floating point is permitted inside a worker only when the worker
records its IEEE-754 profile and rounds at the declared boundary. Seeds use a
specified MurmurHash3 finalizer and never depend on declaration order, locale,
thread scheduling, or provider availability. Content-addressed Merkle records
bind the normalized plan, worker identity, dependency hashes, and output bytes.

The unit of paid work is a family archetype or a regional proposal. A map does
not make one model call per instance. Catalog ingestion is linear in source
count, family retrieval is bounded by indexed postings, and population is a
deterministic spatial pass over accepted family handles. Warm builds must make
zero model calls and reuse byte-identical artifacts.

## Device and streaming gates

Roblox delivery is partitioned before emission. Each chunk has an explicit
triangle, instance, collision, texture, and compressed-payload budget. Mobile
validation treats the device memory ceiling as a hard gate: a build must remain
below the declared Jetsam envelope with terrain, collision proxies, textures,
and streaming residency counted together. A chunk that cannot satisfy its
budget is split or marked `incomplete`; it is never silently downsampled into
an unrelated visual result.

The connector writes bounded transactions with detached preflight, ChangeHistory
recording, commit, rollback, and host-sealed readback. ZSTD compression and
instanced MeshPart lowering are transport concerns; they cannot change the
world-plan or population hashes.

## Acid test: Lagoon of the Basalt Spire

The benchmark is a held-out coastal world containing a navigable lagoon, a
basalt spire landmark, layered shore and cliff regions, repeated modular
structures, ordinary scatter, and at least one sub-8-stud focal insert. The
same plan must produce identical terrain, routes, family choices, placements,
and chunk hashes across declaration permutations and repeated cold/warm runs.

Acceptance requires:

- no terrain seams, floating, penetration, wrong orientation, route blockage,
  or unbounded collision proxy;
- a spire assembled from typed shell modules and socketed inserts rather than
  one-shot large neural geometry;
- seasonal overlays that preserve the exact terrain-field hash while changing
  material, foliage, lighting, and atmosphere;
- mobile chunk budgets and streaming readback pass on the declared target
  profile; and
- no hidden catalog bytes, cache hits, or model calls in a pack-free run.

The benchmark is evidence for the roadmap. It does not become fixture-specific
vocabulary in generic packages and it cannot certify Studio appearance until a
creator supplies the authoritative Studio import and play observations.
