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
  policy-whitelisted parameter, route, vegetation or ground-material changes, recompiles the affected dependency
  closure, and reports executed versus reused tasks.

Terrain and routes remain compilable when catalog-dependent stages are incomplete.
Structural grammars use explicit component roles, interfaces, topology, pitch, and
coverage. Bounds or filenames never infer structural meaning.

Ordinary cluster and surface-scatter population consumes a content-hash-seeded candidate
stream until the authored target is reached or its named execution allocation is exhausted. Region
containment and shared measured 3D occupancy prune each candidate; a rejected candidate does
not silently consume one of the requested instances. Exhaustion retains explicit underfill
diagnostics and never weakens the authored minimum or separation.
Coordinates and yaw are independently sampled per candidate from its content hash, so a group
does not share one rotation or form a low-discrepancy lattice. Collision is evaluated using
that candidate's final orientation. `minimumSeparationMeters` adds a horizontal margin around
measured bounds; it is not a center-to-center spacing parameter.

An optional `PopulationDensityField` on either population intent applies smooth seeded
world-space value noise and a boundary fade before geometric admission. Its authored
parameters control wavelength, contrast, minimum relative density and edge width. Shared
parameters correlate spatial patches across intents. The field alone remains independent
rejection sampling toward a target count.

Surface scatter can instead bind an explicit `VegetationDistribution`. Static composition
is realized first, then canopy, understory and ground cover. Within each layer, candidates
from equal-priority species interleave by deterministic hash and share an adaptive spacing
grid. Higher authored priorities reserve measured larger forms before smaller accents. A finite
candidate density per square meter defines the logical work implied by an area; `targetCount` is
an authored population objective. Candidate evaluations are written as content-addressed sorted
runs and merged in canonical order while sharing spacing and occupancy state across runs. Batch
size and merge fan-in are execution choices and cannot alter a completed result. An exhausted
allocation retains its checkpoint, emits no partial population, and reports `incomplete`; a later
invocation resumes from the exact candidate offset. Failed sites are not replenished merely to fill
a quota. This is adaptive dart throwing, not Bridson active-list sampling or ecosystem simulation.

Layers name their canopy dependencies. Their open/covered preference interpolates against
the geometric influence of actual accepted canopy instances. Slope limits, 3D activity
clearings with an exterior falloff, and explicit route clearance height constrain placement.
Physical clearance and authored biological spacing remain separate. The sampler has no semantic
area, species, intent, or instance ceiling. This does not establish chunk-partition invariance or
million-instance throughput; those require separate capacity measurements.
Nine terrain probes across the rotated measured bottom envelope bound support relief.
Accepted vegetation aligns to the lowest sampled support with an explicit shallow embed;
excessive relief is rejected. This is a bounded grounding check, not continuous terrain
intersection or deformation of roots to the terrain.

`createVegetationIntents` in `world-planning` expands an authored area, palette, shared density
field and protected clearings into the existing validated scatter intents. It wires dependent
layers to that area's canopy and declared single-tree anchors. It neither selects catalog
assets nor supplies transforms, and introduces no second persisted world format.

The CLI measures `AssetPlacementGeometry` locally from hash-verified GLBs for every resolved
plant asset. Triangle clipping into height bands produces conservative packing
envelopes, bound to exact source, asset and geometry hashes. Faces crossing a band are included
even when none of their original vertices lie inside it. Animated geometry and stale evidence
are refused. These measurements do not modify catalog entries or engine collision. Existing
explicit collision geometry retains precedence. Instances bind the additional evidence;
micro realization retains the measured occupancy reservations so refinement verification uses
the same occupied geometry instead of reverting to solid crown boxes. Missing plant evidence
is an explicit compilation gap. Measurements are cached independently by verified asset and source
hash. There is no model-count or triangle-count admission ceiling; workspace byte limits remain
execution policy and exact-integer overflow is rejected.

