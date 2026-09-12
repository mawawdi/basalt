# Deterministic Asset Resolution

This document is the authority for how Basalt resolves a creator-facing asset
reference into sealed, placeable family geometry. It describes implemented
behavior only: every normative statement here is backed by the implementation
it cites. Design directions that are not implemented live in
[Appendix A](#appendix-a-future-design-directions-not-implemented) and are
explicitly marked as future.

Related authorities: [ARCHITECTURE](../ARCHITECTURE.md) defines the pipeline
this resolution feeds; [ROADMAP](../ROADMAP.md) M2 defines the acceptance bar
this baseline must clear; [RESEARCH](../RESEARCH.md) indexes why the tuning
decisions below were made.

## 1. Resolution Model

Asset resolution is a three-stage pipeline with no retrieval step:

1. **Declare.** Each family is declared by an authored declaration that names
   its semantic handle, treatment role, member assets, surface affinities, and
   socket grammar. Declarations are the only source of family membership.
2. **Measure.** The catalog worker measures every declared asset (metric
   bounds, topology, material/PBR evidence, support/contact, collision facts)
   and checks kind admission under section 4.
3. **Seal.** A family seals when every declared member is measured,
   supported, kind-coherent, and treatment-compatible. Sealing mints the
   content-addressed family ID (section 5) and freezes the family card
   (section 6).

There is no fuzzy matching, no similarity ranking, and no discovery of
families from directory contents. Undeclared assets, unmeasured assets, and
members that fail kind admission keep the family `incomplete` with a
recorded reason; they never silently join a sealed family. Absolute size
never admits or rejects on its own: a miniature and a landscape variant of
one shape belong to one kind.

## 2. Folder Invariant

The catalog root holds one subfolder per family, named exactly by the family
morphology noun, plus a single `_pending` quarantine folder. For example, the
family `props/clutter/rustic_iron/barrels` lives in `barrels/`.

The folders are a **mirror**, not a source of truth: membership flows from
authored declarations to folders, never the reverse. Classifying a family
from a filename, directory name, or vendor prefix violates the
evidence-driven grouping rule. The only filename signal the pipeline honors
is an explicit `_Collision` suffix, which marks a non-renderable collision
companion of an already-declared asset — never family membership.

`npm run catalog:layout:check` enforces the mirror: every root subfolder must
be a declared family noun or `_pending`, and every declared family must have
its folder. Quarantined assets (section 9) wait under `_pending` until a mesh
review either declares them or rejects them.

## 3. Namespace Grammar

A semantic family handle has four core segments with optional vendor,
fork, extension, and variant markers:

```
[@vendor/]domain/spatial_role/style_motif/morphology_noun[@fork][+extension][#variant]
```

- `domain`: `nature | geology | architecture | infrastructure | props |
foliage | industrial` (closed).
- `spatial_role`: `foundation | barrier | canopy | groundcover |
focal_insert | portal | connector | clutter` (closed).
- `style_motif`, `morphology_noun`: `[a-z0-9_]+` — lowercase, digits,
  underscores only. Hyphens are rejected here.
- `vendor`: `[a-z0-9_-]+` — hyphens are allowed in the vendor namespace only.
  The vendor prefix distinguishes same-noun families from different sources;
  it never influences ranking because there is no ranking step.
- `fork`: `@(season|reskin|weathering|damage)_[a-z0-9_]+` — a material
  fork of shared geometry. Any material change mints a new family ID
  (section 5).
- `extension`: `+ext_[a-z0-9_]+` — a structural extension of the base kit.
- `variant`: `#(tall | medium | short | curved | corner_in | corner_out |
straight | cluster | stump | pillar | wall_straight | wall_corner |
wall_tee | archway | cap)` (closed, 15 tokens).

Canonical examples (all accepted by the parser):

```
nature/canopy/stylized_painterly/broadleaf_oak#tall
nature/canopy/stylized_painterly/broadleaf_oak@season_autumn
@synty/architecture/foundation/castle_keep/castle_wall+ext_round_tower#wall_corner
```

The parser is `parseFamilyHandle` in
`packages/basalt-types/src/taxonomy.ts`. Anything outside the closed
enumerations throws a taxonomy error; there is no lenient path.

The `spatial_role` segment selects a treatment preset (density and
clearance defaults, section 4), not a size box. The seal validates that
the declared treatment is physically realizable for the members; it never
checks member dimensions against role bounds, because no such bounds
exist.

A family may seal with a single measured asset. Downstream planners may
demand more archetypes for a given requirement through `min_archetype_count`
(section 7); that is a per-requirement planning floor, not a sealing rule.

## 4. Kind Admission and Treatment

Membership is gated by kind, never by absolute size. The seal
(`findKindAdmissionViolations` in
`packages/catalog-intelligence/src/authored-families.ts`) checks three
things; any violation leaves the family `incomplete` with a recorded
reason:

1. **Support.** Every member must carry measured bottom-support evidence
   (`primaryContact === "bottom"`). The worker measures support in one
   direction today, so bottom contact is the only support signal a
   placeable family can stand on.
2. **Sibling coherence.** Members must cohere as one scale-free kind:
   every member sits within `KIND_COHERENCE_THRESHOLD = 3.0` of the
   declaration medoid under `siblingCoherenceDistance`, which compares
   aspect ratios, submesh structure, topology band, contact, and
   material overlap — never absolute size or triangle count. A
   miniature and a landscape variant of one shape cohere; a blade
   declared beside a slab does not. The threshold coheres the nine
   dissolved starter families whole (worst medoid radius 2.959).
3. **Treatment compatibility.** The handle's role selects a density and
   clearance preset, and the seal validates the preset is physically
   realizable for the largest member: `max_per_hectare × (extent + 2 ×
clearance)²` must fit one hectare (`HECTARE_STUDS2`). A treatment
   the members cannot realize is rejected with figures; zero-density
   (hand-placed) treatments pass vacuously.

Treatment presets (density per hectare from `ROLE_DENSITY_DEFAULTS`,
exclusion radius from `ROLE_CLEARANCE_DEFAULTS`):

```
role          min/ha   max/ha   clearance
foundation    0        0        0
barrier       0        0        0.5
canopy        12       64       4
groundcover   200      2000     0
focal_insert  2        20       2
portal        0        0        6
connector     0        0        1
clutter       50       500      0.2
```

Roles denote treatment classes, not size boxes: there is no per-role
metric envelope anywhere in the pipeline, and no code path compares a
member dimension against a role limit. Size-dependent gates live at the
consumers that need them — the neural factory's 8-stud input limit, the
world-plan 8/axis cap, chunk and budget checks — never at membership.
The bonsai principle: placement is contextual (scatter in a forest,
insert in a courtyard), so kind must not flip with size.

## 5. Content-Addressed Family Identity

Sealing mints the family ID from a five-leaf Merkle commitment:

```
handle_leaf    = sha256(core handle: domain/role/motif/noun)
geometry_leaf  = sha256(sorted member geometry hashes)
material_leaf  = trim-sheet manifest hash, or an explicit
                 no-material marker when the family has no trim bands
physics_leaf   = collision-companion hash
socket_leaf    = socket-grammar hash, or sha256("no_sockets")
                 when the family declares no sockets
family_id      = "family_" + core_handle(slashed to _) + "_" + root[0:12]
```

Any change to the handle, member geometry, trim commitment, physics
companion, or socket grammar mints a different ID. There are no version
suffixes and no parent links: replacing measured evidence replaces the
sealed artifact. The reference is `computeFamilyMerkleId`, which mirrors
`basalt-types/src/merkle.ts` (`stableJson` sorts object keys and preserves
array order; `sha256` is lowercase hex).

The vendor prefix, fork tag, extension tag, and variant token do not enter
the core handle: `@synty/.../oak` and `@kenney/.../oak` are distinct
declarations that seal as distinct families with distinct geometry leaves.

## 6. Family Cards

The sealed family card is the planner-facing contract. Measured per-member
facts stay per-member; nothing is averaged away:

- `handle`, `fid`, `roles` — identity and treatment role.
- `archetypes` — one descriptor per member: variant token, measured
  per-member bounds in studs, and mass. Mass is a box-volume estimate
  (member bounds × a stylized density constant); the constant is an
  assumption flagged for review under M2, not measured physics.
- `affinities` — declared placement surfaces, maximum slope in degrees,
  and clearance radius in studs from the treatment preset. Surfaces are
  author-declared and measurement-checked, not inferred from paths.
- `density` — instances per hectare from the treatment preset
  (section 4). Zero-density rows are hand-placed, never scattered.
- `sockets` — grid step, elevation step, and compatible groups, or `null`
  for families with no socket grammar. Foliage families additionally seal
  mount sockets: measured attachment slots for epiphytes and vines.
  Families seal sockets and trim bands only as their measurements land.

Source: `packages/basalt-types/src/family-card.ts` and the card tests in
`test/family-cards.test.ts` and `test/authored-families.test.ts`.

## 7. Palette Serialization and the World Plan

`serializePaletteMenu` compresses sealed cards into the deterministic JSON
payload planners consume: cards sorted by family ID, roles sorted,
archetypes sorted by variant token with token-plus-bounds pairs, surfaces
sorted, density as a pair, sockets reduced to elevation step plus sorted
compatible groups. There is no universal byte envelope — payload size is
a measured property of the sealed menu, and planners that need a smaller
menu seal a smaller one. (No families are sealed at this writing; the
starter catalog is being re-declared under kind admission.)

The world plan consumes the menu in two branches:

- **Exploit bindings** attach a region to a sealed family ID at a target
  density. The binding is valid only if the ID resolves to a card in the
  sealed menu.
- **Explore requirements** declare coverage gaps: a suggested handle,
  treatment role, bounding envelope, target texel density, minimum
  archetype count, and surface affinity. Each requirement carries its own
  bounding envelope; insert-class gaps use an 8-stud envelope matching the
  neural factory's input limit.

The plan's `palette_menu` is required and non-empty: a plan that binds
regions must carry the sealed cards it binds against.

## 8. Catalog Pipeline and Diagnostics

The pipeline runs from authored declarations through measurement to the
sealed inventory:

1. Declarations name each family's handle, treatment role, members,
   affinities, and socket grammar. No declaration, no family — undeclared
   assets on disk are invisible to the seal.
2. The worker measures each member and checks kind admission
   (section 4), trim-band coverage where trim sheets are declared, and
   socket-grammar conformance where sockets are declared.
3. Sealed families land in the catalog inventory with their cards;
   families with unmeasured, unsupported, incoherent, or
   treatment-incompatible members land `incomplete` with per-member
   reasons.

`npm run visual:catalog:measure` rebuilds the inventory; the worker reports
a rejection count alongside acceptances so missing evidence is visible as a
number, not an absence. Trim-band energy minimization seats measured UV
coverage into the shared sheet; the objective weights are declared in the
trim specification schema, not tuned per asset. Families with partial trim
or socket evidence seal without those commitments and re-seal — under a new
ID — when the measurements complete.

Review inputs are two separate artifacts. `visual:catalog:propose` emits
evidence cohorts (shape, structure, support, material — never paths).
`visual:catalog:review-hints` overlays advisory pre-splits and
cross-cohort merge candidates derived from vendor source organization,
labeled as hints. The author composes declarations from both; the seal
sees only the declaration and the measurements. Path-hint logic lives in
the review script alone — no package under `packages/` reads source paths
for grouping.

## 9. Scale Truth and Quarantine

Catalog measurements are metric. GLB sources declare meters by format
spec, and the pipeline parses them as meters directly: true-scale assets
measure true. No per-source scale evidence exists anywhere in the
pipeline — not in code, not in the source manifest, not in node
transforms — so there is nothing to reinterpret a misscaled export with;
scale-incoherent files quarantine as corrupt. Studs convert at the single
constant `STUD_METERS = 0.28`.

The starter baseline holds 863 assets: 774 declared in 275 sealed
families, 89 quarantined with recorded reasons, 0 untriaged.
Quarantine reasons must follow the current admission model — every
bounds-driven reason was voided when kind admission landed, and the
affected assets re-entered review. Standing reasons are
kind-independent:

- 41 non-renderable `_Collision` companions with scale-incoherent
  geometry (low-triangle meshes at km-scale spans) that pairing gates
  cannot bind.
- 22 vehicles confined pending the vehicle-scope decision (held, not
  rejected).
- 26 authorial rejects adopted from the output.txt family map:
  sky/backdrop meshes and volumetric clouds, macro ocean planes,
  detached tree crowns and hanging epiphytes with no mounting
  consumer, and one scale-anomaly organic asset.

These assets wait under `_pending`. Quarantine is a first-class outcome:
`eligible`, `rejected`, and `incomplete` are the only local gate verdicts,
and no local gate may claim Studio verification — that verdict belongs to
authoritative creator-run Studio evidence alone.

## 10. Verification

Behavioral claims in this document are covered by the repository gates,
not by a paper validation suite:

- `npm test` — taxonomy, family-card, authored-family, trim-sheet,
  world-plan, and palette suites.
- `npm run catalog:layout:check` — folder-mirror invariant (section 2).
- `npm run docs:check` — this document's links and structure.
- `npm run plugin:build` plus the Rojo build — connector and place
  integrity before completion.

## Appendix A. Future Design Directions (Not Implemented)

The following were specified in earlier drafts of this document and are
retained here as design direction. None of them is implemented, and none
of them may be cited as behavior:

- **Fuzzy candidate ranking** with vendor-priority, style-similarity, and
  texel-delta weights. There is no ranking step; conflicts between
  same-noun families resolve by distinct handles and distinct IDs.
- **VLM-as-judge validation** and style-compatibility vector spaces.
  Style stays an author-declared motif checked against measured evidence,
  not a computed embedding.
- **Acquisition cascades** with tiered fast paths and stated latencies.
  Family acquisition is declaration plus measurement; there are no
  re-skin tiers and no latency figures.
- **Neural factory batch protocols.** Neural generation remains an
  offline family-factory route whose accepted results cache by content
  hash; it has no batch API in the resolution path.
- **Performance budgets** (frame rates, chunk streaming figures) and
  **reference-scenario walkthrough timings.** Population and Studio
  reconciliation are governed by [ARCHITECTURE](../ARCHITECTURE.md) and
  [EVALS](../EVALS.md) evidence tiers, not by figures in this document.

## Appendix B. Clean-Break Resolutions

This rewrite resolves the prior draft's contradictions toward
[ROADMAP](../ROADMAP.md) M2 by deletion:

- C1: handle examples are four-segment throughout; the three-segment
  `@synty/architecture/castle_wall` form is removed.
- C2: the character-class rule is vendor-allows-hyphens,
  core-segments-reject-hyphens, matching the parser.
- C3: seal minimum (one measured asset) and planning floor
  (`min_archetype_count` per requirement) are distinguished.
- C4 (superseded): the tuned spatial-role bounds table is deleted with
  the kind-admission landing. Size-gated kinds fragmented natural
  families (bonsai vs landscape variants in different roles), so the
  table, its tuning rationale, and the measured relabels it motivated
  are removed outright — not migrated, not aliased.
- C5: mass is a documented box-volume estimate with an assumed density
  constant, not derived physics.
- C6: palette sizes are measured, not an envelope the serializer cannot
  meet. (Stale figures removed with the family dissolutions.)
- C12: the world-plan example carries its required `palette_menu`.
- C13: the paper TypeScript validation suite is replaced by the
  repository gates in section 10.

Kind-first resolutions, same clean-break rule:

- K1: `findRoleBoundsViolations`, `TAXONOMY_ROLE_BOUNDS`,
  `admissibleRoles`, and the size-aware proposal distance are deleted.
  No compatibility readers, no deprecated aliases.
- K2: the nine sealed and three incomplete declarations are dissolved;
  all 77 members re-entered `_pending` for re-declaration under kind
  admission. Family IDs from the bounds era are not preserved or
  mapped.
- K3: bounds-driven quarantine reasons were voided with the model that
  produced them; only kind-independent reasons (corrupt measurement,
  unsplittable bundles, byte duplicates, non-renderable companions)
  stand.
