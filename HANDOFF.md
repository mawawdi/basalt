# Basalt handoff

Updated 2026-09-11. This file is the continuation point for the next chat.

## Product direction

Forge has been clean-break rebranded to **Basalt**: a dedicated hierarchical,
deterministic world compiler for Roblox. Basalt accepts a map brief and emits
terrain, regional asset-family populations, partitioned world deltas, and a
Studio connector manifest. Gameplay scripts are external inputs. Basalt does
not own Luau gameplay generation, gameplay runtime modules, AST generation,
network remotes, state machines, or generic game authoring.

The governing documents are:

- [AGENTS.md](AGENTS.md) — current engineering rules.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — implemented architecture.
- [docs/BASALT.md](docs/BASALT.md) — product thesis and invariants.
- [docs/VISUALS.md](docs/VISUALS.md) — hierarchical art direction and asset policy.
- [docs/EVALS.md](docs/EVALS.md) — evidence and claim semantics.
- [docs/ROADMAP.md](docs/ROADMAP.md) — M1–M5 milestones.
- [docs/RESEARCH.md](docs/RESEARCH.md) — research index.
- [docs/sources/world-claw.pdf](docs/sources/world-claw.pdf) — WorldClaw source.

## What has been implemented

### Clean-break purge and rebrand

- Root package/bin are `basalt`; the old Forge package identity and paths are
  deleted rather than aliased.
- Gameplay runtime, gameplay AST/source staging, dashboards, old visual-world
  state, full-scene Blender review packages, old provider wrappers, and stale
  fixtures/formal specs were removed.
- The plugin is now `BasaltStudioPlugin`; the built connector is written to
  `$HOME/Documents/Roblox/Plugins/BasaltStudioPlugin.rbxmx`.
- `.forge` is not supported. The current storage root is `.basalt`, and it is
  currently absent/clean because no persistent build has been created.
- Old schemas/caches are not migrated. This is intentional and follows the
  no-compatibility rule.

### World compiler

- `packages/world-planning` owns `TerrainPlan`, deterministic terrain fields,
  region weights, material weights, route grades, constructed surfaces, and the
  shared `PlacementSurfaceIndex` with exact triangle raycasts.
- `packages/world-compiler` owns macro/meso/micro/partition compilation,
  family-level deterministic population, route exclusions, seeded variation,
  chunk emission, and generic relation solving.
- `packages/world-compiler/src/relations.ts` provides typed open-vocabulary
  distributions (`single`, `along_path`, `surface_grid`, `poisson_scatter`,
  `cluster`) and typed relations including `on_surface`, `support`, `embed`,
  `align_upright`, `align_to_normal`, `face_target`, `inside_region`,
  `attach_socket`, `maintain_clearance`, and `interlock_clearance`.
- `packages/asset-factory/src/modular-kit.ts` defines `SocketContract`,
  `PreparedModularKitArtifact`, trim mappings, and typed `AssemblyRecipe`
  shell/socket decomposition for large landmarks.
- Neural geometry is hard-limited to `focal_insert` requirements whose largest
  expected bound is at most `8.0` studs. Micro scatter and structural kits must
  use catalog or trusted procedural families. Neural jobs are family-level,
  offline, and never carry per-instance transforms.
- Seasonal/regional overlays bind the exact `TerrainFieldArtifact` hash and
  change only materials, foliage, lighting, and atmosphere.

### Asset finishing and connector

- Blender is an isolated asset-finishing worker. It handles source transform
  baking, geometry repair, UV generation/re-atlasing, PBR baking, support and
  collision evidence, sockets, and bounded local previews. It is not a
  complete-world renderer or review gate.
- The adaptation worker computes a linear 0.5m contact blend. Tensor routes
  retain the `BasaltContactBlend` point attribute; authored GLB routes use an
  exporter-safe material contact-mask lowering so source color/opacity bindings
  are not damaged.
- `packages/studio-protocol` and `packages/studio-bridge` retain canonical
  chunk transactions, detached preflight, ChangeHistory phases, commit/rollback,
  host-sealed readback, and revision reconciliation.
- The current connector manifest is still a bounded transaction/instance
  manifest. Actual voxel/MeshPart geometry payload lowering and creator-run
  Studio validation are not yet complete.

### Research and documentation

The current research docs incorporate the requested foundations:

- Q32.32 spatial keys, MurmurHash3 seeded population, IEEE-754 boundary policy,
  mobile/Jetsam budgets, and the Lagoon of the Basalt Spire acid test.
- Lloyd-relaxed CVT, joint elevation quantization, Priority-Flood hydrology,
  `R_buffer`, trim-sheet energy `E(k,T_i)`, and formal modular-kit interfaces.
- Four-tier style hierarchy, geometric tokens, upward weathering, 2D anchors,
  and procedural PBR reskinning before neural generation.
- Catalog ingestion and family retrieval are indexed and bounded; the model
  never evaluates thousands of source meshes per instance.

## Verification completed

These commands were run locally after the latest changes:

- `npm run build --silent` — passed.
- `npm test` — passed, **20 tests / 0 failures**. This includes formatting,
  lint, documentation, authoring generality, visual architecture, Rojo,
  runtime manifest, compiler, relation, routing, overlay, connector, and
  plugin checks.
- `npm run asset-adaptation:semantics` — passed under Blender 5.2.1.
- `python3 -m unittest workers/neural-provisioning/test_control_plane.py` —
  passed, **14 tests / 0 failures**.
- `npm run plugin:build` — passed and materialized the Basalt plugin at the
  path above.
- `git diff --check` — passed.
- Stale-name scan found no Forge package/runtime identifiers or deleted
  `scene-production`/`studio-runtime` imports.
- `.basalt` is absent/clean and no project-specific Basalt/Forge/SAM3/TRELLIS
  directories remain under `/tmp`.

No model, Modal, or Roblox Studio calls were made during verification. No claim
in this repository is Studio-verified.

## Working-tree state

The working tree is intentionally dirty because this is an in-progress clean
break from the committed Forge state. Do not restore deleted files, create
compatibility aliases, or add migrations. Preserve the existing unrelated
changes. The previous repository `HEAD` is:

```text
15ca3ff feat: add family hints and catalog inventory scripts
```

There is no need to create a rollback snapshot for this handoff; the user
explicitly authorized the clean-break purge and renamed `.forge` to `.basalt`.

## Unresolved claims and next smallest evidence-producing task

The architecture/contracts are in place, but this is not yet a finished map.
The next task should be concrete and local:

1. Inspect the real `.basalt/trusted-sources` catalog/family inputs without
   exposing credentials.
2. Build one domain-neutral family manifest with measured bounds, support,
   material roles, sockets, and content hashes.
3. Compile one small partition from a retained world-plan fixture through
   macro → meso → micro → partition.
4. Add actual accepted geometry handles to the emission manifest and implement
   fixed connector lowering for terrain voxel writes and instanced MeshParts.
5. Materialize the generated place and connector artifact, then give the user
   exact Studio import, save/reopen, play, and capture steps. Do not launch
   Studio from Basalt.

Only after this plumbing proof should the offline neural family factory be run
conservatively through Modal. Use exact request hashes, concurrency one,
no automatic retries, output-volume handoffs, and the configured budget caps.

The first visible milestone is a real partitioned Basalt world in Studio, not
another schema-only test or isolated model preview.
