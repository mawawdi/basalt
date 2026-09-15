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

The progressive index includes every valid measured source before metadata or embeddings are
available, reports missing enrichment per document, and retains hard metric and rights filters.
Retrieval without validation is candidate evidence, never a suitability verdict. The 32-asset
smoke fixture checks plumbing and determinism but cannot authorize a corpus run.

Production qualification has a mandatory independent creator adjudication gate. First inspect
all asset-description, query–asset relevance, and validator-verdict pages under
`.basalt/catalog/qualification/review/`; complete every action in the decision template; then
seal the reviewed answer key:

```sh
npm run catalog:qualification:review
npm run catalog:qualification:finalize -- \
  --decision .basalt/catalog/qualification/review/decision-template.json
node bin/basalt.js catalog qualify prepare
node bin/basalt.js catalog qualify run --split development --executor modal
node bin/basalt.js catalog qualify run --split model_selection --executor modal
node bin/basalt.js catalog qualify evaluate --split model_selection
node bin/basalt.js catalog qualify run --split holdout --executor modal
node bin/basalt.js catalog qualify evaluate --split holdout
```

The runner loads and verifies the proposal, review packet, and creator decision artifact before
any model call. It executes metadata, embeddings, retrieval ablations, independent validation,
and the candidate-decision policy into resumable content-addressed evidence. Only an eligible
holdout report bound to the frozen model-selection artifact unlocks
`catalog metadata prepare --scope corpus`; only a complete corpus run may be committed to
`registry/catalog-search.json`. Metadata worker shards contain **up to** eight assets and are
also bounded by evidence bytes, file count, and preprocessed pixels. Eight is a resumable
checkpoint ceiling, not a GPU batch size.

Context packets for ambiguous modular assets are separate from per-asset metadata:

```sh
node bin/basalt.js catalog context prepare --assembly-evidence <evidence.json>
node bin/basalt.js catalog context generate --executor modal
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
observed material expectations.

Roblox operator flow:

```sh
node bin/basalt.js roblox install-plugin
node bin/basalt.js world compile <plan.json> --catalog registry/catalog.json
node bin/basalt.js roblox import <world-build.json>
```

The import command prints the absolute path to `.basalt/roblox/import-report.json`. That
token-free, content-hashed report is replaced atomically after every stage and retains full
diagnostics plus bounded terrain-contact traces if the plugin rolls the world back.

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

The user runs the final Roblox Studio import, play, and readback gate. Basalt never
claims `engine_verified` evidence from offline tests.
