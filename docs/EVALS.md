# Evaluation and claim semantics

Evaluation turns production failures into reproducible evidence and then into a
deterministic verifier wherever possible. A fixture proves only the claims its evidence
actually covers.

## Gate statuses

- `eligible` means every required contract and evidence claim passed.
- `incomplete` means the input is valid but required evidence or a solution is absent.
- `rejected` means an input, assertion, proposal, or result violates a contract or policy.

An exception is not a fourth status. No retry, fallback, adjacent asset, or model opinion
may silently convert an incomplete or rejected result into success.

## Evidence levels

Evidence is ordered:

```text
declared < measured < simulated < engine_verified
```

Requirements name their minimum level. A multiview caption can suggest that an object is
a chair, but it cannot prove collision, a usable seat, an interface, a navigable room, or
a successful Studio import. `engine_verified` requires creator-run readback bound to the
exact world and observed-state hashes.

## Catalog search smoke evidence

`registry/catalog-search-smoke.json` contains 32 exact source identities spanning whole
objects, structural and route pieces, attachments, aggregates, collision companions,
organic/environment assets, style contrasts, out-of-kernel nouns, and prior render/name
failures. It checks schema plumbing, provenance, cache reuse, deterministic indexing, and
representative examples.

The smoke fixture cannot unlock corpus enrichment, select a production model, or support a
catalog-admission claim. Its earlier 8B/32B observations are retained as exploratory
evidence only.

## Production catalog qualification

Production qualification uses a separately sealed 192-asset cohort, with 64 cohort assets,
48 queries, and 48 independent validator cases in each of development, model-selection, and
holdout. Leakage groups cannot cross splits. The draft fixture's filename-derived labels are
proposals, not gold data. A creator must independently review the asset descriptions, every
query expectation and query–asset relevance judgment, and every validator verdict. The final
fixture is derived from that decision and binds the exact proposal, review packet, and decision
artifact hashes; editing status or provenance fields cannot authorize execution.

Before holdout execution, the fixture pins the search policy, qualification thresholds,
candidate-decision policy, prompt/schema/model choices, and adjudication protocol. It
assigns assets across four enrichment profiles: basename only, basename plus metadata,
basename plus image/text evidence, and fully enriched. The run records:

- basename-only, metadata-only, SigLIP-only, and hybrid rankings for every query under
  uniform coverage;
- hybrid rankings under mixed enrichment coverage;
- both four- and twelve-view writer evidence;
- metadata-writer and requirement-validator runs as independent model roles;
- validator verdicts for positive, uncertain, and hard-negative cases; and
- final `suitable_match`, `no_suitable_match`, or `evidence_insufficient` decisions.

The current frozen thresholds are:

| Gate                                                    | Minimum |
| ------------------------------------------------------- | ------: |
| uniform hybrid Hit@5                                    |    0.90 |
| uniform hybrid mean reciprocal rank                     |    0.75 |
| mixed-coverage hybrid Hit@5                             |    0.85 |
| mixed-coverage hybrid mean reciprocal rank              |    0.70 |
| final decision accuracy                                 |    0.90 |
| selected validator exact verdict                        |    0.90 |
| hard-negative false matches                             |       0 |
| no-match false acceptances                              |       0 |
| evidence-insufficient cases incorrectly called no-match |       0 |

Hit@5 is the fraction of known-positive queries with at least one relevant top-five result.
Pooled Recall@5 is reported separately over all relevant judgments. Ranking metrics exclude
no-match and evidence-insufficient queries; those cases are scored by final-decision metrics,
with false-acceptance rates divided by no-match cases and false-no-match rates divided by
evidence-insufficient cases. The evaluator requires exact per-configuration ablation and
mixed-coverage evidence, both view counts, independent role runs, and verified referenced
artifacts. One writer's or validator's rows cannot fill another configuration's coverage.
An eligible model-selection report freezes writer, view count, and validator independently.
Holdout evidence must bind that exact selection. Failure remains `incomplete`; it cannot launch
or commit a corpus metadata run and never revives the removed closed-set classifier.

