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
- Keep the semantic-authority boundary: creator intent, agent hypotheses, platform policies,
  and evaluation evidence remain distinct.
- Keep generic world-compiler packages independent of fixtures, example maps, and evaluator
  solutions. Open-vocabulary art direction must not become fixture-specific code.
- Keep model orchestration provider-neutral. Providers are one-turn transports and never
  enter Basalt contracts.
- Preserve the spatial authority boundary: models propose family plans and composition;
  typed terrain, surface, relation, socket, and budget solvers decide geometry and transforms.
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
  and a temporary-output Rojo build before completion. Do not make model calls or Studio runs
  during tests.
- Materialize the final connector with `npm run plugin:build` at
  `$HOME/Documents/Roblox/Plugins/BasaltStudioPlugin.rbxmx`.
- Report changed/deleted files, commands and exact results, model/Studio calls, unresolved
  claims, and the next smallest evidence-producing check.
