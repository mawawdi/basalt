# Basalt research index

Research supports the implementation but does not define runtime contracts.
Current architecture and product decisions live in
[ARCHITECTURE.md](ARCHITECTURE.md), [BASALT.md](BASALT.md), and
[VISUALS.md](VISUALS.md).

## Current authorities

The deterministic asset-resolution specification is the single authority for
taxonomy handles, family identity, palette serialization, and the two-pass
planning boundary. The implementation lives in `packages/basalt-types` and
the authored-family path in `packages/catalog-intelligence`.

- [Deterministic asset resolution](research/deterministic-asset-resolution.md)
  — authoritative taxonomy, Merkle family identity, compact palette cards, and
  exploit/explore planning contracts.

- [Basalt technical evaluation](research/basalt-technical-evaluation.md)
  — fixed-point determinism, unit economics, mobile budgets, and the Lagoon of
  the Basalt Spire acid test.
- [Modular world compilation](research/modular-world-compilation.md) — terrain,
  socketed kits, shape grammars, and surface-aware assembly.
- [WorldClaw source](sources/world-claw.md) — global-to-regional planning,
  composition proposals, camera calibration, and localized repair.
- [Roblox terrain survey](sources/roblox-terrain.md) — voxel channels,
  Shorelines water, engine grass, material tinting, and custom terrain
  materials with a Basalt utilization proposal.

## Evidence policy

Research examples and provider comparisons are hypotheses until a pinned worker,
rights record, deterministic adaptation report, and creator-run Studio capture
exist. Placeholder citation markers are not evidence. Historical experiments
must not be presented as current product capability. The two-pass planning
background in [the journal note](journal/two-pass-planning-resolution-loop.txt)
is explanatory only; it cannot override the deterministic resolution contract.

## Decisions

Basalt keeps WorldClaw's coarse-to-fine planning and composition bridge while
retaining typed geometry and transaction authority. It uses procedures, catalog
assets, and neural factories as peer sources. It does not require a thematic
pack, per-instance model generation, arbitrary DCC code, or full-scene Blender
Cycles review.

B4 terrain lowering resolutions (grounded in the Roblox terrain survey and the
live `Terrain` class reference): water-only voxels lower as `Air` plus
`LiquidOccupancy` because the engine no longer accepts a `Water` solid
material, and read back `Air` on both spot paths; neutral wave ranges wider
than the engine clamp in the adapter (`WaterWaveSize` to 1 stud,
`WaterWaveSpeed` to 100/min) with a printed note, while schema-bounded values
fail closed; appearance applies once per export hash behind a folder attribute
gate and survives rollback as global terrain state, except engine grass,
which degrades with a warning on builds lacking the members and leaves the
gate unset for a future upgrade. Observed 2026-09-12: Studio 0.738.0.7381393
(latest) hides `Terrain.Decoration` and `Terrain.GrassLength` from the script
reflection while still showing the toggle in the Properties panel, so engine
grass is creator-flippable by hand but not connector-settable; the class
reference lists both as script properties. Cause unestablished; material-only
updates ship
as sealed per-surface repaint directives lowered through `ReplaceMaterial`
with a marker repaint gate so stale paint can never pass the skip check.
