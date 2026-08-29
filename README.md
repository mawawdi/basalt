# Basalt

Basalt is a hierarchical world compiler for Roblox. Give it a map brief and it
plans macro terrain, regional biomes, modular asset families, deterministic
surface-aware populations, and partitioned Studio transactions.

The creator model proposes style, regional composition, family intent, and
revisions. Typed workers decide terrain geometry, surface raycasts, spatial
relations, sockets, budgets, asset adaptation, provenance, and transaction
boundaries. Neural generation is an offline family factory for missing variants;
it never blocks terrain or population.

Gameplay scripts live outside Basalt. Basalt can export anchors, routes, sockets,
and named bindings for an external game project, but it does not generate or
install gameplay runtimes.

## Get started

Install Node.js 22+, npm, Rojo, Blender for local asset finishing, and Roblox
Studio for creator-run delivery evidence. Set provider credentials only for the
optional offline family factory or an external creative director.

```sh
npm install
npm run build
npm run plugin:build
npm start
```

`npm start` prints the compiler command surface. Compile a plan to produce a
`BasaltWorldCompilation` containing terrain, family populations, and ordered
connector-sized deltas. The creator opens the generated place in Studio,
connects the Basalt plugin, reviews the partitioned world delta, and performs
save/reopen and visual checks. Basalt never launches Studio.

## Useful commands

```sh
basalt world compile <world-plan.json> --output <world-build.json>
basalt world compile <world-plan.json> --families <family-plans.json> \
  --style-hash <sha256> --output <world-build.json>
basalt world compile <world-plan.json> \
  --family-registry <registry.json> --family-requests <requests.json> \
  --style-hash <sha256> --output <world-build.json>
npm run plugin:build

# Serve an emitted partition manifest to the Basalt Studio connector
basalt studio bridge --manifest <world-emission.json> --revision <sha256>
```

The catalog commands are offline and do not call models or Modal. Accepted
family members and populations are content-addressed, so warm builds reuse
byte-identical artifacts without another model call.

## Repository layout

| Path                                                             | Purpose                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/world-planning`                                        | Terrain fields, surfaces, routes, and region geometry          |
| `packages/world-compiler`                                        | Macro/meso/micro compilation and partition emission            |
| `packages/catalog-intelligence`, `asset-inspection`              | Offline measurement and bounded family indexing                |
| `packages/asset-factory`, `prepared-asset`                       | Typed families, materials, adaptation contracts, and admission |
| `packages/reference-image`, `neural-asset`, `region-composition` | Optional creative and offline neural-factory contracts         |
| `packages/authoring-graph`, `artifact-store`                     | Immutable content-addressed records and evidence               |
| `packages/studio-bridge`, `studio-protocol`, `plugin`            | Bounded Studio transactions and reconciliation                 |
| `workers/asset-adaptation`                                       | Isolated Blender asset-finishing worker                        |

## Verification

```sh
npm run format:check
npm run build
npm run plugin:test
npm run plugin:build
git diff --check
```

Tests use fake providers and retained fixtures. They make no model requests and
never launch Studio. See [Architecture](docs/ARCHITECTURE.md),
[visual direction](docs/VISUALS.md), [evaluation policy](docs/EVALS.md), and
[roadmap](docs/ROADMAP.md) for the current contracts.
