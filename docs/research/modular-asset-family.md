# Hierarchical art direction and modular asset families

**Status:** current design direction; implementation evidence is tracked in the
catalog and family tests, not in this research note.

The central production insight is that a world should be planned and populated
by **asset families**, not by independent meshes. A family is a small set of
validated archetypes that share a role, visual grammar, scale envelope, material
realization policy, and (for structural kits) socket grammar. Instances reuse
those archetypes through deterministic population artifacts.

This is the missing layer between a creator brief and thousands of catalog or
generated assets. It reduces model calls, keeps style coherent, preserves
instancing, and gives the spatial compiler something more meaningful than a
list of unrelated props.

## Hierarchy

```text
global style contract
  -> regional style overlay
    -> asset-family revision
      -> validated archetypes
        -> deterministic instances
```

Basalt treats these as four explicit style tiers:

0. **Global world style** — shape language, palette, edge treatment, detail
   bands, texel density, lighting, and anti-goals.
1. **Biome overlay** — bounded seasonal or regional material, foliage,
   atmosphere, and density changes over the same terrain field.
2. **Asset family** — shared silhouette grammar, bevel tokens, metric envelope,
   material roles, sockets, and variation policy.
3. **Archetype/instance** — one prepared mesh or assembly member and the solved
   transform that places it on an authoritative surface.

The global contract supplies shape, edge, material, palette, texel-density,
lighting, and anti-goal envelopes. A region adds bounded variation, atmosphere,
wear, density, motifs, and negative space. A family revision binds several
archetypes to that direction. An archetype is a concrete prepared asset; an
instance is only a solved transform referring to an accepted archetype.

Families are role-coherent: a pine family may contain saplings, mature trees,
stumps, and fallen logs; a rock family may contain boulders and fractured
outcrops; a construction kit may contain walls, corners, caps, and connectors.
Trees and rocks do not become one family merely because they share a biome.

## What must be shared and what may vary

Every family member must share canonical axes, a declared pivot/contact policy,
metric bounds, delivery budgets, and a compatible material language. The family
may use tiling PBR, trim sheets, a family atlas, or bounded unique detail. One
texture atlas and one bevel radius are targets only when they improve the result;
they are not universal invariants. Roblox batching and memory effects require
Studio measurement.

Structural families may additionally expose typed sockets, mating boundaries,
snap rules, and exposed surfaces. These are verified interfaces. Neural geometry
does not get to claim watertight sockets or articulation without deterministic
part, pivot, collision, and binding evidence.

## Cross-family coherence

Basalt keeps coherence through three mechanisms:

1. **Shape grammar:** generators and procedures receive scale-aware edge,
   curvature, silhouette, and detail-band envelopes. High-frequency photographic
   noise is suppressed when it conflicts with the declared style.
2. **Surface realization:** a typed material graph applies palette, roughness,
   wear, contact, height, slope, and region masks consistently. Upward weathering
   can be one recipe, but vertical moss, undercuts, and species-specific rules
   remain expressible.
3. **Context anchors:** new family proposals see approved family cards and the
   target region context. Concept images are advisory; isolated archetype
   references are still segmented, lifted, adapted, and admitted independently.

Cross-family coherence is enforced with shared geometric tokens (bevel radius,
edge segment policy, and silhouette-break scale) and one surface realizer. An
upward-weathering mask may use the measured normal criterion

```text
n · u_y > cos(45°)
```

alongside height, contact, curvature, and region fields. Composition proposals
also retain a 2D visual anchor so an isolated archetype can be compared against
the same crop without making pixels the geometry authority.

The fast path is procedural PBR re-skinning over clean, untextured CC0 geometry:
apply the shared material graph, trim mapping, palette, and wear policy first;
trigger neural geometry only when the family still lacks a suitable silhouette,
surface detail, or focal insert.

## Family production loop

```text
regional family requirement
  -> exact accepted-family lookup
  -> hard catalog filters and bounded family shortlist
  -> contact-sheet assessment at one shared anchor
  -> accept an existing family or generate missing archetypes offline
  -> common adaptation and material realization
  -> family coherence and structural admission
  -> density/count/exclusion plan
  -> deterministic surface-aware population
```

Catalog hints are only grouping proposals. A production family is immutable and
validated. Extending or restyling one creates a semantic fork; existing scenes
continue to reference their previous revision.

The creative model chooses family roles, visual relationships, density intent,
hero slots, and variation. It does not inspect thousands of meshes, choose every
instance, or emit arbitrary transforms. The compiler derives counts by integrating
density over valid surfaces, subtracting routes and exclusions, then invoking
Poisson, cluster, along-path, or socket solvers.

## Neural role

TRELLIS, Hunyuan, Pixal3D, and future providers are peer offline factories. A
neural route may create a coordinated family concept, isolated references, a few
archetypes, or a hero exception. Accepted outputs pass the same adaptation,
material, bounds, support, socket, collision, and Roblox-budget gates as catalog
and procedural candidates. The family library makes subsequent instances cheap;
neural generation never blocks macro terrain, routes, blockout, or population.

## Current implementation boundary

Basalt has deterministic family hints, a bounded family resolver, shared-handle
population artifacts, typed relation solvers, and connector-sized chunk
emission. Validated family revisions and family-scoped visual evidence are the
next layer above those contracts. The first proof remains one catalog-backed
region with a bounded shortlist, accepted archetypes, deterministic population,
and local diagnostic passes.
