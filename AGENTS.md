# Basalt engineering rules

Basalt is a dedicated hierarchical world compiler. Keep this file operational;
documentation authority is split deliberately:

- `docs/ARCHITECTURE.md` defines the implemented world-compiler architecture.
- `docs/BASALT.md` defines the product thesis and invariants.
- `docs/VISUALS.md` defines hierarchical art direction, assets, materials, and evidence.
- `docs/EVALS.md` defines evidence tiers and claim semantics.
- `docs/ROADMAP.md` defines future work and acceptance criteria.
- `docs/RESEARCH.md` indexes current rationale and source evidence.

- Make clean breaks. Delete superseded schemas, commands, packages, and storage paths;
  do not add compatibility readers, migrations, deprecated aliases, or old/new fallbacks.
- Do not version asset or family handles, directory names, or registry identities. Family
  identity is content-addressed; replacing measured evidence replaces the sealed artifact
  instead of introducing `v1`, `v2`, revision suffixes, or parent links.
- Keep paths and artifact names stable and unversioned. Do not add version suffixes to
  directories, filenames, registry roots, cache roots, or operational artifacts; replacing
  the canonical artifact must not require renaming every downstream reference. Protocol,
  schema, and ABI identifiers may carry a version only when it is part of the typed contract
  identity, never as a path-versioning convention such as `-v1` or `-v2`.
- Keep the semantic-authority boundary: creator intent, agent hypotheses, platform policies,
  and evaluation evidence remain distinct.
- Keep generic world-compiler packages independent of fixtures, example maps, and evaluator
  solutions. Open-vocabulary art direction must not become fixture-specific code.
- Keep model orchestration provider-neutral. Providers are one-turn transports and never
  enter Basalt contracts.
- Preserve the spatial authority boundary: models propose family plans and composition;
  typed terrain, surface, relation, socket, and budget solvers decide geometry and transforms.
- Catalog family grouping is decided by evidence and the author: measured family proposals
  derive only from metric bounds (including Q32.32 envelopes), topology, material/PBR evidence,
  support/contact, and collision facts, and the seal admits only on kind evidence. Review
  tooling may additionally surface source-path hints (vendor directory organization, filename
  stems) to pre-split review buckets, labeled as hints; hints never decide membership, never
  enter the seal, and never appear in Basalt contracts — declarations reference asset IDs and
  content hashes, folders mirror declared nouns. An explicit `_Collision` suffix may identify a
  non-renderable collision companion only, never family membership. Unmeasured or ambiguous
  assets remain pending/quarantined.
- Keep workspace access bounded to declared roots, regular files, hash-guarded replacement,
  explicit absent creation, and fail-closed path/symlink handling.
- Use `eligible`, `rejected`, and `incomplete` for local gates. Never describe output as
  Studio-verified without authoritative creator-run Studio evidence.
- Keep Studio plans canonical JSON interpreted by fixed connector source. Do not add arbitrary
  code, expressions, callbacks, or model-authored DCC scripts.
- Blender is an isolated asset-finishing worker. It must not be required to render or review
  complete worlds. World previews and diagnostics use lightweight partitioned evidence paths.
- Neural generation is an offline family-factory route. It must not block macro planning,
  terrain, routes, or deterministic population. Accepted results are cached by content hash.
- The user runs all Roblox Studio checks. Never launch or operate Studio. Provide the exact
  place, connector artifact, commands, and click sequence, then wait for the user's result.
- Use `apply_patch` for repository edits and preserve unrelated work.
- Run `git diff --check`, the TypeScript build, current backend tests, plugin checks,
  and a temporary-output Rojo build before FINAL completion. Do not make model calls or Studio runs
  during tests. No need to constantly run the tests after every change, they take time. However, do not finish until the tests pass.
- Materialize the final connector with `npm run plugin:build` at
  `$HOME/Documents/Roblox/Plugins/BasaltStudioPlugin.rbxmx`.

## Commands

- `npm test`: run the full test suite
- `npm run build`: build the project
- `npm run lint`: run the lint task
- `npm run format`: run the format task

## Code Map

- `packages`: packages
- `test`: automated tests
- `docs`: project documentation

## Conventions

- Use ESM `import` and `export` syntax.
- Use `.js` extensions in relative imports.
- Name test files `*.test.ts`.

- DO NOT USE SUBAGENTS UNLESS TOLD TO DO SO.
