import { z } from "zod";
import {
  HASH_SCHEMA,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { routeCorridorIntersectsAabbXZ } from "./routes.js";
import {
  LOT_SUBDIVISION_POLICY_SCHEMA,
  WORLD_AABB_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  worldRegionVolumeBounds,
  type LotSubdivisionPolicy,
  type SpatialWorldPlan,
} from "./contracts.js";

const lotSchema = z
  .object({
    lotId: WORLD_ENTITY_ID_SCHEMA,
    policyId: WORLD_ENTITY_ID_SCHEMA,
    boundsMeters: WORLD_AABB_SCHEMA,
    areaSquareMeters: z.number().finite().positive(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, lotId: _lotId, ...identity } = value;
    if (contentHash(stableJson(identity)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Lot hash mismatch" });
    if (contentAddressedEntityId("Lot", identity) !== value.lotId)
      context.addIssue({ code: "custom", path: ["lotId"], message: "Lot ID mismatch" });
  });
export const LOT_SUBDIVISION_SCHEMA = z
  .object({
    kind: z.literal("LotSubdivision"),
    policy: LOT_SUBDIVISION_POLICY_SCHEMA,
    inputHash: HASH_SCHEMA,
    lots: z.array(lotSchema),
    status: z.enum(["eligible", "incomplete"]),
    diagnostics: z.array(z.string().min(1)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const material = { ...value };
    delete (material as Partial<typeof value>).hash;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Lot subdivision hash mismatch",
      });
  });
export type LotSubdivision = z.output<typeof LOT_SUBDIVISION_SCHEMA>;

export function subdivideWorldPlanToLots(plan: SpatialWorldPlan): readonly LotSubdivision[] {
  return plan.lotPolicies.map((policy) => subdivideRegion(plan, policy));
}

export function subdivideRegion(
  plan: SpatialWorldPlan,
  policy: LotSubdivisionPolicy,
): LotSubdivision {
  const region = plan.regions.find((entry) => entry.regionId === policy.regionId);
  if (!region) throw new Error(`Unknown lot region ${policy.regionId}`);
  const bounds = worldRegionVolumeBounds(region.volume);
  const size = Math.max(
    policy.minimumLotMeters,
    Math.min(policy.maximumLotMeters, policy.cellMeters),
  );
  const lots: z.output<typeof lotSchema>[] = [];
  outer: for (let x = bounds.min.x; x + size <= bounds.max.x + 1e-9; x += size)
    for (let zPosition = bounds.min.z; zPosition + size <= bounds.max.z + 1e-9; zPosition += size) {
      const lotBounds = {
        min: { x, y: bounds.min.y, z: zPosition },
        max: { x: x + size, y: bounds.max.y, z: zPosition + size },
      };
      if (
        plan.routes.some(
          (route) =>
            route.regionIds.includes(policy.regionId) &&
            routeCorridorIntersectsAabbXZ(
              route.alignmentMeters,
              lotBounds,
              route.widthMeters,
              policy.routeMarginMeters,
            ),
        )
      )
        continue;
      const identity = {
        policyId: policy.policyId,
        boundsMeters: lotBounds,
        areaSquareMeters: size * size,
      };
      lots.push({
        lotId: contentAddressedEntityId("Lot", identity),
        policyId: policy.policyId,
        boundsMeters: lotBounds,
        areaSquareMeters: size * size,
        hash: contentHash(stableJson(identity)),
      });
      if (lots.length >= policy.maximumLots) break outer;
    }
  const diagnostics = lots.length === 0 ? ["No eligible lots fit the region policy"] : [];
  const relevantRoutes = plan.routes.filter((route) => route.regionIds.includes(policy.regionId));
  const inputHash = contentHash(stableJson({ policy, region, routes: relevantRoutes }));
  const material = {
    kind: "LotSubdivision" as const,
    policy,
    inputHash,
    lots,
    status: lots.length > 0 ? ("eligible" as const) : ("incomplete" as const),
    diagnostics,
  };
  return deepFreezeJson(
    LOT_SUBDIVISION_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
