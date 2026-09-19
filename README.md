# Basalt

Basalt is a hierarchical world compiler. It turns creator intent into a sealed,
engine-neutral `WorldBuild`, then lowers that artifact through an engine adapter.
Roblox is the current adapter.

The compiler is deliberately split between suggestion and authority:

```text
intent + semantic lexicon
  -> non-authoritative hypotheses
  -> admitted semantic assertions
  -> spatial plan in meters
  -> measured catalog resolution
  -> deterministic realization
  -> WorldBuild
  -> Roblox import and verified readback
```

Open-vocabulary catalog metadata and learned embeddings help people and agents find
assets. They do not classify assets authoritatively, create semantic concepts, or
admit catalog entries. Compilation consumes only explicit semantic commitments,
measured evidence, admitted assertions, and sealed entries.

## Repository map

- `packages/semantic-kernel`: stable semantic commitments, facets, lexicon, assertions,
  requirements, and minimal dependency closures.
- `packages/catalog-model`: measured assets, catalog entries, dispositions, resolution,
  and catalog snapshots.
- `packages/catalog-authoring`: review evidence, open-vocabulary metadata, embeddings,
  hybrid search, validation hypotheses, and admission audits.
- `packages/world-planning`, `packages/world-compiler`: engine-neutral planning and
  deterministic realization in meters.
- `packages/roblox`: the only home for Roblox lowering, the local import bridge, plugin,
  Rojo, and Luau code.
- `registry`: Git-tracked semantic and catalog authority plus compact search evidence.
- `.basalt`: rebuildable local measurements, renders, CAS payloads, and task state.

The documentation map and authority boundaries are in [docs/README.md](docs/README.md).

## Development

```sh
npm install
npm run build
npm test
```

Catalog preparation and progressive search:

```sh
node scripts/materialize-catalog-readiness.mjs
node bin/basalt.js catalog inventory
node bin/basalt.js catalog measure --workers 4
node bin/basalt.js catalog render --workers 4
node bin/basalt.js catalog metadata prepare --scope smoke
node bin/basalt.js catalog index
node bin/basalt.js catalog search "tree" --mode basename_only --validate 0
```

The progressive index includes every valid measured standalone renderable source before metadata
or embeddings are available, explicitly records measured collision-only companion exclusions,
reports missing enrichment per document, and retains hard metric and rights filters.
Retrieval without validation is candidate evidence, never a suitability verdict. The 32-asset
smoke fixture checks plumbing and determinism but cannot authorize a corpus run.

Production qualification is authored in independently reviewed stages. The first stage is a
24-asset development-only description pilot. It audits the complete evidence inventory, excludes
explicit non-renderable collision companions, and keeps filename observations separate from visual
authority. Generate one review workspace containing all 24 assets, twelve views per asset,
measurements, and one narrow question per asset: whether the proposed description accurately
describes what is visible. Benchmark selection tags stay internal and contextual use is not part
of this review:

```sh
npm run catalog:qualification:pilot
npm run catalog:qualification:review
```

Open `.basalt/catalog/qualification/review/index.html`, inspect every asset, then choose
**Accurate**, **Edit description**, **Unsure**, or **Image problem**. Extra fields appear only for
the latter three answers. Download the completed decision JSON and seal only that description
stage with:

```sh
npm run catalog:qualification:finalize-descriptions -- \
  --decision /absolute/path/to/catalog-description-decision.json
```

When every proposal is accurate, the reviewer may instead record the same exact decision without a
downloaded intermediary:

```sh
npm run catalog:qualification:finalize-descriptions -- \
  --all-accurate-reviewer <reviewer-id>
```

This does not unlock model execution. Once the exact reviewed-description artifacts exist, author
the bounded development requests with:

```sh
npm run catalog:qualification:queries
```

The same reviewed descriptions can immediately enrich the local starting catalog without a bulk
model run. This creates a distinct agent-authored evidence batch, imports the exact creator review,
and rebuilds search with honest producer and reviewer provenance:

```sh
npm run catalog:metadata:import-reviewed
node bin/basalt.js catalog index
node bin/basalt.js catalog search "small wooden bridge" --mode metadata_only
```

