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

Production qualification uses a separately sealed fixture with at least 64 assets,
queries, and validation cases. Leakage groups cannot cross development, model-selection,
or holdout splits. Gold data supports pooled relevance judgments, multiple relevant assets,
hard confusers, true no-match queries, and evidence-insufficient cases.

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
| uniform hybrid recall at 5                              |    0.90 |
| uniform hybrid mean reciprocal rank                     |    0.75 |
| mixed-coverage hybrid recall at 5                       |    0.85 |
| mixed-coverage hybrid mean reciprocal rank              |    0.70 |
| final decision accuracy                                 |    0.90 |
| selected validator exact verdict                        |    0.90 |
| hard-negative false matches                             |       0 |
| evidence-insufficient cases incorrectly called no-match |       0 |

The evaluator also requires complete ablation and mixed-coverage evidence, both view
counts, and independent role runs. An eligible report freezes writer, writer view count,
and validator independently. Failure remains `incomplete`; it cannot launch or commit a
corpus metadata run and never revives the removed closed-set classifier.

Live model execution is separate from offline tests. `catalog qualify prepare` freezes the
fixture, `catalog qualify run` validates already content-addressed run evidence, and
`catalog qualify evaluate` applies the frozen policy.

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

Construction tests cover operation validation, explicit parameter bindings, anchors and
local frames, dependency cycles, rectangular opening decomposition, attachments, stairs,
occupancy, exact extents, deterministic hashes, and adapter lowering gaps. Fixture-specific
logic may not enter generic packages.

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
