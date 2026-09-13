import { z } from "zod";
import { contentAddressedEntityId, contentHash, stableJson } from "@basalt/contracts";
import { entityId, hashSchema } from "./primitives.js";

const finite = z.number().finite();
export const SPATIAL_VECTOR3_SCHEMA = z.object({ x: finite, y: finite, z: finite }).strict();
export const SPATIAL_AABB_SCHEMA = z
  .object({ min: SPATIAL_VECTOR3_SCHEMA, max: SPATIAL_VECTOR3_SCHEMA })
  .strict()
  .refine(
    ({ min, max }) => min.x <= max.x && min.y <= max.y && min.z <= max.z,
    "Spatial bounds are inverted",
  );

export const SPATIAL_OBB_SCHEMA = z
  .object({
    center: SPATIAL_VECTOR3_SCHEMA,
    halfSize: SPATIAL_VECTOR3_SCHEMA.refine(
      (value) => value.x > 0 && value.y > 0 && value.z > 0,
      "Oriented bounds must have positive half extents",
    ),
    rotation: z
      .tuple([finite, finite, finite, finite])
      .refine(
        (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
        "Oriented bounds rotation must be normalized",
      ),
  })
  .strict();
export type SpatialObb = z.output<typeof SPATIAL_OBB_SCHEMA>;

const occupancyReservationMaterial = z
  .object({
    sourceInstanceId: entityId,
    surfaceId: entityId,
    stratum: z.string().min(1).max(64),
    bounds: SPATIAL_AABB_SCHEMA,
    collisionEvidenceHash: hashSchema.optional(),
    narrowPhaseObbs: z.array(SPATIAL_OBB_SCHEMA).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.narrowPhaseObbs.length > 0 && value.collisionEvidenceHash === undefined)
      context.addIssue({
        code: "custom",
        path: ["collisionEvidenceHash"],
        message: "Narrow-phase bounds require measured collision evidence",
      });
  });

export const OCCUPANCY_RESERVATION_SCHEMA = occupancyReservationMaterial
  .extend({ id: entityId, hash: hashSchema })
  .strict()
  .superRefine((value, context) => {
    const { id: _id, hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Occupancy reservation hash mismatch",
      });
    if (contentAddressedEntityId("occupancy", material) !== value.id)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Occupancy reservation ID mismatch",
      });
  });
export type OccupancyReservation = z.output<typeof OCCUPANCY_RESERVATION_SCHEMA>;

export function sealOccupancyReservation(
  input: Omit<OccupancyReservation, "id" | "hash" | "narrowPhaseObbs"> & {
    readonly narrowPhaseObbs?: readonly SpatialObb[];
  },
): OccupancyReservation {
  const material = occupancyReservationMaterial.parse({
    ...input,
    narrowPhaseObbs: input.narrowPhaseObbs ?? [],
  });
  return OCCUPANCY_RESERVATION_SCHEMA.parse({
    ...material,
    id: contentAddressedEntityId("occupancy", material),
    hash: contentHash(stableJson(material)),
  });
}

export interface OccupancyConflict {
  readonly existingId: string;
  readonly candidateId: string;
  readonly penetration: { readonly x: number; readonly y: number; readonly z: number };
}

/** Shared 3D authority for population, structures, rooms, and attachments. */
export class OccupancyIndex {
  readonly #reservations: OccupancyReservation[] = [];

