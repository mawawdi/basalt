import { contentHash } from "@basalt/contracts";
import type { PopulationDensityField } from "@basalt/catalog-model";

/** Smooth value noise modulates a relative density, never placement authority. */
export function populationDensityAt(
  field: PopulationDensityField,
  x: number,
  z: number,
  distanceToBoundary: number,
): number {
  if (![x, z, distanceToBoundary].every(Number.isFinite)) throw new Error("Invalid density sample");
  if (distanceToBoundary <= 0) return 0;
  const u = x / field.wavelengthMeters,
    v = z / field.wavelengthMeters;
  const ix = Math.floor(u),
    iz = Math.floor(v);
  const value = (dx: number, dz: number) =>
    Number.parseInt(contentHash(`${field.seed}:${ix + dx}:${iz + dz}`).slice(0, 8), 16) /
    0x1_0000_0000;
  const a = mix(value(0, 0), value(1, 0), smooth(u - ix));
  const b = mix(value(0, 1), value(1, 1), smooth(u - ix));
  const noise = mix(a, b, smooth(v - iz));
  return (
    smooth(distanceToBoundary / field.edgeFadeMeters) *
    (field.minimumDensity + (1 - field.minimumDensity) * noise ** field.patchContrast)
  );
}

function smooth(n: number): number {
  const t = Math.max(0, Math.min(1, n));
  return t * t * (3 - 2 * t);
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
