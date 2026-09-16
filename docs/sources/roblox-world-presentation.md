# Roblox world-presentation baseline

Checked 2026-09-16 against current Roblox Creator Hub documentation.

## Maintained platform baseline

Roblox already supplies the commodity rendering controls required for a coherent world look:

- [`Lighting`](https://create.roblox.com/docs/environment/lighting) exposes time of day,
  geographic sun angle, brightness, exposure, ambient light, environment contribution, global
  shadows, and shadow softness.
- [`Atmosphere`](https://create.roblox.com/docs/environment/atmosphere) supplies density,
  offset, haze, glare, sky color, and distance decay for depth and horizon treatment.
- [Post-processing effects](https://create.roblox.com/docs/environment/post-processing-effects)
  include color correction for brightness, contrast, saturation, and tint plus sun rays.

Basalt reuses those platform primitives directly. It does not implement a custom renderer,
invent a parallel atmospheric model, set security-restricted lighting modes, or rewrite catalog
mesh materials to create the world look.

## Basalt-owned remainder

The platform APIs do not provide Basalt's reproducibility and failure semantics. Basalt therefore
owns only the smaller integration layer:

1. an engine-neutral, content-addressed `WorldVisualEnvironment` in the spatial plan and
   `WorldBuild`;
2. canonical transport of that exact profile in the Roblox commit transaction;
3. reversible replacement of the relevant prior effect stack with three namespaced effects;
4. exact property readback before acknowledgement; and
5. restoration of prior Lighting state and effects if the world transaction rolls back.

This separates presentation intent from asset evidence. A color grade may improve world-level
coherence, but it cannot authorize, recolor, or conceal a defective catalog asset.
