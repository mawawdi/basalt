# Documentation Authority

This page owns the documentation map. Basalt has one current design; research
notes explain decisions and the roadmap records work that does not exist yet.

## Current authority

| Document                        | Sole responsibility                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Architecture](ARCHITECTURE.md) | Implemented package boundaries, artifact flow, compiler behavior, storage, and Roblox boundary |
| [Product thesis](BASALT.md)     | Product definition and non-negotiable invariants                                               |
| [Visuals](VISUALS.md)           | Catalog entry meaning, visual/physical evidence, admission policy, style, and placement        |
| [Evaluations](EVALS.md)         | Gate semantics, evidence levels, automated claims, and creator-run gates                       |
| [Roadmap](ROADMAP.md)           | Unimplemented work, ordered milestones, and known limits                                       |
| [Research index](RESEARCH.md)   | Non-authoritative rationale and external source material                                       |

The tracked semantic registry under `registry/semantics/` and the public schemas
in `packages/` are executable authority. When they and an active document
disagree, that is a documentation defect to fix; a research note never overrides
either one.

## Status rules

- `README.md` is an entry point and command reference, not a second architecture.
- Current behavior belongs in the active owner above.
- Future behavior belongs only in the roadmap. Active documents may name a known
  limitation, but must link to the roadmap instead of presenting a proposal as
  implemented.
- Files under `docs/research/` are rationale and recommendations. Files under
  `docs/sources/` are preserved source surveys. Neither directory is compiler or
  product authority.
- Superseded proposals are deleted after their accepted decisions are represented
  by the current owner. Git is the archive.
- Basalt has one unversioned contract. Documentation must not preserve removed
  schemas, commands, package names, or compatibility paths.

## Current storage decision

Catalog authority and compact evidence are commit-ready in Git. Bulk source and
render payloads are content-identified but local-only. Basalt has no configured
remote content-addressed store and makes no clean-clone recovery claim for those
payloads. See [Architecture: storage and recovery](ARCHITECTURE.md#storage-and-recovery)
for the exact implemented boundary; remote replication remains deferred in the
[roadmap](ROADMAP.md#deferred-infrastructure).
