# Basalt

Basalt is an engine-neutral, deterministic hierarchical world compiler. Models
interpret intent and produce hypotheses; admitted semantic assertions, measured
catalog evidence, and typed spatial solvers authorize builds.

```text
intent + lexicon
  -> semantic hypotheses
  -> admitted assertions and minimal closures
  -> SpatialWorldPlan in meters
  -> deterministic catalog resolution
  -> foundation, meso, and micro realization
  -> WorldBuild
  -> Roblox lowering and authoritative readback
```

Every gate reports `eligible`, `incomplete`, or `rejected`. A missing decision,
asset, or solver result never becomes a silent success.

## Commands

```sh
npm install
npm run build

node bin/basalt.js semantics validate
node bin/basalt.js semantics seal
node bin/basalt.js semantics explain bsc_000003

node bin/basalt.js catalog inventory
node bin/basalt.js catalog providers
node bin/basalt.js catalog measure --workers 4
node bin/basalt.js catalog render --workers 4
node bin/basalt.js catalog calibration prepare
node bin/basalt.js catalog calibration
node bin/basalt.js catalog hypothesize
node bin/basalt.js catalog panel
node bin/basalt.js catalog cluster
node bin/basalt.js catalog review
node bin/basalt.js catalog decide <cohort-id> \
  --action admit --entry <stable-handle> --authority <curator-id> \
  --findings path/to/review-findings.json --rationale "..."
node bin/basalt.js catalog admit
node bin/basalt.js catalog commit
node bin/basalt.js catalog validate
node bin/basalt.js catalog seal

node bin/basalt.js world compile path/to/plan.json \
  --catalog registry/catalog.json

node bin/basalt.js roblox install-plugin
node bin/basalt.js roblox import .basalt/world/world-build.json
```

The Roblox plugin has no URL or token fields. The install command rotates and
embeds a private local credential, materializes the plugin at
`~/Documents/Roblox/Plugins/BasaltStudioPlugin.rbxmx`, and the plugin probes the
bounded local port range automatically. Its single primary action imports all
stages sequentially; Cancel is shown only while work is active.

`catalog commit` atomically replaces `registry/catalog.json` and retains the
compact evidence needed by current authority. Bulk source GLBs, archives, and
rendered images are content-identified but local-only. There is no remote CAS in
the current baseline, so preserve those local payloads independently. The exact
implemented storage and admission boundaries live in the
[architecture](docs/ARCHITECTURE.md) and [visual evidence](docs/VISUALS.md) docs.

Imported GLBs are deduplicated into one source-neutral pool at
`registry/source-assets/sha256/`. Archive names, vendor folders, and original file
paths are retained in `registry/source-provenance.json` for rights and
traceability. `catalog hypothesize` derives basename-only `CatalogSourceNameHint`
artifacts from every observed original GLB filename for a content hash. These are
labeled weak supervision for hypothesis adapters only. Pack identity, archive
names, and directories stay excluded, and no name hint can affect physical
grouping, calibration assignment, admission authority, or catalog resolution.

Local measurement and rendering share one enforced four-worker ceiling. Physical
split manifests—including the source-neutral near-duplicate search, leakage graph,
and whole-component assignments—are tracked under `registry/`; their PNG inputs
remain local bulk evidence.

## Development

```sh
npm run format
npm run build
npm run rebuild
npm test
npm run plugin:build
```

The user performs every Roblox Studio check. Basalt does not launch or operate
Studio.

## Documentation

- [Documentation authority](docs/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product thesis](docs/BASALT.md)
- [Visual and catalog evidence](docs/VISUALS.md)
- [Evaluation semantics](docs/EVALS.md)
- [Roadmap](docs/ROADMAP.md)
- [Research index](docs/RESEARCH.md)
