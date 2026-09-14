# Architecture

Basalt is a content-addressed, hierarchical world compiler. Learned systems interpret
and propose; sealed contracts and deterministic solvers decide what becomes a world.
The engine-neutral result is a `WorldBuild`. Roblox-specific behavior begins only after
that boundary.

## Compiler flow

```text
creator intent + semantic lexicon
  -> IntentInterpretationTrace and semantic hypotheses
  -> admitted assertions and minimal semantic closures
  -> immutable SpatialWorldPlan (meters, right-handed, +Y up)
  -> CompiledWorldFoundation (terrain, routes, regions, surfaces)
  -> CatalogResolutionPlan (exact bindings or typed gaps)
  -> MesoLayout (lots, structures, rooms, portals)
  -> MicroRealization (instances, attachments, environment)
  -> sealed WorldBuild
  -> Roblox lowering, sequential import, authoritative readback
```

Every artifact binds its exact predecessors by cryptographic hash. Derived roadbeds,
surfaces, placements, and solver evidence live in successor artifacts; a parsed plan is
never mutated. Region and structural subtrees are independently hashable so unrelated
changes do not invalidate the entire world.

Every gate returns exactly one of:

- `eligible`: all required claims are satisfied.
- `incomplete`: the request is valid, but evidence, an asset, or a solver result is
  missing.
- `rejected`: an input or evidence item violates a contract or policy.

No fallback promotes `incomplete` or `rejected` to success.

## Package dependency direction

```text
contracts, artifact-store, spatial-core
  -> semantic-kernel, catalog-model
  -> catalog-authoring and asset packages
  -> world-planning, region-composition
  -> world-compiler
  -> world-refinement and roblox
  -> cli
```

Workspaces have package manifests, explicit exports, and TypeScript project references.
Architecture checks reject undeclared dependencies, source-deep imports, fixture leakage,
and engine imports in generic packages.

### Foundations

- `@basalt/contracts` owns hashes, stable serialization, IDs, diagnostics, and gate
  contracts.
- `@basalt/artifact-store` owns bounded no-follow workspace I/O, atomic replacement,
  locks, and the immutable local binary store.
- `@basalt/spatial-core` owns vectors, transforms, fixed-point math, bounds, occupancy,
  and deterministic constraint primitives.

### Semantics and catalog

- `@basalt/semantic-kernel` is the sole owner of semantic commitments, seven upper
  sorts, facets, relations, roles, lexicon records, assertions, requirements, and
  minimal dependency closures.
- `@basalt/catalog-model` owns semantic-free measurements, dispositions, catalog entry
  declarations, requirements, exact resolution bindings, typed gaps, and snapshots.
- `@basalt/catalog-authoring` owns non-authoritative review material: render evidence,
  source-name hints, open-vocabulary metadata, embeddings, hybrid search, validator
  receipts, contextual assembly hypotheses, qualification evidence, leakage grouping,
  and audits.

Search artifacts and catalog authority are separate roots. Refreshing a caption or an
embedding cannot invalidate a compiled world.

### Asset pipeline

- `asset-inspection` and `asset-production` measure and finish generic assets.
- `asset-factory`, `reference-image`, and `neural-asset` implement provider-neutral,
  offline catalog-gap fulfillment.
- Neural output always re-enters measurement, rendering, review, and admission. It may
  not author concepts, assertions, entry semantics, or substitution membership.

### Planning and compilation

- `world-planning` owns plans and interpretation traces.
- `region-composition` owns generic regional composition policies.
- `world-compiler` realizes foundation, catalog bindings, meso structure, micro detail,
  and the sealed `WorldBuild` using meters only.
- `world-refinement` consumes a compiler and exact world observations. It may propose only
  policy-whitelisted parameter or route changes, recompiles the affected dependency
  closure, and reports executed versus reused tasks.

Terrain and routes remain compilable when catalog-dependent stages are incomplete.
Structural grammars use explicit component roles, interfaces, topology, pitch, and
coverage. Bounds or filenames never infer structural meaning.

## Declarative construction

A sealed `ConstructionProgram` is a bounded graph of parameters and fixed operations:
boxes, vertical cylinders, linear repetition, rectangular panel openings, surface
attachments, and stair runs. Values are literals or affine bindings to declared scalar
parameters; repeat counts may bind integer parameters. Programs also bind a region,
semantic closure, style profile, placement-surface or region-point anchor, and local
quarter-turn frame.

Sealing validates every reference, parameter use, host/child relationship, template,
opening host, landing, and dependency cycle. There is no arbitrary expression evaluator,
callback, or generated script. Changing the observation tower's height or width therefore
updates its supports, platform, rails, opening, and stairs by changing those two parameters
alone.

The compiler realizes programs as `ConstructedStructureArtifact` values containing exact
primitive elements, surfaces, openings, portals, attachments, access paths, occupancy
reservations, bounds, and evidence. Constructed geometry remains distinct from catalog
instances and assembly-kit components, but both contribute complete extents to
`MesoLayout`, `WorldBuild`, chunking, and task hashes. Unsupported operations fail with a
typed lowering gap at an engine boundary.