Live model execution is separate from offline tests. `catalog qualify prepare` materializes the
split request inputs, `catalog qualify run --split …` orchestrates real content-addressed worker
and search evidence, and `catalog qualify evaluate --split …` verifies that evidence and applies
the frozen policy. No qualification model execution is allowed while the creator decision is
absent or inconsistent with the reviewed answer key.

## Retrieval and acceptance claims

BM25, SigLIP2, DINOv3, metadata, and VLM validation are authoring evidence only.

- Basename BM25 is the minimum progressive text channel.
- Metadata BM25 adds open-vocabulary descriptions when present.
- SigLIP2 adds free-text-to-image retrieval when present.
- DINOv3 supports reference-shape retrieval and bounded substitution proposals only.
- Requirement validation checks visible candidate compatibility without changing rank.

Each result reports contributing channels and missing evidence. Mixed-enrichment
qualification is mandatory because documents do not all have identical channels. Retrieval
always has a nearest candidate, so only the frozen candidate-decision stage may conclude
that a suitable match exists or does not exist. Any relevant uncertainty produces
`evidence_insufficient`, not a false no-match.

None of these systems can emit an admitted assertion, semantic commitment, catalog entry,
or substitution set.

## Context and construction evidence

Context tests cover bounded 2–32 asset groups, exclusion of pack/directory identity,
component-versus-whole distinctions, collision companions, intentionally partial versus
visibly damaged assets, explicit abstention, and evidence closure. At least one regression
case proves that an attributed source assembly—with exact members, transforms,
parent/child relations, roles, and hashes—resolves an ambiguity that isolated renders do
not. Context output remains review evidence.

The reproducible modular pilot under `.basalt/catalog/context/modular-pilot/` binds four measured
Office components and their 12-view evidence into one request. It intentionally contains no model
receipt and records incomplete construction assessments: basename proximity and measured sockets
do not establish assembly purpose, intended mates, or compatible interfaces without attributed
assembly evidence.

Construction tests cover operation validation, explicit parameter bindings, anchors and
local frames, dependency cycles, rectangular opening decomposition, attachments, stairs,
occupancy, exact extents, deterministic hashes, and adapter lowering gaps. Fixture-specific
logic may not enter generic packages.

## Catalog-first-use evidence

`npm run eval:catalog-first-use` loads `registry/catalog.json` plus the exact retained measurement
artifact, compiles four outdoor requirements through the public `world compile` command, and
records candidate evidence, admitted selection identity, placement, and typed gaps. A second plan
changes only the outdoor-prop source-byte budget and checks that unrelated realized placements
remain stable. Until the creator admits the outdoor tranche, the honest result is four unresolved
catalog requirements and zero hand-placed fallback instances.

The same evaluation inventories sealed Roblox bindings and emits an upload packet plus a
creator-fillable binding decision. The packet separates assets required by current lowering gaps
from all admitted assets; pending sources are never upload candidates.
`eval:catalog-first-use:upload` verifies exact source bytes, derives a Roblox payload by retaining
`COLOR_0` and stripping `COLOR_1+`, and stores that payload content-addressably before publishing it
with Roblox Open Cloud under `ROBLOX_USER_ID`. It authenticates from the ignored `.env`, requires
read/write asset scope, refuses source, payload, or adaptation-policy drift and files over the API
limit, pins the expected price to zero, resumes saved operation paths, and reuses only exact
source-derived publications. The sealed upload ledger is publication evidence only.

The binding sealer verifies the upload-packet hash, exact asset, source-artifact, and upload-artifact
coverage, positive Roblox IDs, matching eligible publication-receipt hashes, and complete
Studio-observed material expectations. Offline success cannot create engine evidence; only
creator-run Studio import and readback can. The regression pilot contains affected secondary-color
sources plus unchanged controls; full admitted publication waits for the creator to confirm both.

## World observation and refinement