Catalog measurement is incremental by verified source-content hash, rights, unit scale and
renderable role. An unchanged record is reused byte-for-byte; changed or missing sources alone enter
the worker queue. The queue has no corpus-cardinality field. Executor lifetime, worker concurrency
and workspace bytes are operational policy, and exhaustion leaves an incomplete measurement set
instead of silently omitting later sources.

## Declarative construction

A sealed `ConstructionProgram` is a bounded graph of parameters and fixed operations:
boxes, vertical cylinders, linear repetition, rectangular panel openings, surface
attachments, and stair runs. Values are literals or affine bindings to declared scalar
parameters; repeat counts may bind integer parameters. Programs also bind a region,
semantic closure, style profile, placement-surface or region-point anchor, and local
quarter-turn frame. Their default and per-operation appearances carry both the engine
material and exact sRGB color; construction lowering may not fall back to an engine-default
part color.

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
typed lowering gap at an engine boundary. Stair flights emit one riser-height prism per step
so tall access paths remain open beneath the treads instead of accumulating a ground-filled
wedge.

## Coordinated route and terrain construction

A route declaration separates horizontal alignment, bend radius, elevation controls,
appearance, and construction treatment. The four treatments have different authority:

- `follow_surface` follows relief within explicit grade, cut, fill, and grounding bounds;
- `cut_fill` designs a smooth control-point profile and grades a roadbed plus shoulders;
- `elevated` preserves terrain and emits a deck with measured supports plus its explicitly
  authored edge-protection policy; and
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

Terrain material paint is also resolved before engine lowering. Each paint operation carries an
explicit hard or organic edge profile. Organic profiles use a seeded continuous world-space field
with authored wavelength and displacement, so execution resolution does not choose the art
direction and rectangular support pads do not have to become rectangular visible surfaces.
Vegetation clearings consume the same horizontal mask contract and add only vertical range, layer
selection, and falloff. The compiler excludes complete measured plant bounds against that mask.
Shared junctions own one position and elevation; connected profiles receive a bounded flat
landing at the junction before grade validation. Junction travel-surface appearance is
separate from the terrain material graded beneath it, so a timber landing does not paint the
terrain as timber.

Only eligible grounded treatments enter `TerrainFieldArtifact`. This artifact is a compact
composition of the exact base hash plus ordered route and junction hashes, not a dense copy
of the whole world. Sampling grades beneath actual travel polygons, uses the lowest safe
bed where fixed spans overlap, blends shoulders against the base field, and grades a shared
junction disk after its participants. The foundation and observation gates stream probes over
every travel span and junction at spacing derived from the sealed terrain grid. They check both
minimum reveal and maximum permitted grounding gap. Route size and width do not encounter a
probe-count ceiling; counts beyond exact integer representation are invalid.

The dependency order is acyclic:

```text
authored terrain -> base terrain -> route/junction construction -> final terrain composition
```

Changing a route reuses base terrain but invalidates its route construction, affected
junctions, final terrain, dependent observations, and their ancestors. Placement-surface
anchors consume the exact final composition. Derived roadbeds and sampled elevations never
mutate the immutable `SpatialWorldPlan`.

## Observation and refinement

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

A `WorldChangeProposal` may change only policy-whitelisted construction parameters, route
alternatives, vegetation density, added vegetation clearings, or existing terrain-material
patches. Protected catalog intents retain their exact asset, transform and measured bounds.
The controller accepts a requested initial proposal even when the starting geometry is already
eligible. It computes the affected task dependency closure, recompiles it,
reruns dependent observations, preserves unrelated task hashes, and stops at eligibility,
policy rejection, or the iteration budget. Compilation and observation traces enumerate
which tasks, checks, and cameras actually ran; deterministic full recompilation cannot
masquerade as incremental reuse.

