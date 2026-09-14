# Basalt documentation

These documents describe the one implemented baseline. They are not a journal and do
not retain superseded contracts, command names, migrations, or compatibility paths.

## Authority map

- [ARCHITECTURE.md](ARCHITECTURE.md) — package boundaries, artifact flow, and runtime
  architecture.
- [BASALT.md](BASALT.md) — product thesis and non-negotiable invariants.
- [VISUALS.md](VISUALS.md) — art direction, asset evidence, metadata, search, and visual
  realization.
- [EVALS.md](EVALS.md) — gate statuses, evidence levels, benchmark design, and claims.
- [RESEARCH.md](RESEARCH.md) — current research rationale and source index.
- [TASKS.md](../TASKS.md) — the only future-work and status authority.

Tracked JSON is authoritative where a document names a registry contract. In
particular, semantic authority lives under `registry/semantics`, catalog authority is
rooted at `registry/catalog.json`, and qualified corpus search evidence is rooted at
`registry/catalog-search.json`. Before corpus enrichment, progressive local search uses
the rebuildable index at `.basalt/catalog/search/index.json`.

## Reading order

Read `BASALT.md`, then `ARCHITECTURE.md`. Read `VISUALS.md` for catalog work and
`EVALS.md` before making or interpreting quality claims. Read `TASKS.md` for work that
is not yet implemented.

## Documentation rules

- A current contract is described once and linked elsewhere.
- Content hashes are identity and provenance, not schema editions.
- External standards may name their own formats; Basalt-owned protocols are
  unversioned.
- Research notes must declare their status and must not silently override implemented
  architecture.
- `TASKS.md` is the only active backlog and work-status authority. Historical research
  may retain recommendations, and evaluation documents may define acceptance protocols.
- Generated `.basalt` state is rebuildable and is not documentation authority.
