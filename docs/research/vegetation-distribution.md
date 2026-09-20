# Vegetation Distribution Assessment

Research inspected on 2026-09-19. This document is non-authoritative rationale and a
comparison of candidate approaches. Implemented behavior belongs to `ARCHITECTURE.md`
and `VISUALS.md`; execution status and completion gates belong only to `TASKS.md`.

Basalt's vegetation problem is broader than random point placement. The compiler
can place objects deterministically, respect routes, and reject occupied space, but that
does not establish a convincing forest. The strongest practical baseline is a layered,
art-directed vegetation distribution: shared landscape fields, canopy placement,
undergrowth conditioned on that canopy, and ground cover. Variable-radius blue noise is
a useful sampling component within that design. It is not a complete composition model.

## Initial audit before the layered pilot

- The pre-layering `packages/world-compiler/src/compiler.ts` path sampled hash-seeded candidates independently
  for each `surface_scatter` polygon or `cluster` disk. It processes intents by priority,
  rejects region, route and occupancy conflicts, and replenishes candidates toward an
  authored target count. Its `cluster` is a disk-shaped sampling domain, not an ecological
  parent-and-offspring process. That was rejection sampling, not Bridson's
  active-list Poisson-disk algorithm.
- `population-density.ts` now supplies smooth value noise and boundary attenuation.
  Several layers can share a field, but each still fills a separate count target and
  does not condition its distribution on the actual accepted neighboring plants.
  A crowded high-target patch can exhaust its preferred sites and accumulate plants in
  its lower-density areas. Relative probability is not an absolute coverage contract.
- `reservationFor` uses measured collision boxes when present. Without them, the
  spatial occupancy index conservatively uses the full transformed visual bounds.
  It cannot distinguish empty space below a tree crown from the trunk.
- `OccupancyIndex.conflicts` scans existing reservations. The bounded regional pilot
  does not establish that this implementation supports millions of plants efficiently.

The retained catalog evidence confirms the occupancy limitation on actual assets:

| Admitted handle       | Visual width × depth, approximately | Separate collision boxes |
| --------------------- | ----------------------------------- | ------------------------ |
| `rural_old_broadleaf` | 9.30 × 5.42 m                       | None                     |
| `rural_silver_birch`  | 4.03 × 3.38 m                       | None                     |
| `rural_meadow_pine`   | 2.82 × 2.83 m                       | None                     |
| `rural_leafy_shrub`   | 0.53 × 0.61 m                       | None                     |

These values come from the retained `CatalogMeasurementSet` with hash
`ba51d4e7a66cfd360b43cdc2dad2fb7fac9a18594d5f9f4b976a8f33d75d2e25`.
They establish a conservative-box limitation, not permission to ignore collisions.
The contribution of this limitation to overall visual quality is not yet isolated by
an ablation.

The three fresh composition cases all produced eligible compilations and previews in
94–118 seconds. None passed every visual criterion. Retained images show perimeter
bands, a central woodland island, crowding around camp furniture, and poorly resolved
building approaches. These are same-agent development judgments. They do not demonstrate
that density fields are ineffective in general; they demonstrate that this formulation
and these authored layouts are insufficient. See `EVALS.md` for exact scope and timing.

## Closest proven approaches

| Approach                            | Useful mechanism                                                                            | Fit for Basalt                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Houdini Labs Biome Plant Scatter    | Environmental suitability, exclusion masks, competition, age and variant controls           | Closest production-tool design reference                                  |
| Unreal PCG Biome                    | Blended spatial regions, exclusion volumes, layered generators and bounded child generation | Strong reference for composition and partitioned realization              |
| Adaptive and multi-class blue noise | Position-dependent spacing and coordinated sample classes                                   | Reusable candidate generation; insufficient for forest structure alone    |
| EcoLearn / EcoBrush                 | Canopy and undergrowth relationships; distributions learned from data or simulation         | Strong research baseline for the layered representation                   |
| EcoSysLab                           | Seeding, growth and competition in an explicit ecosystem simulator                          | Useful comparison if cheaper layered rules prove insufficient             |
| Infinigen                           | Procedural nature scenes, reusable assets and staged population                             | Useful scene and asset reference; not a direct engine-neutral replacement |

