# Roblox Asset Lowering Strategy

The generic catalog stores engine-neutral GLB source identity, metric evidence,
materials, collision evidence, interfaces, and provenance. It never stores a
Roblox asset ID. `WorldBuild` likewise contains exact catalog identities and
meter-space transforms only.

`packages/roblox` owns the complete lowering boundary: meters-to-studs conversion,
terrain resampling to Roblox’s four-stud (1.12-meter) voxel grid, asset and
material mappings, transactional import, cancellation, rollback, and
authoritative readback.

An asset mapping is valid only when it binds the exact catalog asset hash and
material evidence used by the world build. Missing mappings make import
`incomplete`; the adapter must not replace them with primitives or guessed
materials. Readback verifies expected assets, materials, terrain channels,
components, portals, and world-build identity before returning the expected
observed-world-state hash.

Generic finishing remains in `asset-production`. Roblox-specific baking,
material budgets, upload policy, and importer constraints belong only in
`packages/roblox`. A future second adapter should consume the same `WorldBuild`;
until then Basalt intentionally has no speculative generic adapter interface.

Neural workers sit before generic finishing. Their safetensors handoff records the
actual provider coordinate frame, orientation transform, PBR vertex attributes,
and whether scale is merely provider-normalized or supported by metric evidence.
TRELLIS.2 currently emits an unbaked right-handed, Z-up normalized frame. The
finishing and measurement spine—not the neural worker—establishes the canonical
meter scale and GLB identity used by the catalog.

Primary platform references:

- [Roblox mesh specifications](https://create.roblox.com/docs/art/modeling/specifications)
- [Roblox Terrain](https://create.roblox.com/docs/reference/engine/classes/Terrain)
- [Roblox AssetService](https://create.roblox.com/docs/reference/engine/classes/AssetService)
- [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
