# Basalt

Basalt compiles coherent, editable game-world scaffolds over long horizons. It is not a
one-shot scene generator and not a thin model wrapper. Its core product is a verification
loop that makes semantic, spatial, catalog, and engine claims explicit and replayable.

## Thesis

A useful generated world needs several forms of authority at once:

- creator intent says what should exist;
- a stable semantic kernel says what those claims mean;
- measured catalog evidence says what assets physically are;
- deterministic solvers decide geometry, topology, occupancy, and transforms;
- engine readback says what was actually imported.

Conflating those authorities produces demos that look plausible but cannot be audited,
recompiled, or scaled. Basalt keeps them separate and binds each result to exact evidence.

## Invariants

1. **Models propose; contracts admit.** Captions, search results, generated meshes, and
   validator verdicts are hypotheses until an explicit admission gate accepts evidence.
2. **Meaning is durable and additive.** Existing semantic commitments do not change when
   a new asset pack arrives. A novel noun reuses an existing commitment, receives a
   reviewed additive leaf, or remains incomplete.
3. **Semantics are faceted.** Denotation is separate from affordance, state, treatment,
   contextual role, relation, and realization form.
4. **Geometry is deterministic.** Models may propose composition; typed solvers own
   terrain, surfaces, routes, interfaces, occupancy, placement, and budgets.
5. **Catalog entries say one thing.** A substitution set contains only independently
   interchangeable alternatives. Assemblies, attachments, routes, and environment
   realizers have distinct contracts.
6. **Failure is data.** Valid missing evidence is `incomplete`; contract violations are
   `rejected`; only satisfied claims are `eligible`. No silent fallback upgrades either.
7. **Artifacts are immutable.** Each stage binds exact predecessor and evidence hashes.
   Derived output never mutates a parsed input.
8. **Invalidation is local.** Artifacts bind minimal semantic closures and hierarchical
   task inputs, so unrelated additions do not invalidate a world.
9. **The compiler is engine-neutral.** Its units are meters and its output is a
   `WorldBuild`. Roblox studs and Studio behavior live only in the Roblox package.
10. **Engine truth comes from the engine.** Offline tests cannot create
    `engine_verified` evidence.
11. **There is one current contract.** Basalt uses clean breaks, stable unversioned paths,
    and no compatibility readers.
12. **Infrastructure is constructed as one system.** A grounded route, its designed profile,
    roadbed, shoulders, junctions, material mask, and vegetation mask derive from one sealed
    resolution. Clearance alone cannot make a floating or buried strip eligible.

## What quality means

Compilation is not successful because code parses or objects exist. A high-quality
scaffold must preserve the requested game loop, spatial legibility, art direction,
topological correctness, usable routes and rooms, asset coherence, performance budgets,
and editability. Each claim needs the strongest practical deterministic verifier; visual
or experiential claims that cannot yet be verified remain honestly incomplete.

Refinement is therefore bounded and evidence-driven. A proposal changes only declared
parameters or alternatives, recompiles the affected dependency closure, and reruns the
observations that depend on it. Geometric eligibility and visual assessment remain
separate: consistent style references do not by themselves prove that a composition looks
harmonious.

## Catalog strategy

Basalt searches before it generates. For a requirement it should:

1. retrieve coherent measured candidates from the catalog;
2. adapt an otherwise suitable mesh only through an explicit offline factory task;
3. extend a genuine entry only after the new member proves the same full signature; or
4. generate a new asset through a configured neural provider and return it to the normal
   measurement, evidence, review, and admission pipeline.

Open-vocabulary metadata makes thousands of assets searchable without forcing them into a
closed classifier. It reduces review effort; it does not remove the semantic-authority
boundary.
