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
node bin/basalt.js catalog inventory
node bin/basalt.js catalog measure --workers 4
node bin/basalt.js catalog render --workers 4
node bin/basalt.js catalog metadata prepare --scope smoke
node bin/basalt.js catalog metadata generate --executor modal
node bin/basalt.js catalog index
node bin/basalt.js catalog search "stylized palm tree" --limit 20 --validate 8
```

The 32-asset smoke fixture checks plumbing and determinism but cannot authorize a corpus
run. Production qualification is explicit:

```sh
node bin/basalt.js catalog qualify prepare
node bin/basalt.js catalog qualify run --input <qualification-evidence.json>
node bin/basalt.js catalog qualify evaluate
```

Only an eligible production report unlocks `catalog metadata prepare --scope corpus`;
only a complete corpus run may be committed to `registry/catalog-search.json`. Metadata
worker shards contain **up to** eight assets and are additionally bounded by evidence
bytes, evidence-file count, and preprocessed pixels. Eight is a resumable checkpoint
ceiling, not a GPU batch size.

Context packets for ambiguous modular assets are separate from per-asset metadata:

```sh
node bin/basalt.js catalog context prepare --assembly-evidence <evidence.json>
node bin/basalt.js catalog context generate --executor modal
node bin/basalt.js catalog context review
```

The context output is review evidence, never catalog authority.

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
