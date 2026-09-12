# Roblox terrain capability survey

- Sources: [Terrain class](https://create.roblox.com/docs/en-us/reference/engine/classes/Terrain.md),
  [TerrainDetail](https://create.roblox.com/docs/en-us/reference/engine/classes/TerrainDetail.md),
  [MaterialVariant](https://create.roblox.com/docs/en-us/reference/engine/classes/MaterialVariant.md),
  [Materials](https://create.roblox.com/docs/en-us/parts/materials.md),
  RDC 2026 coverage (GamesBeat, Sep 11 2026), Shorelines release notes.
- Survey date: 2026-09-12. API verified against live Creator Docs (last updated 2026-09-11).

## Engine ground truth

- Voxels are 4x4x4 studs; every region API requires grid alignment,
  resolution exactly 4, and at most 4,194,304 voxels per call.
- Occupancy is f32-sealed but u8-quantized by the engine; readbacks must
  carry tolerance (Basalt already does: `VOXEL_SPOT_TOLERANCE`).
- Solid and liquid are separate channels since Shorelines (2024, live):
  `SolidMaterial` / `SolidOccupancy` / `LiquidOccupancy`. Water is no
  longer writable as a solid material in the channel API; a water voxel is
  `Air + LiquidOccupancy`. Shorelines animate freely, unconstrained by
  voxel vertices, and hug shores.
- `WriteVoxels` (legacy two-array) still works for solids; `WriteVoxelChannels`
  is the granular path and the only water path. `ReadVoxelChannels` mirrors it.
- `ReplaceMaterial(region, 4, source, target)` repaints material without
  touching occupancy. `CopyRegion`/`PasteRegion` snapshot and stamp
  `TerrainRegion`s (paste-empty-cells and outside-region flags).
- Water look is five global props: `WaterColor`, `WaterTransparency`,
  `WaterReflectance`, `WaterWaveSize`, `WaterWaveSpeed`. Script-writable,
  serialized, one setting per place.
- Grass is engine-native: `Decoration` bool + `GrassLength` 0.1-1 on the
  Grass material. Animated, zero instances, global toggle.
- Per-material tint: `SetMaterialColor` / `GetMaterialColor` (script API
  over serialized `MaterialColors`). Applies to built-in materials.
- Custom terrain materials: `MaterialVariant` under `MaterialService` with
  `BaseMaterial` set to a terrain-capable material, plus up to 3
  `TerrainDetail` children (Top/Side/Bottom faces). Full PBR maps
  (Color/Normal/Roughness/Metalness/Emissive), `StudsPerTile` scale,
  `MaterialPattern` tiling. All texture/base-material writes are
  PluginSecurity, which the Basalt connector (a plugin) satisfies.
  UGC terrain variants respect color tinting. RDC 2026 (Sep 10-12 2026)
  put custom terrain materials in early access "with variation".
- No runtime heightmap import (`ImportHeightMap` is Studio-only) and no
  EditableMesh-style terrain sculpting; exact voxels remain the precise path.

## Utilization proposal for Basalt

Ordered by value per risk. Nothing here moves geometry authority; all
writes stay inside fixed-connector source interpreting canonical plans.

1. Liquid channel in the voxel payload (B-phase, coastal bay). Extend the
   voxel record with liquid occupancy per cell and lower via
   `WriteVoxelChannels` (`Air + LiquidOccupancy` for water cells). This is
   the only correct water path; legacy Water-as-material writes fight the
   Shorelines architecture. Read back `LiquidOccupancy` in voxel spots.
2. Water look as sealed export data. Add the five water props to the scene
   export (from the world plan's water table spec); the connector applies
   them once per place. Deterministic, creator-overridable, no per-instance
   cost.
3. Engine grass for groundcover mass (B-phase). Paint Grass material where
   the plan wants lawn/meadow and enable `Decoration` with a sealed
   `GrassLength`. Replaces hundreds of tuft instances with zero-geometry
   animated grass; keep catalog tufts only as hero clumps. Note the
   coarseness: global toggle, Grass material only.
4. `SetMaterialColor` palette pass. Drive built-in material tints (sand,
   grass, rock) from the sealed style contract for art direction without
   texture uploads. Cheap, serialized, reversible.
5. `ReplaceMaterial` for biome repaint. When a region's material assignment
   changes but relief doesn't, repaint instead of rewriting voxels:
   smaller transactions, idempotent, marker-compatible.
6. Custom terrain materials via connector-instantiated variants (needs the
   early-access track). Bake trim-sheet/atlas PBR textures, upload once,
   and have the fixed connector create `MaterialVariant` + `TerrainDetail`
   (Top/Side/Bottom, `StudsPerTile` matched to trim texel density) from
   canonical export entries. This is the long-term answer to "flat
   featureless terrain": Basalt sand/rock/grass with authored PBR.
7. `CopyRegion`/`PasteRegion` for repeated landforms (later). Stamp
   canonical terrain regions (dunes, cliffs) across partitions instead of
   rewriting identical voxels. Deterministic under fixed source; verify
   byte-equality of stamped regions in readbacks before adopting.

## Non-goals

- Roblox Reality photorealistic overlay (RDC 2026): presentation layer,
  outside Basalt's typed-geometry authority.
- FillBall/FillBlock/FillCylinder/FillWedge brushes: less precise than
  sealed voxels; no role while exact payloads exist.
- ImportHeightMap pipelines: 8-bit lossy, Studio-only; exact voxels dominate.