For subsequent bounded batches, write a `CatalogAuthoredMetadataBatch` and optionally a
`CatalogAuthoredMetadataReview`, then run `basalt catalog metadata ingest --batch <batch.json>
--review <review.json>`. Omitting `--review` preserves every record as unreviewed rather than
inventing approval. Authored metadata can improve retrieval but cannot authorize qualification,
catalog admission, or compilation. Successful ingestion registers the exact set hash in
`.basalt/catalog/metadata/authored-sets.json`; an ordinary `catalog index` rebuild loads and verifies
every registered bounded set.

The first demand-driven tranche is the 24 outdoor sources already admitted and exercised by the
first-region fixture. Materialize their current render-and-measurement-bound captions, open the
single page containing every asset, and rebuild search with both bounded authored sets:

```sh
npm run catalog:metadata:first-region
open .basalt/catalog/metadata/first-region-review.html
npm run catalog:index:starting
```

Materialization leaves this tranche explicitly unreviewed. If the creator confirms every visible
description on the bound page, seal that narrow decision, ingest it, and rebuild the ordinary index:

```sh
npm run catalog:metadata:first-region:review-all -- --all-accurate-reviewer <reviewer-id>
node bin/basalt.js catalog metadata ingest \
  --batch .basalt/catalog/metadata/first-region-batch.json \
  --review .basalt/catalog/metadata/first-region-review.json \
  --output .basalt/catalog/metadata/first-region-set.json
node bin/basalt.js catalog index
```

The decision covers captions only. It does not approve construction suitability, contextual
purpose, or the broader claim that a finished region has no catalog gaps.

The current set contains 20 distinct requests, including executable metric limits, close visual
alternatives, absence probes, and properties that renders cannot establish. It contains no
relevance labels or expected validator verdicts. Build the canonical four-channel union pool and
open the one-page relevance ledger with:

```sh
node bin/basalt.js catalog qualify pool --split development --executor local
npm run catalog:qualification:review-relevance
```

The ledger at `.basalt/catalog/qualification/development/relevance-review/index.html` shows every
query–asset pair together, with enlargement, twelve views, and measurements. It hides filenames,
generated captions, retrieval channels, and ranks. Mark each request usable or in need of rewriting;
for usable requests, mark every candidate **Relevant**, **Not a match**, or **Unsure**. Download the
decision and seal it with:

```sh
npm run catalog:qualification:finalize-relevance -- \
  --decision /absolute/path/to/catalog-development-relevance-decision.json
```

This still does not approve validator verdicts or unlock execution. Unknown judgments remain
unknown. The final qualification fixture and runner inputs do not exist until validator cases are
also independently reviewed and every final surface binds the exact creator decisions. Metadata
worker shards contain **up to** eight assets and are also bounded by evidence bytes, file count, and
preprocessed pixels. Eight is a resumable checkpoint ceiling, not a GPU batch size.

Context packets for ambiguous modular assets are separate from per-asset metadata:

```sh
node bin/basalt.js catalog context prepare --assembly-evidence <evidence.json>
node bin/basalt.js catalog context generate --executor local
node bin/basalt.js catalog context review
```

The context output is review evidence, never catalog authority.

`npm run catalog:context:pilot` materializes one bounded four-source Office request. It runs no
model and remains explicitly incomplete because no attributed assembly evidence currently proves
purpose, mates, or socket compatibility.

The first outdoor admission and real catalog-use handoffs are materialized with:

```sh
npm run catalog:admission:outdoor-review
# creator completes the generated decision.json
npm run catalog:admission:outdoor-apply -- --decision <decision.json>
node bin/basalt.js catalog seal
node bin/basalt.js catalog commit
node bin/basalt.js catalog validate --require-commit true
npm run eval:catalog-first-use
npm run eval:catalog-first-use:upload -- --scope required
npm run eval:catalog-first-use
```

