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
node bin/basalt.js catalog measure --workers 8
node bin/basalt.js catalog render
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