## Coordinated route and terrain construction

A route declaration separates horizontal alignment, bend radius, elevation controls,
appearance, and construction treatment. The four treatments have different authority:

- `follow_surface` follows relief within explicit grade, cut, fill, and grounding bounds;
- `cut_fill` designs a smooth control-point profile and grades a roadbed plus shoulders;
- `elevated` preserves terrain and emits a deck with measured supports; and
- `stepped` emits bounded treads and landings instead of disguising an infeasible slope.

Foundation compilation seals authored terrain first as a `BaseTerrainFieldArtifact`. It
then replaces control-polyline corners with radius-constrained tangent arcs, samples one
resolved centerline, solves its vertical profile, and emits exact travel spans, bend
evidence, supports, material masks, vegetation masks, and terrain treatment. Ordinary bend
spans are angle-bounded to five degrees and receive sealed miter extensions so fixed native
rectangles close their outside edge instead of exposing triangular seams. Smooth cut/fill
and elevated profiles are adaptively refined to at most one degree of pitch deflection;
every ordinary pitch change receives a sealed full-depth profile miter. Terrain-following
profiles retain their measured relief but still receive gap-closing profile miters, while
explicit stepped construction remains discrete. Segment bounds include the complete sloped
underside. A bend that cannot fit its adjacent spans is rejected at plan sealing rather than
silently sharpened.
Shared junctions own one position and elevation; connected profiles receive a bounded flat
landing at the junction before grade validation.

Only eligible grounded treatments enter `TerrainFieldArtifact`. This artifact is a compact
composition of the exact base hash plus ordered route and junction hashes, not a dense copy
of the whole world. Sampling grades beneath actual travel polygons, uses the lowest safe
bed where fixed spans overlap, blends shoulders against the base field, and grades a shared
junction disk after its participants. The foundation gate probes a 5-by-5 grid over every
travel span and the full junction perimeter. It checks both minimum reveal and maximum
permitted grounding gap; exceeding the explicit probe budget is `incomplete`.

The dependency order is acyclic:

```text
authored terrain -> base terrain -> route/junction construction -> final terrain composition
```

Changing a route reuses base terrain but invalidates its route construction, affected
junctions, final terrain, dependent observations, and their ancestors. Placement-surface
anchors consume the exact final composition. Derived roadbeds and sampled elevations never
mutate the immutable `SpatialWorldPlan`.

## Bounded observation and refinement

`WorldObservationReport` separates deterministic geometric status from visual assessment.
The engine-neutral diagnostic renderer emits bounded approach, overview, and platform PPM
renders tied to exact cameras, primitive hashes, renderer implementation, and
`worldBuildHash`. Those images make visual review possible but do not claim harmony;
visual status stays `unassessed` until a creator or model supplies explicit evidence.

The first geometric verifier set checks dimensions, region containment, full 3D occupancy,
continuous route-to-platform access, exact supported-primitive line of sight, opening
clearance, style-profile consistency, and protected task hashes. Unsupported visibility
geometry is incomplete rather than approximated as conclusive. Access checks include the
entry transition, landings, stair width, tread, riser, and headroom constraints.

A `WorldChangeProposal` may change only policy-whitelisted construction parameters or route
alternatives. The controller computes the affected task dependency closure, recompiles it,
reruns dependent observations, preserves unrelated task hashes, and stops at eligibility,
policy rejection, or the iteration budget. Compilation and observation traces enumerate
which tasks, checks, and cameras actually ran; deterministic full recompilation cannot
masquerade as incremental reuse.

### Roblox boundary

`@basalt/roblox` contains all studs, Roblox materials and asset bindings, terrain voxel
lowering, import schemas, local bridge code, plugin code, Rojo files, and Luau.
`ROBLOX_STUD_METERS = 0.28` exists only there. Generic terrain is converted to Roblox's
1.12-meter voxel grid by evaluating the same base/route/junction composition at voxel
centers. Because reconstructed smooth terrain is not identical to the engine-neutral field,
the connector raycasts the written terrain and permits only a bounded upward residual at
route stations. Junction participants and the junction surface converge on one shared
endpoint correction before parts are created. Readback recomputes each realized span and
junction's transform, dimensions, material, collision state, and terrain contact against
actual smooth terrain. Minimum reveal is measured from the travel top. Exposed space is
measured from the authored route body's underside—not from the top—so route thickness is not
misclassified as a void. When that body gap is within the authored grounding tolerance, the
adapter emits a deterministic, exactly read-back grounding skirt down into the voxel surface;
larger discrepancies remain incomplete. Maximum top clearance is retained as a diagnostic,
not used as a proxy for grounding. Roblox publishes newly written voxel channels before its
terrain collision representation is ray-queryable, so a missing terrain query crosses at most
four scheduler frames before remaining a hard observation failure. A stored route hash alone
is not evidence.