The first-use fixture loads the committed catalog and retained measurements, compiles through the
public command, and emits exact Roblox upload and binding inputs. The uploader reads
`BASALT_ROBLOX_API_KEY` and `ROBLOX_USER_ID` from `.env`, verifies the key's exact read/write asset
scope, validates every GLB and source hash before network access, and derives a deterministic
Roblox upload payload. The derivation preserves `COLOR_0` and removes only secondary `COLOR_1+`
attributes, which are not core material color and may contain engine-specific control data. Exact
derived bytes are retained under `.basalt/roblox/upload-artifacts/`; receipts bind the source hash,
derived hash, adaptation-policy hash, creator, and request. The uploader fixes the expected price at
zero, polls Open Cloud operations, and checkpoints each result in
`.basalt/roblox/asset-uploads.json`. Reruns reuse only that exact source/payload pair. Publication
does not admit a catalog source or establish engine evidence.

`--scope required` publishes only assets needed by the current lowering gaps. After a varied Studio
pilot confirms both repaired and unchanged controls, `--scope all` publishes every admitted asset;
pending or quarantined sources never enter either scope.

After rerunning the fixture, uploaded IDs, upload-payload hashes, and publication evidence hashes
are prefilled in `roblox-binding-decision-template.json`. Record the imported MeshPart material
fields in Studio, then run
`npm run eval:catalog-first-use:seal-bindings -- --decision <decision.json>`; the sealer accepts only
exact packet coverage, IDs backed by the matching source-derived upload receipt, and complete
observed material expectations. Other bounded fixtures may pass their own exact review packet with
`--packet <packet.json>`; every sealed result still merges into the single canonical binding
inventory. Sealing inspects each exact retained upload GLB and requires the decision to cover every
render primitive with a Studio-observed material path. Import preflight loads every distinct bound
model and validates those paths plus every declared placement's complete scale, transform, and
bounds fit before any catalog instance is placed.

Roblox operator flow:

For a published batch without material bindings, the fixed connector can observe every requested
model in one creator-run action. It loads models outside the place and records their exact material
paths, texture IDs, and appearance properties:

```sh
node scripts/capture-catalog-bindings.mjs --packet <roblox-binding-upload-packet.json>
# In Studio: open Basalt and click Inspect assets. Stop the capture bridge after it completes.
node scripts/seal-catalog-first-use-bindings.mjs --packet <roblox-binding-upload-packet.json> --decision <roblox-binding-decision.json>
```

This captures engine properties only; it does not approve visual quality or world traversal.

```sh
node bin/basalt.js roblox install-plugin
node bin/basalt.js world compile <plan.json> --catalog registry/catalog.json
node bin/basalt.js roblox import <world-build.json>
```

The import command prints the absolute path to `.basalt/roblox/import-report.json`. That
token-free, content-hashed report is replaced atomically after every stage and retains full
diagnostics plus bounded terrain-contact traces if the plugin rolls the world back.

Harvest Valley is a separate 112-meter exterior showcase built entirely from catalog models,
terrain and connected dirt paths. It contains a farmhouse, two barns, a wind pump, a market,
a campsite, a rock arch, fenced crops, a six-tree orchard, mature woodland and working-yard
props, with no constructed towers or primitive buildings:

```sh
npm run eval:harvest-valley
node scripts/preview-world.mjs --world .basalt/evals/harvest-valley/world-build.json --capture .basalt/evals/harvest-valley/preview
node scripts/capture-catalog-bindings.mjs --packet .basalt/evals/harvest-valley/roblox-binding-upload-packet.json
# After the creator clicks Inspect assets, stop the capture bridge, then:
node scripts/seal-catalog-first-use-bindings.mjs --packet .basalt/evals/harvest-valley/roblox-binding-upload-packet.json --decision .basalt/evals/harvest-valley/roblox-binding-decision.json
npm run eval:harvest-valley
node bin/basalt.js roblox import .basalt/evals/harvest-valley/world-build.json
```

Use a separate empty Studio place. The WebGL preview uses the exact source meshes and compiled
terrain; its lighting and terrain shading are approximate and are not engine verification.
Omit `--capture` to keep the local preview available for interactive orbiting. No source geometry
is generated by the preview.

The layered Harvest Valley comparison is retained at
`.basalt/evals/harvest-valley-comparison/index.html`. It uses five fixed cameras from
`test/fixtures/harvest-valley-views.json`, retains the sparse-ridge development attempt, and
checks unchanged authored placements, terrain heights and route geometry. Materialize a
separate output with `node scripts/materialize-harvest-valley.mjs --output <directory>`;
the default remains `.basalt/evals/harvest-valley`. Existing valid asset bindings are reused.