`createRouteAlternativeProvider` tries each authorized alignment at most once for routes
with compiler or observation failures. It preserves geometric tolerances and stops with no
proposal when the finite alternatives are exhausted. The controller returns `incomplete`
for that exhaustion, retains compiler incompleteness even if a narrower observation passes,
and gives rejection precedence. This searches authored alternatives; it does not discover
new alignments. The terrain-contact verifier measures exposed space beneath the route body,
subtracting its thickness from top clearance consistently with the compiler.

### Prompt-driven regional authoring

`RegionAuthoringProfile` provides an empty region, measured catalog choices, terrain defaults
and route construction settings. `RegionDraft` is a transient proposal containing destinations,
routes, terrain operations, planting areas and evidence cameras. `realizeRegionDraft` expands
it into the existing sealed `SpatialWorldPlan`; no second compiled-world representation exists.
Unknown requirements and unsupported requests fail before compilation. Models propose region
composition; the existing terrain, route, grounding and population solvers own final transforms.
Nonblocking proposal notes remain separate from genuinely unrepresentable user requirements.
Planning context includes the terrain's base elevation and exact route construction constraints.
Draft expansion owns unused-axis grid strides and derives junction radii from the participating
path widths. Rotated grids expand into individual placements with rotated offsets and asset
orientations; their footing covers the full rotated arrangement. These details are not additional
model responsibilities.

Profiles bind the exact catalog snapshot used to prepare their measured palette; a changed
snapshot requires profile preparation again. Each palette member carries its authored visible
description and evidence hash, measured dimensions, retained render-evidence hashes, and admitted
style profile. The requirement identifier remains an opaque output reference and does not become a
description. A prepared palette is one scene-authoring selection and has no schema cardinality
ceiling. It can be rebuilt against a different admitted selection when a brief exposes a real scene
gap; it is not the catalog or a permanent product-wide asset list.

The CLI's provider-neutral `WorldPlanner` interface performs one JSON-Schema request at a time.
The OpenRouter adapter implements that transport using ordinary HTTP, with no model tool loop
or executable output. Local schemas, catalog authority, compilation and geometric verifiers
remain authoritative. Named execution policy controls requests, retries, rendering, construction,
and candidate allocations without changing semantic validity. The runtime captures actual source-mesh
previews and retains request hashes, transport configuration, actual model and upstream provider
when reported, raw responses, usage, cost and failures. Visual review
is explicitly same-model evidence; edit review receives matching before-and-after views.
The response schema is included both in the request format and the model-visible instructions.
The transport records purpose-specific output-token allocations, response-byte allocation, selected
reasoning setting, routing preference, and timeout with each run. Provider-directed retry occurs
only when the provider supplies a bounded retry delay. A final HTTP 402 is classified as structured
`resource_exhaustion` evidence containing the provider resource name, requested and available
output-token counts, units, origin and reason; it stops semantic repair immediately and remains
resumable rather than repeating an unchanged request. The active values live in
`registry/world-authoring/execution.json`; they are operational evidence rather than world limits.

Capacity boundaries are classified at their owning layer. Finite coordinates, valid polygons,
unique identities, probability domains and safe-integer representation are mathematical invariants.
Roblox voxel, payload and instance constraints belong only to the Roblox adapter and return a typed
lowering gap when exceeded. Route widths, habitat density, species choice, camera coverage and scene
cardinality are authored design. Request bytes, response tokens, timeouts, preview resolution,
candidate batches, solver work, cache bytes and retries are execution resources. Every run retains
the effective policy, its units in the field names, its stated origin and an exhaustion diagnostic;
resource exhaustion yields `incomplete` evidence and cannot silently truncate the authored world.

