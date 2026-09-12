# Basalt visual world compiler

Basalt's visual product is a coherent world, not a contact sheet of unrelated
generated meshes. The compiler directs art hierarchically and resolves repeated
content at the family level.

## Art direction hierarchy

The global style contract defines shape language, silhouette hierarchy, edge
profiles, material response, palette, texel-density range, wear policy, lighting
intent, and anti-goals. It uses ranges and policies rather than universal
centimeter values.

Each region adds a bounded overlay for palette shifts, atmosphere, terrain
materials, density gradients, negative space, motifs, detail bands, and effects.
An asset-family revision binds a declared taxonomy handle to validated
archetypes and measured evidence. A family may be a foliage population, rock
group, clutter set, architectural kit, or hero variant set. Socketed structural
families use `ModularKitRequirement`; ordinary families do not need sockets.

Family members share a visual grammar and material realization policy. They do
not have to share one texture atlas when that would damage quality. The policy
may select tiling PBR, trim sheets, per-family atlases, or bounded unique detail.
Roblox batching and memory assumptions remain hypotheses until Studio evidence.

The asset finisher writes a linear contact-blend vertex-color attribute over the
bottom 0.5 meters of each admitted archetype. This provides moss, dirt, and
ground blending while leaving the authored mesh and runtime transform intact.

## From brief to world

```text
brief and references
  -> global style and world plan
  -> regional family and density plan
  -> exact sealed-family lookup
  -> hard catalog and admission filters
  -> accepted family cohort
  -> offline neural/procedural family factory on miss
  -> common adaptation, material realization, and admission
  -> deterministic surface-aware population
  -> partitioned Roblox world
```

The creative model chooses family roles, visual relationships, landmarks, and
regional density intent. It never chooses thousands of raw meshes or final
coordinates. The compiler derives counts from density fields, valid surfaces,
routes, exclusion masks, support footprints, and memory/triangle budgets.

## Catalog and neural routes

Catalog intelligence measures source assets offline and validates explicit
cohorts. Retrieval filters by exact taxonomy handle/family ID, rights, bounds,
surface kind, capability, and delivery budget. A bounded contact sheet may be
used for creator review; it does not invent family membership.

TRELLIS, Hunyuan, Pixal3D, Qwen, and other qualified routes are peer factories.
They generate coordinated family cohorts or hero exceptions offline. They do not run inline
for every instance and never block terrain, routes, blockout, or population.
Every accepted result becomes a content-addressed library entry and is reusable
without another model call.

Concept sheets are advisory style anchors. SAM segmentation and crop calibration
can produce candidate references, but each lifted archetype still passes geometry,
material, bounds, support, socket, and Roblox-budget checks.

## Spatial realization

Terrain and constructed surfaces share `PlacementSurfaceIndex`. Placement starts
with proposals and resolves through deterministic relations: `on_surface`,
`support`, `attach_socket`, `inside_region`, `maintain_clearance`, `visible_from`,
and route constraints. Full quaternions or orthonormal frames preserve slope and
surface orientation. No fixed-height or arbitrary coordinate path is final
authority.

Population uses Poisson, cluster, along-path, surface-grid, and socket assembly
distributions. Shared mesh/material handles and chunked transform artifacts keep
large worlds instanced. A failed requirement remains incomplete; Basalt never
inserts a visible generic proxy to hide a missing family.

## Evidence and repair

Early evidence is cheap and partitioned:

1. region, height, slope, material, navigability, and route-grade maps;
2. macro surface and route blockout;
3. family cards and priority-region population previews;
4. local beauty, albedo, depth, normal, object-ID, material-ID, contact, and
   clearance passes;
5. final gameplay-camera and Studio captures.

Blender is only an isolated asset-finishing worker. It handles source transform
baking, normal/tangent repair, UV generation or re-atlasing, PBR baking, support
and collision proxies, explicit socket welding, and bounded asset previews. It
does not render or gate an entire world.

Deterministic diagnostics repair pose, scale, orientation, support, sockets,
clearance, density, and budgets. A visual critic can rank family candidates and
report typed issues tied to exact views and object IDs; it cannot author geometry
or certify Studio behavior. Repairs remain scoped to affected families, chunks,
and regions while unrelated hashes stay unchanged.