For destination-specific inspection, pass `--views <camera-packet.json>`. This JSON contains
the exact `worldBuildHash` and a `cameras` array using `WORLD_CAMERA_SCHEMA`: ID, position and
look-at in meters, up vector, field of view, region IDs and readability intent. Captures retain
those descriptors and image hashes in `capture.json`. Use a fresh capture directory; existing
images are not overwritten. Camera changes do not require recompiling the world.

The vegetation comparison uses a retained scene, a declared palette and multiple fixed seeds:

```sh
node scripts/vegetation-comparison.mjs \
  --plan .basalt/evals/region-composition/birch-ridge-sanctuary/attempts/3/spatial-plan.json \
  --views .basalt/evals/region-composition/birch-ridge-sanctuary/cameras.json \
  --spec test/fixtures/vegetation-comparison.json \
  --output .basalt/evals/vegetation-comparison
```

The output directory must be absent. Its `index.html` shows every seed and camera, with
retained plans, source evidence, measured packing bounds and deterministic replay results.
The input scene must already exist and contain the requirements named by the palette. This
is a local WebGL development comparison; it makes no Studio or independent quality claim.
Ordinary `basalt world compile` automatically measures the selected source palette when a
plan contains explicit vegetation distribution policies.

For compact authoring, `createVegetationIntents` from `@basalt/world-planning` accepts a
polygon, palette, shared field, canopy anchors, clearings and measured-grounding limits.
It produces ordinary intents accepted by `sealSpatialWorldPlan`; the compiler owns every
plant transform. Terrain `paint` operations add polygon material patches independently
of height operations, with route treatment taking precedence.

The operator-driven generation pilot uses `node scripts/generation-benchmark.mjs` with
`init`, `start <case>`, `compile <case>`, `capture <case>`, `review <case>`, `finish <case>`, and
`report`. `init` freezes the prepared Harvest Valley inputs and five briefs; `start` begins the
clock before the agent writes the case's `spatial-plan.json`. The harness supplies no layout.
Results default to `.basalt/evals/generation-latency/`; `report` writes a JSON report and
an `index.html` showing retained attempts and reviews. Finished runs cannot be resumed or
overwritten. The review protocol and limitations are in [EVALS.md](docs/EVALS.md).
Use `--output <directory> --suite <briefs.json>` on every command for a separate pilot,
such as `test/fixtures/composition-briefs.json`. A case's optional `cameras.json` contains
camera descriptors; capture binds them to the newly compiled world and retains the exact
packet alongside its images. A prepared `authoring-tools.mjs` in the pilot root, when
present at initialization, is included in the frozen input hashes.

The deterministic observation-tower fixture can be materialized with
`npm run eval:tower`. It writes both world builds, diagnostic renders, refinement traces,
and the Roblox import manifest under `.basalt/evals/observation-tower/`.

The coordinated route-and-terrain fixture can be materialized with `npm run eval:routes`.
It writes a deterministic hillside/crest/bend/junction/stream world build and Roblox import
manifest under `.basalt/evals/route-corridor/`.

```sh
npm run eval:routes
node bin/basalt.js roblox import .basalt/evals/route-corridor/world-build.json
```

The first integrated region core is materialized with `npm run eval:first-finished-region`.
It combines the real committed outdoor catalog with a 96-meter, vertically layered highland,
seven connected route segments, two supported and guarded elevated crossings, four shared
junctions, a trailhead gateway, a ridge pavilion, a cantilevered ravine overlook, and a
13.5-meter roofed procedural observation tower. The build places 230 instances across eleven
admitted asset types over more than 21 meters of terrain relief. Its requirements, diagnostic
views, exact receipt-bound Roblox binding packet, and remaining optional prop gaps are explicit under
`.basalt/evals/first-finished-region/`; no candidate becomes catalog authority merely because
search retrieved it. The 96-meter build is an integration gate, not a claim about the full
40-square-kilometer world and not a reason to run a metadata worker or neural generator.

```sh
npm run eval:first-finished-region
node bin/basalt.js roblox import .basalt/evals/first-finished-region/world-build.json
```

The user runs the final Roblox Studio import, play, and readback gate. Basalt never
claims `engine_verified` evidence from offline tests.