**Houdini Labs.** Plant Scatter computes suitability from environmental fields, uses it
to control density, and prunes competing plants. Its exclusion input preserves authored
empty areas. This directly addresses independent patches with no shared environmental
structure. [Plant Scatter documentation](https://www.sidefx.com/docs/houdini/nodes/sop/labs--biome_plant_scatter-1.3.html).

Its plant definitions distinguish crown bounds from trunk radius: shrubs can occupy
space below trees while staying outside trunks. Mesh variants can represent different
growth stages. That distinction is especially relevant to Basalt's conservative tree
boxes. Ecological spacing and physical collision are different quantities.
[Plant Define documentation](https://www.sidefx.com/docs/houdini/nodes/sop/labs--biome_plant_define-1.1.html).

The [SideFX Labs repository](https://github.com/sideeffects/SideFXLabs) exposes the tool
assets and scripts; the inspected Development commit was
`da8d969ad7e982568550022b6f3c6a90e0d255a0`. These are Houdini tools, not a standalone
TypeScript scatter library. Reuse the documented pattern without making Houdini a
required world-compilation runtime.

**Unreal.** PCG Biome offers blended biome regions, exclusion volumes and splines,
layered generators, and recursive parent/child spawning with depth limits. Epic labels
the Biome plugin experimental. It is a useful design reference, not evidence that
Basalt can adopt an engine-independent library from it.
[PCG Biome overview](https://dev.epicgames.com/documentation/unreal-engine/procedural-content-generation-pcg-biome-core-and-sample-plugins-overview-guide-in-unreal-engine).
The separate Procedural Foliage tool demonstrates age, seed spread, shade competition
and explicit blocking volumes. These provide a stronger grouping model than unrelated
uniform scatters. [Procedural Foliage](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-foliage-tool-in-unreal-engine).

**Blue noise.** Adaptive Poisson-disk sampling varies spacing across a field. Multi-class
blue noise coordinates several point classes instead of overlaying independent
distributions. The foundational algorithms are older but remain relevant components;
neither guarantees believable ecological clustering or gameplay space.
[Wei, SIGGRAPH 2010](https://www.liyiwei.org/papers/noise-sig10/).
The author's [reference code](https://github.com/1iyiwei/noise) carries an MIT license.

The small MIT-licensed JavaScript [poisson-disk-sampling library](https://github.com/kchapelier/poisson-disk-sampling)
supports a supplied RNG, variable distance fields and bounded trials. Its inspected
commit was `9536e50c682c8e1d5a5add44a729b7414a276c61` (2022-06-05), so it is a compact
reference candidate, not a claim of recent active maintenance. It provides single-class
sampling. It does not supply polygon exclusions, species interaction, chunk consistency
or Basalt's measured geometry checks. Its `addPoint` operation explicitly skips spacing
validation; mandatory anchors require separate validation.

**EcoLearn and EcoBrush.** EcoLearn generates a canopy representation, fits trees to it,
then synthesizes undergrowth conditioned on that canopy and adds forest-floor cover.
That separation is more relevant to Basalt than adopting its trained network outright.
[Kapp et al., 2020](https://perso.liris.cnrs.fr/apeytavi/website/publication/hal-03007259/).
The [released code](https://github.com/jgain/EcoLearn) is GPL-3.0 and the inspected
default-branch commit is from January 2021; it is research software, not a maintained
drop-in service. EcoBrush uses precomputed simulation distributions for interactive
authoring rather than rerunning the full simulation for every edit.
[Gain et al., 2017](https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.13107).

**EcoSysLab and Infinigen.** EcoSysLab's current implementation explicitly models plant
growth, neighboring competition and reproduction. Its simulator also uses a spatial
grid for neighbor lookup. The inspected EvoEngine commit was
`dfbc768ba1304d62eda7369a4a19dbfe81e6e8ec` (2026-09-15).
[Distribution implementation](https://github.com/edisonlee0212/EvoEngine/blob/dfbc768ba1304d62eda7369a4a19dbfe81e6e8ec/EvoEngine_Packages/EcoSysLab/src/SpatialPlantDistribution.cpp).
Its C++ engine and simulation parameters are a substantially larger integration than
a bounded candidate sampler. Infinigen remains an actively developed BSD-licensed,
Blender-based nature-scene generator aimed at computer-vision data. That runtime and
objective differ from Basalt's editable, engine-verified maps.
[Infinigen project](https://infinigen.org/).

## Recommended formulation

This formulation was inferred from the sources and local failures. The bounded implementation
described below covers only part of it; the recommendation is not evidence of visual quality.

1. **One landscape composition before individual plants.** Use continuous world-space
   fields for wooded cover, open ground and transitions. Terrain slope and altitude are
   measurable inputs. Moisture or shade preferences are authored scene policy unless
   backed by a suitable solver; a filename or caption cannot certify them. Noise varies
   an intentional landscape rather than supplying the entire design.
2. **Reserve useful empty space.** Paths, door approaches, seating, gathering areas and
   requested view corridors constrain vegetation. Ground-level exclusion and overhead
   clearance are distinct: a canopy above a bench can be desirable even when a shrub
   in front of it is not. These constraints are stronger than object nonintersection.
3. **Place canopy jointly.** Sample tree locations with variable spacing, a coherent
   local palette and soft species/size preferences. Physical trunk clearance remains
   hard; canopy competition is an authored distribution preference. Mature anchors,
   sparse outliers and gaps break the uniform-spacing appearance of blue noise alone.
4. **Condition smaller plants on accepted larger plants.** Undergrowth can respond to
   actual canopy cover, edges and rock neighborhoods according to the authored plant
   community. Ground-cover colonies operate at a smaller scale. Giving every layer the
   same noise seed creates correlation, but not these directed relationships.
5. **Measure occupied geometry more precisely.** Height-banded geometry envelopes or
   validated trunk/crown proxies can replace unnecessarily solid visual boxes where
   evidence supports them. Low branches and rooted trunks still occupy space. A model's
   claim that an asset is a tree never authorizes reducing its collision bounds.
6. **Treat natural density as density.** Coverage and instances per area determine the
   intended population, with explicit resource allocations and resumable evaluation.
   Exact counts still suit orchard rows and specific landmarks. Repeatedly filling a
   forest quota must not erase its clearings or defeat its density field.

The planner's useful output is a small landscape specification: for example, a birch
stand above the path, an open picnic clearing, sparse saplings at its boundary, and
shade-preferring ground cover beneath the accepted canopy. Deterministic realization
then places the individual assets. This reduces the need for an agent to hand-author
dozens of independent patches.

For large worlds, global coordinate seeds are necessary but insufficient. Neighbor
queries need spatial acceleration; bounded interactions need tile halos and unique
ownership. A sampler can otherwise produce different border results when the same area
is compiled as one region or several chunks. A whole ecosystem growth simulation has
additional propagation dependencies; a small halo does not automatically solve them.

## What would discriminate the candidates

The useful comparison holds terrain, catalog, routes, cameras and budgets fixed. It
compares the current density-filtered rejection sampler, adaptive blue noise alone,
and the layered formulation, using multiple predeclared seeds. Equal-count views help
isolate spacing, while density-budget views expose differences in coverage; these are
different comparisons and should be reported separately.

Required evidence includes clear activity areas, valid contact and slopes, species
and size variation, under-canopy occupancy where geometry permits, believable edge
transitions, deterministic replay, chunk-border consistency, and execution time.
Pair-correlation and coverage statistics diagnose distributions, but cannot replace
ground-level and overview visual judgments. A clustered forest should not be optimized
to a universal uniform blue-noise score.

The retained farm, camp and ridge failures supply development cases. Independent review
and separate unseen layouts are necessary before claiming generalized improvement.
The research recommendation and its qualification gate are tracked by `REGION-AUTHORING`
in `TASKS.md`; no ecosystem library has been installed or promoted by this assessment.

## Implemented regional baseline

The implementation reuses the layered scatter, exclusion-volume and geometric-envelope patterns
described above. It uses adaptive dart throwing with a spatial neighbor grid, not the external
Poisson library or a reimplementation of the Houdini ecosystem stack. Equal-priority species
compete in one deterministic candidate order within each layer. Undergrowth responds to accepted
canopy; rejected sites are not replenished merely to fill a quota.

Candidate generation is incremental. It writes bounded sorted runs to a content-addressed
checkpoint and performs a canonical multiway merge while retaining shared spacing and occupancy
state. Batch size and merge fan-in are execution policy and cannot alter the completed ordering.
If the current allocation ends before all logical candidates are produced, the world is
`incomplete`, emits no partial population, and the next execution resumes at the exact candidate
offset. This follows the established external-sort run/merge pattern documented by
[GNU Coreutils `sort`](https://www.gnu.org/software/coreutils/manual/html_node/The-sort-command.html)
and [STXXL's external sorting design](https://stxxl.org/tags/1.4.1/design_algo_sorting.html).
Those systems establish run formation followed by a deterministic multiway merge, with memory
and merge fan-in treated as execution resources. Basalt adds one shared placement-admission pass
over the merged canonical stream because biological spacing, route clearance and occupancy span
runs. It also owns content identity, resumable offsets and the no-partial-promotion rule.

Static GLB triangles are clipped into height bands to measure packing geometry. These
envelopes preserve low branches and trunks and remain distinct from catalog admission and
engine collision. They are retained through refinement verification. The regional implementation
has no semantic area, species, or instance cap. Tile halos, chunk-partition invariance, biological
succession, explicit sunlight, million-instance capacity and large-world performance remain outside
the demonstrated behavior.

The same-scene comparison and its limits are recorded in `EVALS.md`. The development setup
keeps terrain, routes, fixed props, palette, seeds, cameras and per-species caps constant.
It compares the existing scatterer with adaptive placement and canopy-conditioned placement.
Counts differ, so this is a density-budget comparison, not an equal-count spacing ablation.
The current-to-adaptive comparison also changes packing and exclusions; only adaptive-to-layered
isolates canopy preference. This prevents attributing every difference to one algorithm.
