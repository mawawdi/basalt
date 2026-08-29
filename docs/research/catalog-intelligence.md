# Catalog intelligence and family resolution

**Status:** current design rationale. Catalog files are optional local inputs;
this repository intentionally contains no checked-in `.basalt` catalog state.

The scale problem is solved by changing the unit of selection. A creator brief
produces a bounded set of **family requirements** (for example, a family of
rocks or a structural kit), not a request to inspect every mesh for every
instance. An offline catalog pass may measure thousands of source files once.
The world compiler then performs one indexed lookup per family requirement and
reuses accepted archetypes for all instances.

## Two-stage index

Catalog ingestion records source and rights hashes, normalized open-vocabulary
tags, measured bounds, triangle/material counts, UV and texture facts, support
and contact evidence, capabilities, and preview handles. A record without a
complete measurement is pending and cannot satisfy a production requirement.

Runtime resolution has two deterministic stages:

1. Hard-filter postings by rights, dimensions, surfaces, capabilities, and
   delivery budgets.
2. Rank the survivors by semantic tags, family compatibility, silhouette,
   material language, texel density, and context. Render only a bounded
   shortlist at a shared anchor before adapting the winners.

Measured spatial keys are encoded as signed Q32.32 values. This keeps posting
filters and family bounds stable across IEEE-754 runtimes; floating values are
rounded once at ingestion and never used as hash keys. Structural entries also
retain a canonical socket registry. RANSAC planar clipping removes outlier
triangles from a mating boundary before the socket is admitted.

The first implementation uses sorted postings and a flat ranking pass. An ANN
index can be added behind the same interface only after a measured catalog-size
benchmark requires it; no unproven asymptotic claim is part of the contract.

## Family resolution

`AssetFamilyRegistry` is the production layer above catalog hints. A family
revision contains several compatible archetypes, a style and material policy,
metric envelopes, surface and support rules, repetition policy, and optional
socket grammar. Hints may suggest groups but never grant admission.

`resolveWorldAssetFamilies` builds one inverted tag index, forms a bounded
coherent set for each regional request, and fails closed when its minimum cannot
be met. `compileResolvedFamilyPopulationPlans` merges repeated family use before
any instance transforms are generated. The population compiler integrates the
family density field over valid surfaces, subtracts routes and exclusions, and
then invokes deterministic Poisson, cluster, path, grid, or socket placement.

This makes the cost of a build approximately:

```text
offline catalog measurement        O(N)
family lookup and ranking           O(R * F + filtered_candidates)
shortlist assessment                O(k) per family request
unique adaptation and admission    O(U)
bulk placement and validation       O(I) with bounded spatial indexes
```

`N` is catalog size, `R` regions, `F` family requests, `k` shortlist size, `U`
accepted archetypes, and `I` instances. The model never sees `N` raw meshes or
emits `I` transforms.

## Neural and procedural sources

Procedural families, catalog retrieval, and neural family factories are peer
candidate sources. Neural workers run offline to fill missing archetypes or
produce a hero variant; they do not run once per instance and never block macro
terrain, routes, or population. An accepted neural result is simply another
content-addressed family member with the same adaptation and admission checks.

Structural families share quad-strip hotspot trim sheets. A family normally
uses a shared 2K PBR set; each island-to-band assignment records its mismatch
energy, texel density, and overlap evidence. The trim mapper and socket registry
are part of the prepared-family artifact rather than metadata-only hints.

## Coherence checks

Hard gates cover rights, finite geometry, physical bounds, axes, support/contact,
collision, topology, PBR channels, texture budgets, and declared capabilities.
Soft evidence covers silhouette, palette, roughness/metallic response, texel
scale, detail bands, repetition entropy, density gradients, negative space,
landmark framing, and route readability. A candidate that fails a hard gate is
rejected; a family with no threshold-passing candidate remains incomplete.

The next useful evidence is a catalog-backed region: one family card, a bounded
shortlist, accepted archetypes, deterministic population, and local diagnostic
passes. It is more informative than another provider-only benchmark.