  public reservations(): readonly OccupancyReservation[] {
    return [...this.#reservations];
  }

  public checkpoint(): readonly OccupancyReservation[] {
    return this.reservations();
  }

  public restore(checkpoint: readonly OccupancyReservation[]): void {
    const parsed = checkpoint.map((reservation) => OCCUPANCY_RESERVATION_SCHEMA.parse(reservation));
    this.#reservations.splice(0, this.#reservations.length, ...parsed);
  }

  public conflicts(
    candidateInput: OccupancyReservation,
    maximumPenetration = 0,
    ignoredSourceInstanceIds: readonly string[] = [],
  ): readonly OccupancyConflict[] {
    const candidate = OCCUPANCY_RESERVATION_SCHEMA.parse(candidateInput);
    if (!Number.isFinite(maximumPenetration) || maximumPenetration < 0)
      throw new Error("Maximum occupancy penetration must be non-negative and finite");
    return this.#reservations.flatMap((existing) => {
      if (ignoredSourceInstanceIds.includes(existing.sourceInstanceId)) return [];
      const penetration = {
        x:
          Math.min(existing.bounds.max.x, candidate.bounds.max.x) -
          Math.max(existing.bounds.min.x, candidate.bounds.min.x),
        y:
          Math.min(existing.bounds.max.y, candidate.bounds.max.y) -
          Math.max(existing.bounds.min.y, candidate.bounds.min.y),
        z:
          Math.min(existing.bounds.max.z, candidate.bounds.max.z) -
          Math.max(existing.bounds.min.z, candidate.bounds.min.z),
      };
      const broadPhaseConflict =
        penetration.x > maximumPenetration &&
        penetration.y > maximumPenetration &&
        penetration.z > maximumPenetration;
      if (!broadPhaseConflict) return [];
      if (!narrowPhaseConflict(existing, candidate, maximumPenetration)) return [];
      return [{ existingId: existing.id, candidateId: candidate.id, penetration }];
    });
  }

  public reserve(
    candidate: OccupancyReservation,
    maximumPenetration = 0,
    ignoredSourceInstanceIds: readonly string[] = [],
  ): void {
    const conflicts = this.conflicts(candidate, maximumPenetration, ignoredSourceInstanceIds);
    if (conflicts.length > 0)
      throw new Error(
        `Occupancy conflict: ${candidate.id} overlaps ${conflicts.map((entry) => entry.existingId).join(", ")}`,
      );
    this.#reservations.push(OCCUPANCY_RESERVATION_SCHEMA.parse(candidate));
    this.#reservations.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  }

  /** Validate a group against existing and peer reservations before committing any of it. */
  public reserveBatch(
    candidatesInput: readonly OccupancyReservation[],
    maximumPenetration = 0,
  ): void {
    const candidates = candidatesInput.map((candidate) =>
      OCCUPANCY_RESERVATION_SCHEMA.parse(candidate),
    );
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
      throw new Error("Occupancy batch repeats reservation IDs");
    const probe = new OccupancyIndex();
    for (const existing of this.#reservations) probe.reserve(existing, maximumPenetration);
    for (const candidate of candidates) probe.reserve(candidate, maximumPenetration);
    this.#reservations.splice(0, this.#reservations.length, ...probe.#reservations);
  }
}

function narrowPhaseConflict(
  first: OccupancyReservation,
  second: OccupancyReservation,
  allowance: number,
): boolean {
  if (first.narrowPhaseObbs.length === 0 && second.narrowPhaseObbs.length === 0) return true;
  const firstBoxes =
    first.narrowPhaseObbs.length > 0 ? first.narrowPhaseObbs : [aabbAsObb(first.bounds)];
  const secondBoxes =
    second.narrowPhaseObbs.length > 0 ? second.narrowPhaseObbs : [aabbAsObb(second.bounds)];
  return firstBoxes.some((left) =>
    secondBoxes.some((right) => obbsIntersect(left, right, allowance)),
  );
}

function aabbAsObb(bounds: OccupancyReservation["bounds"]): SpatialObb {
  return {
    center: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
    halfSize: {
      x: (bounds.max.x - bounds.min.x) / 2,
      y: (bounds.max.y - bounds.min.y) / 2,
      z: (bounds.max.z - bounds.min.z) / 2,
    },
    rotation: [0, 0, 0, 1],
  };
}

/** Separating-axis test over the 15 axes of two measured oriented boxes. */
function obbsIntersect(first: SpatialObb, second: SpatialObb, allowance: number): boolean {
  const firstAxes = quaternionAxes(first.rotation);
  const secondAxes = quaternionAxes(second.rotation);
  const firstHalf = [first.halfSize.x, first.halfSize.y, first.halfSize.z] as const;
  const secondHalf = [second.halfSize.x, second.halfSize.y, second.halfSize.z] as const;
  const rotation = firstAxes.map((axis) => secondAxes.map((other) => vectorDot(axis, other)));
  const absolute = rotation.map((row) => row.map((value) => Math.abs(value) + 1e-12));
  const deltaWorld = {
    x: second.center.x - first.center.x,
    y: second.center.y - first.center.y,
    z: second.center.z - first.center.z,
  };
  const translation = firstAxes.map((axis) => vectorDot(deltaWorld, axis));
  for (let axis = 0; axis < 3; axis += 1) {
    const firstRadius = firstHalf[axis]!;
    const secondRadius =
      secondHalf[0] * absolute[axis]![0]! +
      secondHalf[1] * absolute[axis]![1]! +
      secondHalf[2] * absolute[axis]![2]!;
    if (Math.abs(translation[axis]!) + allowance >= firstRadius + secondRadius) return false;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const firstRadius =
      firstHalf[0] * absolute[0]![axis]! +
      firstHalf[1] * absolute[1]![axis]! +
      firstHalf[2] * absolute[2]![axis]!;
    const secondRadius = secondHalf[axis]!;
    const projected = Math.abs(
      translation[0]! * rotation[0]![axis]! +
        translation[1]! * rotation[1]![axis]! +
        translation[2]! * rotation[2]![axis]!,
    );
    if (projected + allowance >= firstRadius + secondRadius) return false;
  }
  for (let firstAxis = 0; firstAxis < 3; firstAxis += 1)
    for (let secondAxis = 0; secondAxis < 3; secondAxis += 1) {
      const nextFirst = (firstAxis + 1) % 3;
      const lastFirst = (firstAxis + 2) % 3;
      const nextSecond = (secondAxis + 1) % 3;
      const lastSecond = (secondAxis + 2) % 3;
      const firstRadius =
        firstHalf[nextFirst]! * absolute[lastFirst]![secondAxis]! +
        firstHalf[lastFirst]! * absolute[nextFirst]![secondAxis]!;
      const secondRadius =
        secondHalf[nextSecond]! * absolute[firstAxis]![lastSecond]! +
        secondHalf[lastSecond]! * absolute[firstAxis]![nextSecond]!;
      const projected = Math.abs(
        translation[lastFirst]! * rotation[nextFirst]![secondAxis]! -
          translation[nextFirst]! * rotation[lastFirst]![secondAxis]!,
      );
      if (projected + allowance >= firstRadius + secondRadius) return false;
    }
  return true;
}

function quaternionAxes(
  rotation: SpatialObb["rotation"],
): readonly [
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
] {
  const [x, y, zCoordinate, w] = rotation;
  return [
    {
      x: 1 - 2 * (y * y + zCoordinate * zCoordinate),
      y: 2 * (x * y + zCoordinate * w),
      z: 2 * (x * zCoordinate - y * w),
    },
    {
      x: 2 * (x * y - zCoordinate * w),
      y: 1 - 2 * (x * x + zCoordinate * zCoordinate),
      z: 2 * (y * zCoordinate + x * w),
    },
    {
      x: 2 * (x * zCoordinate + y * w),
      y: 2 * (y * zCoordinate - x * w),
      z: 1 - 2 * (x * x + y * y),
    },
  ];
}

function vectorDot(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
