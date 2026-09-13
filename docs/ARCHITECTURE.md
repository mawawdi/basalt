# Architecture

This document is the authority for Basalt’s implemented architecture. Product
invariants, visual/admission policy, evaluation claims, and future work have
separate owners in the [documentation map](README.md).

## Authority flow

```text
creator intent + SemanticLexiconSnapshot
  -> hypothesis-only interpretation trace
  -> admitted SemanticAssertionBundle values
  -> SemanticDependencyClosure values
  -> immutable SpatialWorldPlan
  -> CompiledWorldFoundation
  -> CatalogResolutionPlan
  -> MesoLayout
  -> MicroRealization
  -> WorldBuild
  -> packages/roblox
```

The compiler never edits a parsed plan. Terrain fields, road assemblies, lots,
constructed surfaces, rooms, portals, and realized instances are derived artifacts
bound to exact predecessor hashes.

## Package graph

The repository is an npm workspace with one manifest and one TypeScript composite
project per package. Imports use package exports; cross-package relative source
imports and internal deep imports are rejected.

| Layer                 | Packages                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Foundations           | `contracts`, `artifact-store`, `spatial-core`                                              |
| Semantics and catalog | `semantic-kernel`, `catalog-model`, `catalog-authoring`                                    |
| Asset pipeline        | `asset-inspection`, `asset-production`, `asset-factory`, `neural-asset`, `reference-image` |
| Planning and compiler | `authoring-graph`, `world-planning`, `region-composition`, `world-compiler`                |
| Adapter and operator  | `roblox`, `cli`                                                                            |

`semantic-kernel` alone owns commitments, facets, assertions, requirements,
closures, and the lexicon contract. `catalog-model` owns measured assets,
dispositions, entry declarations, resolution requirements, and typed gaps.
`catalog-authoring` owns non-authoritative model/embedding receipts, hypothesis
panels, admission cohorts, sampled review plans, explicit curator decisions,
audits, and the tracked catalog transaction root.
Provider names never enter semantic, catalog, planning, or world identities.

All generic geometry is right-handed, positive-Y-up, and measured in meters.
Q32.32 catalog measurements are meters. The stud conversion and four-stud terrain
voxel rule exist only in `roblox`.

## Semantics

The kernel freezes seven upper sorts: object, aggregate, substance, space,
boundary, phenomenon, and information content. Denotation, affordance, state,
surface treatment, contextual role, relation, and realization form are separate
facets. Runtime reasoning is intentionally bounded to exact commitments,
materialized ancestry, set inclusion, state equality, evidence ordering, and
declared inverse or symmetric relations.

Labels, examples, translations, counterexamples, search terms, filenames, and
source folders live outside commitment hashes. A task binds the smallest closure
of commitment and facet hashes it consumes. Adding an unrelated sibling therefore
does not invalidate existing catalog entries or builds.

## Catalog and realization

`CatalogAssetArtifact` is semantic-free measured evidence. A disposition separately
records whether a source identity is eligible, incomplete, or rejected. Runtime
entry kinds are substitution sets, assembly kits, attachment sets, route kits, and
environment realizers. Collections are authoring-only.

A substitution set means complete independent substitutability: every member must
prove the same denotation, realization form, fixed state, affordances, treatments,
placement/contact signature, interfaces, metric envelope, rights, and style
contract. Collision companions remain evidence attached to renderable assets.

Resolution performs hard filtering before deterministic lexicographic ranking.
Missing candidates become typed semantic, evidence, or catalog gaps. Member
weights are canonical integers and affect hash-seeded selection.

### Current admission implementation

Catalog admission deliberately separates inference, review, and authority:

```text
measured asset + 12-view render
  -> independent semantic hypothesis receipts
  -> exact-signature panel consensus
  -> visual-embedding complete-link cohorts
  -> medoid, outlier, boundary, and deterministic audit samples
  -> explicit finite-cohort decision
  -> admitted assertions, entries, and dispositions
  -> tracked CatalogAuthorityCommit
```

This is the executable baseline, not a claim that unattended corpus admission is
qualified. The panel requires distinct adapter/model implementation hashes and
ignores confidence when voting, but it does not yet establish statistical error
independence or pack-shift robustness. A source without semantic consensus or an
exact visual embedding remains an exception; it is never forced into a nearby
cohort. Cohort materialization automates only genuine whole/aggregate substitution
sets with measured ground, wall, or ceiling support. Assemblies, attachments,
routes, socket-hosted assets, and environment realizers still require their typed
authoring contracts.