Logical edits may contain any number of objectives. When their complete linked proposal would exceed
the transport's measured text-byte allocation, the runtime groups objectives by semantic target,
packs groups by actual serialized request bytes, and issues linked requests. It validates the merged
operations against the original complete request and rejects conflicting cross-batch parameters.
Transport batching therefore cannot redefine, truncate, or partially satisfy the edit.
Repair feedback includes the measured bounds of already placed objects. Incomplete populations
can supply partial mesh previews when terrain and paths are eligible, but their failed compiler
status remains authoritative. Those images assist repair and never establish acceptance.
Fresh visual review receives the current compiler status and diagnostics, without earlier
attempt failures that may already have been resolved.
Generation seals structural layout before planting. If planting alone fails, the next semantic
attempt reuses the exact layout and records that reuse rather than moving valid destinations, routes
or activity spaces. A layout failure still requires a new layout proposal.
Regional planting proposals specify patch scale, desired center spacing, relative species
weights and population objectives. Expansion derives candidate density,
a shared moderate density field and canopy preference. Canopy establishes independently of
existing canopy. This authoring surface reuses the existing sampler; it does not replace its
measured occupancy, grounding or candidate-evaluation allocation. The authoring runtime requires each requested
planting layer to establish initially. These composition checks are separate from persistent
compiler minimum counts, so a later clearing can remove a species. Explicit authored minimums
still fail compilation with density, spacing, slope and placement rejection counts.
Ground-cover expansion prioritizes measured broad patches before small accents
within that layer. Each planting area authors its own transition width, patch scale, density floor,
and contrast; no universal planting contrast or maximum transition width is injected. The planning
context exposes dimensions and projected bounds area directly.
Each attempt also records a policy-selected sample of projected vegetation envelopes, summarized by
layer and policy-selected spatial tiles. This exposes large empty domains and count/coverage mismatches;
mesh holes, actual leaf area and terrain textures are unresolved, so it is diagnostic evidence,
not a density requirement or aesthetic score. Meadow ground cover and tree exclusions use separate
ordinary planting domains; no asset-name classifier decides where grass belongs.
Routes reference shared named nodes and interior waypoints; draft expansion rejects disconnected
regional route graphs. Shared endpoints come from one coordinate declaration. The prepared profile
also declares an authored position tolerance for individual placements. The population realizer
tries the authored center followed by a prefix-stable low-discrepancy disk sequence whose evaluation
allocation and origin are explicit execution policy. It retains yaw and checks region, measured
occupancy and route clearance. Natural vegetation uses the route vegetation mask, while authored
landmarks and props remain outside the physical travel surface; biological spacing and physical
collision therefore stay distinct. Increasing the allocation extends the same sequence. Grids remain
exact. A generated footing covers the permitted displacement; an exhausted search names the policy
and remains incomplete. Exact-point
intents can still declare no positional freedom.
An empty camera list requests geometric observation only;
the separate WebGL capture supplies visual evidence for these runs.

The initial outdoor edit policy protects all non-vegetation intents and route travel geometry.
It permits density and added clearing changes for existing vegetation intents, plus replacement
of existing paint polygons with whitelisted materials. It cannot add planting areas or edit
trees placed as individual objects or cultivated rows. Vegetation edits invalidate the current
whole-world population task and world output; this is not per-plant or per-grove execution.
Paint edits invalidate the terrain task and its dependent closure. New runs use absent output
directories and never overwrite accepted worlds.

`RegionEditRequest` freezes every objective, exact prompt span, spatial target, affected layer,
explicit clearing-transition requirement (or `unspecified`), and preservation requirement before
any change is proposed. `RegionEditProposal` contains grouped
semantic operations against those targets. Deterministic expansion derives
`PopulationPlacementConstraints` from the verified base build: retained physical placements outside
the regeneration masks, the source hashes they bind, and one current flattened snapshot for replay.
Models cannot author trusted locks. A stale catalog, terrain, geometry, plan, or source-world binding
is rejected. Success compares physical placements in protected space even when intent-derived IDs
change, and records the compiler tasks actually executed and reused.