The import command binds a private local bridge to `127.0.0.1`, selects one port from
8787–8797, authenticates requests, and streams one canonical import plan. The plugin
discovers it automatically and exposes one contextual primary action. Import runs in
order:

```text
preflight -> foundation -> meso -> micro -> readback -> commit or rollback
```

Bridge state is `idle | pending | complete | incomplete`. Constructed readback recomputes
primitive geometry and properties from actual Studio instances and queries actual opening
volumes for blockers; expected hash attributes alone are insufficient. Only creator-run
readback can support `engine_verified` assertions.

Every import atomically replaces `.basalt/roblox/import-report.json` after each acknowledged
stage and on failure. The token-free, content-hashed report records stage progress, exact
readback identities, full diagnostics, and bounded per-segment/junction terrain observations,
including extrema coordinates, surface clearance, body gap, residual correction, and
grounding depth. A correctly received `incomplete` readback is an acknowledged stage outcome;
HTTP conflict is reserved for a malformed or contradictory readback.

## Semantic authority

The kernel freezes seven upper sorts: `object`, `aggregate`, `substance`, `space`,
`boundary`, `phenomenon`, and `information_content`. Denotation, affordance, state,
treatment, contextual role, relation, and realization form remain orthogonal.

Commitments contain opaque IDs, definitions, identity criteria, direct parent hashes,
and materialized ancestors. Labels, aliases, examples, mappings, search terms, model
confidence, and paths are lexicon or review data and cannot influence runtime reasoning.
Reasoning is bounded to exact/descendant matching, ancestry, set inclusion, state
equality, evidence ordering, and declared relation symmetry/inverses.

Artifacts bind only the semantic dependency closure they use. Adding an unrelated leaf
does not change an existing catalog entry or world hash.

## Catalog authority and search

`CatalogAssetArtifact` stores source identity, metric bounds, geometry, materials,
contacts, collisions, interfaces, rights, and provenance without semantic claims. An
admitted assertion bundle supplies semantics separately. Each source identity has one
disposition: eligible, incomplete, or rejected.

Runtime entry kinds are:

- `substitution_set`: genuinely interchangeable whole alternatives.
- `assembly_kit`: structural providers plus an explicit grammar.
- `attachment_set`: members requiring a host surface or interface.
- `route_kit`: network pieces and topology transitions.
- `environment_realizer`: non-local environmental realization.
- `collection`: authoring-only grouping, never a runtime resolution result.

Progressive open-vocabulary authoring search follows:

```text
measurement + original basename
  + optional Qwen factual metadata
  + optional SigLIP text/image evidence
  + optional DINO shape evidence
  -> available-channel retrieval
  -> optional requirement-specific Qwen validation
  -> deterministic physical/rights/resource filters
  -> non-authoritative candidate packet
```

Every measured, named asset is searchable before enrichment. Results state contributing
channels and missing evidence. Text search fuses basename, metadata, and SigLIP channels
that are actually present, with per-document available-channel normalization so partial
coverage does not receive an automatic channel-count penalty or bonus. Reference-asset
search requires DINOv3 and returns `incomplete` when shape evidence is absent. DINO remains
shape-only and is used for bounded substitution proposals, never semantic authority.

Requirement validation preserves base rank. A frozen candidate-decision policy is the only
stage allowed to conclude `suitable_match`, `evidence_insufficient`, or
`no_suitable_match`; nearest-neighbor retrieval alone never claims suitability. Search
cannot emit admitted assertions or entries. Unknown nouns remain open vocabulary and
surface a semantic gap when compilation needs a commitment.

Context interpretation is a separate bounded operation over 2–32 assets. Group proposals
may use basename stems, metric/interface compatibility, or bounded retrieval. Requests may
also bind attributed source prefabs, demonstrated assemblies, component transforms,
parent/child relationships, authored roles, or documentation by exact identity and evidence
hash. Pack and directory identity are excluded. The result can propose components, mates,
aggregates, collision companions, and alternatives or abstain. A deterministic construction
eligibility assessment combines this with measurements and visual metadata for review, but
only admitted assertions and authored declarations can seal catalog entries.

Metadata jobs use deterministic resource-bounded shards: at most eight assets, 192
evidence files, 64 MiB of evidence bytes, and a fixed preprocessed-pixel ceiling at a
384-pixel long edge. A shard is a resumable checkpoint and transport unit, not a model
batch. Only one Modal GPU container and no more than four local CPU tasks may run.

## Storage and identity

Git stores semantic authority, catalog declarations and dispositions, compact qualified
metadata shards, manifests, policies, prompts, and evaluation reports. Binary GLBs,
renders, depth evidence, and quantized embedding matrices live in the local
content-addressed store under `.basalt/cas`. Remote CAS distribution is intentionally
deferred.

Basalt-owned schemas and paths are unversioned. Content hashes, implementation hashes,
source commit hashes, and observed-world-state hashes record identity and provenance;
they are not compatibility streams. Contract changes are clean replacements.