`registry/catalog.json` is the single replaceable transaction root, not a journal
or compatibility stream. It embeds all compiler authority and the sealed runtime
snapshot. Non-authoritative evidence that was expensive to produce is retained
under content-addressed `registry/evidence/` names, including the exact
measurement set needed by compilation. Unreferenced evidence is removed from the
live tree after atomic root publication; Git provides history. A stale root fails
`catalog validate --require-commit true`; `world compile` accepts the committed
root and its retained measurements rather than unrelated local state.

The stronger admission policy is intentionally not described here as current
behavior. Its evidence basis is recorded in the
[catalog-admission research](research/catalog-admission-state-of-the-art.md), and
the unimplemented cutover is ordered in the [roadmap](ROADMAP.md#catalog-admission-cutover).

## Storage and recovery

The current storage boundary is local-first and has two distinct classes:

- Tracked authority consists of `registry/semantics/`, `registry/catalog.json`,
  authored declarations and decisions, and content-addressed compact JSON under
  `registry/evidence/`. `catalog commit` atomically replaces the one current root;
  Git supplies history.
- Bulk payloads consist of source archives, source GLBs, generated RGB/depth/mask
  frames, point samples, and future embedding buffers. They are identified by
  cryptographic hashes but remain in ignored local roots such as the source asset
  tree and `.basalt/` working state.

Local reads and writes use bounded, no-follow, hash-checked artifact-store
primitives where wired into a pipeline. The catalog does not currently have a
remote CAS transport, replication guarantee, retention service, or garbage
collector. A clean clone therefore recovers semantic and catalog authority plus
retained JSON evidence, but not every bulk payload. Do not delete the local source
or render corpus on the assumption that Git can restore it.

Remote replication is deliberately deferred. It is a future durability layer,
not a prerequisite silently embedded in current catalog semantics; see
[Deferred infrastructure](ROADMAP.md#deferred-infrastructure).

### Catalog fulfillment

`asset-factory` turns one exact resolution outcome into a content-addressed
`CatalogFulfillmentPlan`. The decision cascade is:

```text
coherent binding -> reuse
style-only mismatch -> restyle retained geometry
incomplete substitution set -> generate missing members
no matching substitution set -> synthesize a new set
```

Neural generation is offline catalog acquisition, never a compiler fallback.
Semantic and evidence gaps require authoring decisions; attachment, assembly,
route, and environment gaps require their typed host, grammar, topology, or mode
contracts before generation. A provider receives one exact factory job,
reference-image identity, semantic closure, style profile, metric target, and
immutable paid-attempt claim. Provider names and runtime transports exist only in
`neural-asset` and worker adapters.

TRELLIS.2 has a restored executable worker and a typed host-to-worker lowering.
Its raw safetensors positions are explicitly provider-normalized and carry a
source-to-canonical orientation transform; they do not claim meters. Pixal3D and
Hunyuan3D 2.1 retain their original fail-closed qualification scaffolds but have
no inference implementation yet. All three routes remain `incomplete` until exact
worker/runtime/dependency/rights evidence is requalified. Provider output passes
generic finishing, measurement, rendering, hypothesis review, assertion
admission, and catalog sealing before the resolver can see it.

The spatial compiler owns full transformed bounds, occupancy, routes, lots, typed
intents, and the deterministic AC-3/backtracking solver. Models cannot author
transforms or executable engine code. Unknown regions, routes, surfaces, normals,
or structural targets are rejected at the plan boundary.

## Artifact graph

`CompilationTaskResult` describes world, region, route, lot, structure, floor, and
room scopes. It binds exact inputs, policy, outputs, status, resources, and
diagnostics. The executor is local and bounded. Durable or distributed execution
is not implemented; the artifact contracts keep that future concern out of core
compiler semantics.

## Roblox boundary

`WorldBuild` is the one engine adapter boundary. Basalt does not define a generic
adapter abstraction before a second adapter exists.

The Roblox import service binds to `127.0.0.1`, holds an exclusive workspace lock,
selects the first free port from 8787–8797, bounds request bodies, and validates a
private bearer token in constant time. Only `/health` is unauthenticated, and it
contains no credential or world data. Workspace reads reject links and escaping
paths; writes are bounded, hash-guarded, and atomic.

The plugin auto-discovers the service and executes preflight, foundation, meso,
micro, readback, and commit without per-stage clicks. Foundation lowering converts
height fields to Roblox’s 1.12-meter voxel grid, retains the original voxel channels,
and restores them on cancellation or failure. Readback checks terrain channels,
route hashes, exact bound assets and material/PBR fields, assembly components,
constructed surfaces, room bindings, portal opening poses, procedural stair
geometry, and the complete world-build identity before returning the host-sealed
observed-state hash. Only a successful creator-run readback can support
`engine_verified` evidence.