Edit response schemas enumerate the exact permitted targets and operation kinds. Compact edit
context supplies observed plant counts, spatial bounds, existing clearings and each target's
numeric limits. Every frozen objective receives its own realized-effect verdict; one successful material
or clearing change cannot conceal a failed density objective. Density edits report before/after counts; a requested increase or decrease without
that measured direction remains incomplete. A decrease or clearing whose verified base population is
already at the requested lower bound is recorded as `already_satisfied`; it cannot stand in for an
unrealized increase or for another objective. Image review still decides whether a measurable change
satisfies the visual request.
Acceptance is derived from four named review properties (instruction following, composition,
grounding and access), each passing, and no blocking repairs. The model cannot supply an overall
pass that contradicts its own required repairs. A malformed or missing review retries the same
compiled candidate within the declared malformed-response allocation; it does not regenerate the
scene. A valid negative review supplies repair feedback for a new proposal. Failed refinement
keeps the resulting plan, world, observation and detailed compiler diagnostics for that proposal.

Review cameras have no semantic count ceiling. Capture keeps every image and local diagnostic, then
partitions model input by the declared image transport batch size. Each batch names supplied and
omitted hashes; a final linked synthesis sees every batch judgment and the complete hash manifest for
the unchanged scene. Malformed batch or synthesis output retries the same captured candidate. A
repeated proposal or identical failure fingerprint stops with retained `incomplete` evidence rather
than consuming another geometry attempt.

Review evidence retains the complete `WorldBuild` locally. Exact route tessellation is represented
to the model by a content hash, segment count, complete bounds, maximum observed grade and a local
evidence pointer; the request explicitly names those omitted vertices. This reduces transport cost
without a silent first-N truncation and leaves the exact geometry retrievable for a targeted review.

The WebGL preview samples the compiled terrain, materials, routes and instances under a named preview
execution policy. Vertex allocation, sampling spacing, viewport and byte limits are recorded with the
capture. Exhaustion makes visual evidence incomplete; it never drops terrain silently or substitutes
a decorative surface that will not be imported.

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
misclassified as a void. The compiler enforces the authored grounding tolerance against its
exact terrain field. At the Roblox boundary, the connector records that tolerance separately
from a half-voxel engine-realization allowance and the raycast observation tolerance; it never
rewrites the authored value. A body gap inside that explicit combined envelope receives a
deterministic, exactly read-back grounding skirt down into the voxel surface. A gap beyond the
envelope remains incomplete. Maximum top clearance is retained as a diagnostic, not used as a
proxy for grounding. Roblox publishes newly written voxel channels before its terrain collision
representation is ray-queryable, so a missing terrain query crosses at most four scheduler
frames before remaining a hard observation failure. A stored route hash alone is not evidence.

The compiled `WorldBuild` also carries its sealed `WorldVisualEnvironment`. Only the commit
transaction carries that profile. The connector snapshots Roblox `Lighting`, transactionally
replaces the `Atmosphere`, `ColorCorrectionEffect`, and `SunRaysEffect` stack with Basalt-owned
instances, verifies their exact readback together with the global lighting properties, and
commits or rolls the entire presentation change back with the world swap. This makes art
direction reproducible without allowing a platform look profile to alter semantic, catalog,
or spatial authority.

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

Catalog mesh publication and binding are sealed separately from catalog admission. The Open Cloud
uploader verifies exact source bytes, derives a deterministic Roblox GLB that preserves `COLOR_0`
and strips secondary `COLOR_1+` attributes, and retains the derived bytes in a private immutable
binary store. It verifies key scope, creator user, zero expected price, operation result, and
moderation state, then checkpoints a receipt binding the source artifact, derived upload artifact,
adaptation policy, and request. Publication never changes source disposition. Each binding record
binds the exact measured asset hash, source-artifact hash, upload-artifact hash, eligible
publication-receipt hash, positive Roblox asset ID, and creator-observed material expectations.
Sealing also inspects the exact retained upload GLB and requires one material expectation for every
render primitive; a multi-primitive model cannot be approved with only its first imported MeshPart
described. Before placing any instance, the connector loads every distinct bound model and probes
every declared placement's complete material coverage, uniform source-bounds fit, transform, and
realized bounds. The first failure for every distinct asset is reported together, before a partial
micro layer can be created.
Missing records remain typed `asset_binding` lowering gaps; the adapter never inserts placeholder
geometry. The catalog-first-use handoff verifies its upload packet and publication ledger before
merging any new binding, and only Studio readback can raise the resulting realization to
`engine_verified`.

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

