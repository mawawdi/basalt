# Basalt

Basalt is an engine-neutral, deterministic hierarchical world compiler. Language
models may interpret creator intent and propose semantic hypotheses. Only admitted
semantic assertions, measured catalog evidence, and typed spatial solvers can
authorize a build.

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

Every gate reports `eligible`, `incomplete`, or `rejected`. Basalt never turns a
missing decision, missing asset, or unsatisfied constraint into a silent fallback.

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

Generated working state uses stable paths under `.basalt/` and can be rebuilt.
`catalog commit` atomically replaces the single tracked root at
`registry/catalog.json`. That root embeds the exact runtime snapshot,
dispositions, entry declarations, admitted assertions, policy, decisions, and
audits. The exact measurements, request set, render index, inference receipts,
panel, embeddings, cohorts, and review plan used by the root are copied to
immutable `registry/evidence/<hash>.json` files; unreferenced evidence is removed
from the live tree after publication because Git supplies history. World
compilation reads the retained measurement set rather than ignored state. A
normal Git commit therefore preserves the complete catalog metadata even if
`.basalt/` is deleted. Source GLBs and rendered images remain external
content-addressed payloads rather than bloating Git; their hashes and lineage are
preserved, so those payloads still need ordinary artifact/archive backup.

Catalog triage is cohort-based, not one click per asset. At least two independent
semantic hypothesis implementations must agree exactly; a separately hashed
visual embedding splits look-alikes by complete-link similarity; then Basalt
selects visual medoids, visual and metric outliers, semantic boundaries, and a
deterministic audit sample. A curator decides the finite cohort after reviewing
only that sample. Model confidence never becomes compiler authority, and failed
independent audits block admission.

Catalog gaps may enter an offline fulfillment loop: reuse an exact coherent
binding, restyle retained geometry, extend an existing substitution set, or
synthesize a new substitution set. TRELLIS.2, Hunyuan3D 2.1, and Pixal3D are
declared provider routes. `catalog providers` reports their real qualification
state and never performs a paid run. Generated output must still pass generic
asset finishing, metric measurement, visual review, semantic admission, and a
new catalog seal before resolution can use it.

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

- [Architecture](docs/ARCHITECTURE.md)
- [Product thesis](docs/BASALT.md)
- [Visual and catalog evidence](docs/VISUALS.md)
- [Evaluation semantics](docs/EVALS.md)
- [Roadmap](docs/ROADMAP.md)
- [Research index](docs/RESEARCH.md)
