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
`catalog-authoring` owns non-authoritative model/embedding receipts, calibrated
prediction sets, substitution evidence, discovery review plans, acceptance
audits, qualification receipts, and the tracked catalog transaction root.
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

Labels, examples, translations, counterexamples, and search terms live outside
commitment hashes. Source folders, archive identities, and vendors are provenance
only. Original basenames may enter interpretation only through separately hashed
weak-hint artifacts; they cannot enter authority, grouping, or splitting. A task binds
the smallest closure of commitment and facet hashes it consumes. Adding an
unrelated sibling therefore does not invalidate existing catalog entries or
builds.

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
canonical source identity
  -> measured asset + orthogonal 12-view render channels
  -> basename-only weak hints for semantic hypotheses
  -> source-neutral physical leakage graph and whole-group split
  -> bounded, leakage-group-disjoint qualification pilot
  -> visual-only, name-only, and combined hypothesis receipts
  -> facet and dependency-group calibration against human references
  -> hierarchy-aware prediction sets, abstention, and novelty detection
  -> explicit pairwise substitution compatibility and whole-set proof
  -> non-statistical discovery review + independent random acceptance audit
  -> qualification receipt
  -> admitted assertions, entries, and dispositions
  -> tracked CatalogAuthorityCommit
```

The qualification machinery is implemented, but running strong encoders does not
qualify it. The current pilot uses pinned DINOv3 ViT-L normalized-depth features,
SigLIP2 So400M/384 RGB-text alignment, and a separately identified basename model.
One Modal GPU executes the two visual models sequentially; Modal is an execution
adapter and never appears in semantic or catalog authority. Missing human
reference judgments, insufficient Wilson precision bounds, novelty, dependency
failure, unresolved pair evidence, or missing acceptance-audit receipts leave the
result `incomplete`. Only genuine whole/aggregate substitution sets can be
automatically proposed. Assemblies, attachments, routes, socket-hosted assets,
and environment realizers still require their typed authoring contracts.

`registry/catalog.json` is the single replaceable transaction root, not a journal
or compatibility stream. It embeds all compiler authority and the sealed runtime
snapshot. Non-authoritative evidence that was expensive to produce is retained
under content-addressed `registry/evidence/` names, including the exact
measurement set needed by compilation. Unreferenced evidence is removed from the
live tree after atomic root publication; Git provides history. A stale root fails
`catalog validate --require-commit true`; `world compile` accepts the committed
root and its retained measurements rather than unrelated local state.

The statistical and evidence rationale is recorded in the
[catalog-admission research](research/catalog-admission-state-of-the-art.md); the
remaining human calibration and qualification work is ordered in the
[roadmap](ROADMAP.md#catalog-admission-qualification).

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

All extracted GLBs share the single canonical pool
`registry/source-assets/sha256/<aa>/<bb>/<content-hash>.glb`. Exact byte identity
is the only storage partition: duplicate files from different archives resolve to
one source identity. `registry/source-provenance.json` separately records every
origin and rights claim; `registry/source-manifest.json` contains only canonical
content identities, metric scale, and a source-neutral hash of the effective
rights claim. Adding another origin for identical bytes does not change the
manifest or compiler inputs.

Semantic hypothesis adapters receive one separately hashed, non-authoritative
`CatalogSourceNameHint` per content identity. It contains every distinct original
GLB basename plus deterministic normalized tokens; it contains no origin ID,
archive path, or directory. Extraction collision suffixes are excluded from the
normalized form. Multiple names are preserved rather than resolved by pack
precedence. These hints are weak supervision only: they cannot enter admitted
assertions, catalog declarations, runtime indices, or compiler requirements.

Calibration/evaluation split construction does not receive name hints. It is
partitioned by connected components of physical leakage evidence—exact content or
canonical geometry, component containment, and near-duplicate rendered shape—not
by the archive in which an asset happened to arrive. Shared texture payload bytes remain contextual
stratification evidence rather than identity edges because one common atlas can
serve thousands of unrelated objects. Equal default material parameters do not
count as shared payload evidence.

`CatalogNearDuplicateSearch` binds every compared source, the exact multiview
index, the all-pairs comparison count, descriptor-set hash, threshold, worker and
image-decoder implementation, and pair evidence. Its compact tracked manifest has
no compiler authority. `CatalogLeakageAnalysis` binds that search plus the exact
source manifest, measurement set, grouping policy, coverage flags, relation
evidence, and analysis implementation. `CatalogLeakageGroup` values are derived
as the deterministic transitive closure of the policy's identity-bearing
relations. Context relations remain in the analysis without collapsing the split.
`CatalogCalibrationSplit` binds that exact analysis and assigns whole groups—never
individual members—to development, calibration, or evaluation. The split stays
`incomplete` while any physical channel lacks population-wide coverage.

The local renderer and measurement runner import a single resource policy and
reject concurrency above four. The near-duplicate comparison is one bounded
process; later distributed scheduling must retain a per-host resource ceiling.

`AssetSemanticHypothesisRequest` binds the exact measurement, multiview render,
source-name hint, semantic module, and lexicon hashes. Receipts repeat and verify
those bindings. Filename/model disagreement remains visible to factorized
aggregation and may result in abstention or `incomplete`; no source-name token is
promoted directly into a concept, realization form, role, or substitution set.

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