Static bottom contact has two explicit evidence methods. A `planar_patch_fit` records fitted
positive area from exact bottom topology; `lower_extrema` records deterministic bottom
alignment with zero planar area when rounded, open, pointed, or card geometry has no planar
base. The latter never implies stable support or ground-placement intent. Deformable support
is refused, and the entry declaration plus creator review still select the installation mode.

An explicitly delegated visual author may also supply a bounded catalog admission decision.
Its packet requires `delegated_ai`, its decision records `delegated_visual_review` and the
delegation statement, and its acceptance audits preserve that reviewer. It cannot claim
independent creator review. The commit retains every referenced measurement, review packet,
decision and render-index root, including roots from different admission batches. This authored
path does not enable automatic model admission or qualify corpus execution.

Requirements may narrow candidates with `allowedEntryHandles`. This filter never bypasses
semantic, style, metric, rights or resource requirements. Single placement intents may specify
`yawDegrees`; the compiler applies that rotation before computing occupancy and complete bounds.

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

Context interpretation is a separate non-authoritative operation over an evidence-defined asset
group with no logical cardinality ceiling. Group proposals may use basename stems,
metric/interface compatibility, or retrieval. Requests may
also bind attributed source prefabs, demonstrated assemblies, component transforms,
parent/child relationships, authored roles, or documentation by exact identity and evidence
hash. Pack and directory identity are excluded. The result can propose components, mates,
aggregates, collision companions, and alternatives or abstain. A deterministic construction
eligibility assessment combines this with measurements and visual metadata for review, but
only admitted assertions and authored declarations can seal catalog entries.

Production qualification is likewise non-authoritative until adjudicated. The proposal fixture,
visual review packet, and creator decision are separate sealed artifacts. The decision enumerates
asset descriptions, query expectations, query–asset relevance judgments, and validator verdicts;
the executable fixture is deterministically derived from it. Runners load and verify all three
artifacts before dispatch, and evaluation follows every evidence hash back to its exact request,
candidate pool, model configuration, result set, validator receipt, and decision. Model selection
is sealed before the holdout attempt, and corpus metadata stages recheck the frozen lineage.

Metadata generation uses one content-addressed asset checkpoint at a time. Corpus size produces
more independently cached checkpoints instead of larger semantic artifacts or rejected catalogs.
Image preprocessing retains the declared 384-pixel long edge and every job records exact file,
byte and preprocessed-pixel input totals. Remote execution is an explicit optional transport rather than a catalog dependency;
only one remote GPU worker and no more than four local CPU tasks may run.

The starting-catalog lane accepts bounded agent-authored metadata as a separate evidence kind.
Each record binds current measurements and renders and preserves producer identity, uncertainty,
review coverage, reviewer identity, and the exact review artifact. It can enrich search without a
qualified bulk run, but it cannot authorize qualification, semantic admission, or compilation.

## Storage and identity

Git stores semantic authority, catalog declarations and dispositions, compact qualified
metadata shards, manifests, policies, prompts, and evaluation reports. Binary GLBs,
renders, depth evidence, and quantized embedding matrices live in the local
content-addressed store under `.basalt/cas`. Remote CAS distribution is intentionally
deferred.

Basalt-owned schemas and paths are unversioned. Content hashes, implementation hashes,
source commit hashes, and observed-world-state hashes record identity and provenance;
they are not compatibility streams. Contract changes are clean replacements.
