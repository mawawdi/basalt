# Research Never Tells the Compiler What to Do

Research notes explain decisions; they are not runtime authority. The implemented
contracts in `ARCHITECTURE.md` and the sealed registry win if rationale ever drifts.

## Current rationale

- [Deterministic population placement](research/population-placement.md) — bounded candidate
  replenishment and measured-occupancy pruning for clusters and surface scatters.
- [World construction and refinement](research/world-construction-and-refinement.md) —
  non-authoritative walkthrough of a 40-square-kilometer world request, procedural and
  neural tower construction, and the proposed integration with bounded refinement.
- [Catalog search and architecture assessment](research/catalog-search-assessment.md) —
  non-authoritative audit of selection results, model costs, evaluation design, and
  proposed changes connecting asset discovery to world generation.
- [Catalog support measurement](research/catalog-support-measurement.md) — root-cause audit,
  established mesh-contact baseline, bounded pilot, and full-corpus result for planar and
  lower-extrema support evidence.
- [Catalog qualification authoring](research/catalog-qualification-authoring.md) — annotation,
  retrieval-pooling, and heterogeneous-query baselines plus the content-bound Basalt review gate.
- [Roblox glTF upload color adaptation](research/roblox-gltf-upload-colors.md) — importer-color
  root cause, standards baseline, deterministic payload rule, and affected/control pilot.
- [Basalt and existing world-generation systems](research/world-generation-reuse.md) —
  non-authoritative build-versus-reuse assessment, implementation evidence, and proposed
  integration experiments.
- [Semantic kernel rationale and governance](research/basalt-semantic-kernel.md) — stable
  upper sorts, orthogonal facets, immutable commitments, and closure-local invalidation.

The first two assessments are immutable research snapshots. Their historical references
describe the repository state they inspected; active documents and sealed contracts remain
authoritative. The world-generation assessment is retained as cited foundation research,
while its operating recommendations are superseded by those two newer assessments.

The compact [catalog selection evidence record](research/evidence/catalog-search-selection-2026-09-14.json)
preserves the retired benchmark's artifact identities, reproduced results, model commits,
and limitations. It is inert research evidence, not a live fixture or compatibility path.

## Preserved source surveys

- [WorldClaw](sources/world-claw.md) — long-horizon hierarchical world-generation source
  context.
- [Roblox terrain capability survey](sources/roblox-terrain.md) — dated platform evidence
  supporting terrain lowering decisions.
- [Roblox world-presentation baseline](sources/roblox-world-presentation.md) — official
  Lighting, Atmosphere, and post-processing primitives reused by the transactional adapter.

## Current conclusions

- A durable semantic kernel and an open-vocabulary search layer solve different problems:
  search discovers candidates; admitted assertions authorize compilation.
- Multiview factual metadata plus BM25 and SigLIP2 scales to nouns outside the kernel
  without inventing concepts.
- DINOv3 supports reference-shape retrieval, not semantic authority.
- Basenames are weak auditable hints; pack, archive, and directory identity are excluded
  from inference and ranking.
- Deterministic measurement, rights, interfaces, topology, placement, and admission gates
  decide what the compiler may use.
- Neural generation is an offline catalog-factory route after a typed gap and returns to
  the normal evidence pipeline.
- Remote CAS distribution is deferred until local contracts and corpus evidence are
  stable.
