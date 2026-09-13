# Basalt Product Thesis

Basalt is a hierarchical world compiler, not prompt-to-mesh generation and not a
thin model wrapper. Its product is a closed verification loop: creator intent is
interpreted, semantic claims are admitted or refused, deterministic systems realize
them, and evidence explains each result.

This document owns the product thesis and invariants only. Implemented mechanics
live in [Architecture](ARCHITECTURE.md), and unfinished work lives in the
[Roadmap](ROADMAP.md).

## Invariants

- Creator intent, model hypotheses, semantic authority, platform policy, and
  evaluation evidence are distinct.
- Seven upper sorts are stable. Domain growth is additive through explicitly
  reviewed leaf commitments.
- A new asset pack cannot rewrite existing semantic commitments.
- Labels and source names can help a reviewer search; they cannot satisfy compiler
  requirements.
- Substitution means genuine independent interchangeability, not similar naming or
  visual proximity.
- Corpus scale comes from evidence-coherent cohort decisions and active audit
  samples, never from converting model confidence into authority or requiring one
  manual decision per asset.
- Terrain and routes compile even when catalog-dependent stages are incomplete.
- Typed solvers own geometry, transforms, constraints, occupancy, and budgets.
- Every missing requirement remains visible as `incomplete`; invalid evidence is
  `rejected`.
- `WorldBuild` is engine-neutral and retains exact semantic, catalog, asset,
  transform, bounds, connection, and evidence provenance.
- Only creator-run engine readback earns `engine_verified` evidence.

## Scaling model

World, region, route, lot, structure, floor, and room are independently nameable
compilation scopes. Minimal semantic closures and content-addressed children limit
invalidation. The same catalog entry may satisfy several independent intents
without merging their targets, quantities, or constraints.

Neural generation is an offline response to a typed catalog gap. It can produce a
candidate under provider-neutral measurable constraints, but it cannot create
concepts, decide substitution membership, author structural grammar, bypass
measurement, or admit itself.

Catalog authority has one tracked, atomically replaced root. Git preserves its
history; Basalt does not maintain schema streams or an internal decision journal.
Compact authority and evidence are commit-ready. Bulk source and render payloads
are content-identified but local-only in the current baseline; this is an explicit
recovery limitation, not an implied remote durability guarantee.