The observation-tower fixture builds a route-connected tower from bounded construction
operations. Its requested edit changes only the declared height and width parameters. The
controller must then:

- execute the affected compilation dependency closure and report each task actually run;
- reuse and preserve unrelated task hashes;
- rerun dependent checks and diagnostic cameras;
- prove requested dimensions, containment, occupancy/neighbor clearance, style-profile
  consistency, opening clearance, exact supported-primitive line of sight, and continuous
  route-to-platform access; and
- stop within the policy iteration budget.

Access evidence includes the ground/route entry transition, stair width, tread, riser,
landings, and headroom. Visibility uses exact intersections for supported boxes and vertical
cylinders; unsupported geometry cannot produce a conclusive clear claim.

Terrain-contact evidence binds each surface-relative route to the exact sealed terrain field
used for import and probes a bounded 5-by-5 grid over every travel span, including its interior
and full width. It proves minimum travel-top reveal and bounds exposed space beneath the
authored route body; it never treats the body's own thickness as a terrain gap. Bend radius is
a hard plan constraint; ordinary curved spans are angle-bounded and their sealed miter joins
must close the outside edge exactly. Smooth designed profiles must remain within the one-degree
pitch tessellation bound, and profile-miter evidence must bind every nonzero pitch transition
while complete bounds cover the sloped underside. Route overlaps share the lowest safe roadbed,
and junction disks bind the exact participant profiles and terrain composition. An exceeded
probe budget is `incomplete`.

The focused route-corridor fixture contains a woodland trail, cut/fill paved road, elevated
boardwalk, hillside, crest, radius-constrained bends, three-way junction, carved stream, and
coordinates on and off Roblox's 1.12-meter terrain boundaries. It proves deterministic hashes,
distinct treatments, terrain preservation beneath the boardwalk, measured supports, masks,
joint route/terrain clearance, junction grounding, and local invalidation. Run
`npm run eval:routes` to materialize its world build and Roblox import manifest beneath
`.basalt/evals/route-corridor/`.

The Studio gate additionally checks realized route parts and the junction against Roblox's
actual smooth-terrain surface. The adapter coordinates bounded station and shared-junction
residuals before creation, then raycasts the entire realized footprint for intrusion and
unintended voids. An allowed voxel residual is closed by explicit grounding geometry whose
bottom contact is also raycast and whose transform and properties are read back exactly.
Retaining a route marker or expected hash is insufficient.

Every observation carries approach, platform, and overview render descriptors tied to the
exact world state and camera. The lightweight renderer is diagnostic evidence, not a visual
quality oracle. Geometric eligibility and visual assessment are separate; the offline
tower leaves visual status `unassessed`.

`npm run eval:tower` materializes both builds, the refinement and execution traces,
diagnostic render payloads, and the Roblox import manifest beneath
`.basalt/evals/observation-tower/`.

## Roblox readback

Offline lowering tests prove canonical transforms, material bindings, expected element
geometry, opening volumes, rollback behavior, authentication, and protocol parsing. Creator
readback must inspect actual engine instances and properties. For constructed output it
recomputes primitive type, center, size, material, anchored/collision state, and the parts
occupying each opening volume. For routes it checks each segment's actual frame, extent,
properties, top reveal, underside gap, and grounding contact. Every bridge run persists a
content-hashed `.basalt/roblox/import-report.json` containing all acknowledged stages, full
diagnostics, and bounded terrain extrema; this report is diagnostic evidence and is excluded
from the observed-world-state hash. Merely echoing expected hash attributes is insufficient.

The creator performs the final Studio import, play, access, view, visual, and readback gate.
Only that evidence may support `engine_verified`.

## Regression discipline

Every important failure should become one of:

- a schema or static boundary test;
- a deterministic unit or property test;
- a fixed smoke or qualification case;
- a replayable compilation/observation trace; or
- an engine readback assertion.

Evaluation fixtures consume generic packages. Production packages never import fixture
answers or special-case showcase prompts.
