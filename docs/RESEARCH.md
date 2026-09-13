# Research Index

Everything indexed here is non-authoritative. Implemented truth and document
ownership are defined by the [documentation map](README.md); accepted mechanics
must be reflected in the relevant active document before code relies on them.

## Current rationale

- [Semantic kernel rationale](research/basalt-semantic-kernel.md) explains the
  identity, facet, closure, and governance decisions behind the implemented
  registry. The registry and [Architecture](ARCHITECTURE.md) remain authoritative.
- [Catalog admission research](research/catalog-admission-state-of-the-art.md)
  records the evidence design behind the implemented bounded qualification pilot:
  calibrated multimodal prediction, explicit substitution proofs, discovery
  review, and independent risk-bounded acceptance audits. Its remote-storage
  analysis is retained as a future option; the accepted current decision is
  local-only storage.
- [Roblox asset lowering](research/mesh-strategy.md) records platform-specific mesh,
  material, and performance rationale. The implemented adapter boundary is owned by
  [Architecture](ARCHITECTURE.md#roblox-boundary).

## Provider implementation notes

- [TRELLIS.2 worker](../workers/trellis2/README.md)
- [Hunyuan3D 2.1 worker](../workers/hunyuan3d/README.md)
- [Pixal3D worker](../workers/pixal3d/README.md)

These describe offline adapters and qualification limits. Provider documentation
cannot grant catalog admission or compiler authority.

## Preserved sources

- [WorldClaw](sources/world-claw.md) is broad inspiration for hierarchical world
  decomposition, not an instruction set or Basalt design specification.
- [Roblox terrain survey](sources/roblox-terrain.md) records dated platform facts
  and opportunities. Current lowering behavior remains owned by Architecture.
