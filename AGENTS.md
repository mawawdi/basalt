# Basalt engineering rules

Basalt is a dedicated hierarchical world compiler. Keep this file operational;
documentation authority is split deliberately:

- `docs/ARCHITECTURE.md` defines the implemented world-compiler architecture.
- `docs/BASALT.md` defines the product thesis and invariants.
- `docs/VISUALS.md` defines hierarchical art direction, assets, materials, and evidence.
- `docs/EVALS.md` defines evidence tiers and claim semantics.
- `TASKS.md` is the only active backlog and work-status authority. It contains only
  actionable `Now`, `Ready`, and `Blocked` cards; completed cards are deleted
  because Git history is the record.
- `docs/RESEARCH.md` indexes current rationale and source evidence.

## Problem framing and experimental discipline

- Before designing a bespoke subsystem for a problem that may be common in industry or
  research, first inspect maintained open-source implementations, production systems, and
  primary literature. Record the closest proven baseline, what can be reused, and the
  specifically Basalt-owned remainder. Prefer the smallest proven pattern over recreating an
  entire external stack or inventing a framework from first principles.
- Separate commodity capability from the actual product differentiator. Reuse established
  approaches for ingestion, metadata extraction, indexing, retrieval, rendering, and similar
  infrastructure; spend custom complexity only on guarantees Basalt uniquely needs, such as
  deterministic realization, substitutability, spatial correctness, and engine verification.
- Match every model and metric to the job it was validated to perform. Retrieval embeddings
  are not calibrated classifiers, class probabilities are not novelty estimates, and model
  confidence is not evidence of correctness. Do not derive authoritative thresholds from an
  unvalidated score transformation. Calibrate against representative labeled examples and
  retain model outputs as hypotheses until the relevant gate admits them.
- Establish the simplest credible baseline and run a small, deliberately varied pilot before
  scaling a corpus run or expanding the architecture. Include obvious positive cases,
  negatives, out-of-vocabulary cases, style variation, and known boundary cases. Define the
  expected outputs and stop conditions before running it, then inspect actual examples rather
  than relying only on aggregate scores.
- Treat systematic failure as evidence against the formulation before blaming model size,
  data volume, or compute. Class collapse, near-universal rejection, nonsensical confidence,
  or identical errors across diverse inputs require an immediate stop and framing audit:
  verify input evidence, task/label coverage, prompt and score semantics, reference behavior,
  and whether the problem should be retrieval, ranking, generation, or classification.
- Avoid requiring global certainty when the product only needs a local decision. Prefer
  broad searchable evidence plus requirement-specific retrieval and verification over eager,
  exhaustive classification of an entire corpus. Escalate only ambiguous candidates and
  boundary decisions to review.
- A more capable model or larger infrastructure is justified only by a measured improvement
  on the bounded pilot. Compare it against the simpler baseline with the same inputs and
  acceptance criteria. Do not scale a failed experiment, and do not promote experimental
  artifacts or terminology into canonical contracts or active documentation.

- Make clean breaks. Delete superseded schemas, commands, packages, and storage paths;
  do not add compatibility readers, migrations, deprecated aliases, or old/new fallbacks.
- Do not version asset or entry handles, directory names, or registry identities. Entry
  identity is content-addressed; replacing measured evidence replaces the sealed artifact
  instead of introducing `v1`, `v2`, revision suffixes, or parent links.
- Keep paths and artifact names stable and unversioned. Do not add version suffixes to
  directories, filenames, registry roots, cache roots, or operational artifacts; replacing
  the canonical artifact must not require renaming every downstream reference. Protocol,
  schema, and ABI identifiers are also unversioned: this repository has one current contract
  and makes clean breaks instead of encoding edit history into names.
- Keep the semantic-authority boundary: creator intent, agent hypotheses, platform policies,
  and evaluation evidence remain distinct.
- Keep generic world-compiler packages independent of fixtures, example maps, and evaluator
  solutions. Open-vocabulary art direction must not become fixture-specific code.
- Keep model orchestration provider-neutral. Providers are one-turn transports and never
  enter Basalt contracts.
- Preserve the spatial authority boundary: models propose semantic hypotheses and composition;
  typed terrain, surface, relation, socket, and budget solvers decide geometry and transforms.
- Catalog substitution grouping is decided by evidence and the author: measured proposals
  derive only from metric bounds (including Q32.32 envelopes), topology, material/PBR evidence,
  support/contact, and collision facts, and the seal admits only genuine independent
  substitutability. Review
  tooling may additionally surface source-path hints (vendor directory organization, filename
  stems) to pre-split review buckets, labeled as hints; hints never decide membership, never
  enter the seal, and never appear in Basalt contracts — declarations reference asset IDs and
  content hashes, folders mirror declared nouns. An explicit `_Collision` suffix may identify a
  non-renderable collision companion only, never substitution-set membership. Unmeasured or ambiguous
  assets remain pending/quarantined.
- Keep workspace access bounded to declared roots, regular files, hash-guarded replacement,
  explicit absent creation, and fail-closed path/symlink handling.
- Use `eligible`, `rejected`, and `incomplete` for local gates. Never create an
  `engine_verified` assertion without authoritative creator-run engine evidence.
- Keep Roblox import plans canonical JSON interpreted by fixed connector source. Do not add arbitrary
  code, expressions, callbacks, or model-authored DCC scripts.
- Blender is an isolated asset-finishing worker. It must not be required to render or review
  complete worlds. World previews and diagnostics use lightweight partitioned evidence paths.
- Neural generation is an offline catalog-factory route. It must not block macro planning,
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
