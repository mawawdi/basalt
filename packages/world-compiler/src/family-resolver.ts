import { contentHash, stableJson } from "../../contracts/src/index.js";
import { worldEntityId, worldHash, compareWorldStrings } from "./primitives.js";
import {
  WORLD_FAMILY_POPULATION_PLAN_SCHEMA,
  type WorldFamilyPopulationPlan,
} from "./contracts.js";
import { z } from "zod";

/** Open-vocabulary family metadata. Geometry and style remain outside the resolver's authority. */
const familyCandidateSchema = z
  .object({
    familyId: worldEntityId,
    semanticTags: z.array(z.string().trim().min(1).max(80)).max(64),
    styleTags: z.array(z.string().trim().min(1).max(80)).max(64),
    roleTags: z.array(z.string().trim().min(1).max(80)).max(64),
    variantCount: z.number().int().positive().max(4096),
  })
  .strict();
export type WorldAssetFamilyCandidate = z.infer<typeof familyCandidateSchema>;

const requestSchema = z
  .object({
    biomeId: worldEntityId,
    semanticTags: z.array(z.string().trim().min(1).max(80)).max(64),
    styleTags: z.array(z.string().trim().min(1).max(64)).max(64),
    roleTags: z.array(z.string().trim().min(1).max(80)).max(64),
    minimumFamilies: z.number().int().min(1).max(5),
    maximumFamilies: z.number().int().min(1).max(5),
    regionIds: z.array(worldEntityId).min(1).max(256).optional(),
    surfaceKinds: z
      .array(z.enum(["terrain", "floor", "ramp", "roof", "platform", "wall", "ceiling"]))
      .min(1)
      .max(7)
      .optional(),
    distribution: z
      .enum(["poisson_scatter", "cluster", "along_path", "surface_grid", "socket"])
      .optional(),
    minimumCount: z.number().int().nonnegative().safe().optional(),
    maximumCount: z.number().int().positive().safe().optional(),
    density: z
      .object({
        minimum: z.number().finite().min(0).max(1),
        target: z.number().finite().min(0).max(1),
        maximum: z.number().finite().min(0).max(1),
      })
      .strict()
      .optional(),
    variationSeed: z.number().int().min(0).max(0xffff_ffff).optional(),
    excludedRouteIds: z.array(worldEntityId).max(256).optional(),
    excludedRegionIds: z.array(worldEntityId).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumFamilies > value.maximumFamilies)
      context.addIssue({
        code: "custom",
        path: ["minimumFamilies"],
        message: "Family range is inverted",
      });
    for (const [field, values] of [
      ["semanticTags", value.semanticTags],
      ["styleTags", value.styleTags],
      ["roleTags", value.roleTags],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", path: [field], message: "Family tags must be unique" });
  });
export type WorldBiomeFamilyRequest = z.infer<typeof requestSchema>;

const registrySchema = z
  .object({
    kind: z.literal("BasaltAssetFamilyRegistry"),
    abi: z.literal("basalt-asset-family-registry@1"),
    families: z.array(familyCandidateSchema).max(65_536),
    hash: worldHash,
  })
  .strict();
export type WorldAssetFamilyRegistry = z.infer<typeof registrySchema>;

export function sealWorldAssetFamilyRegistry(
  families: readonly WorldAssetFamilyCandidate[],
): WorldAssetFamilyRegistry {
  const canonical = families
    .map((family) =>
      familyCandidateSchema.parse({
        ...family,
        semanticTags: canonicalTags(family.semanticTags),
        styleTags: canonicalTags(family.styleTags),
        roleTags: canonicalTags(family.roleTags),
      }),
    )
    .sort((left, right) => compareWorldStrings(left.familyId, right.familyId));
  if (new Set(canonical.map((family) => family.familyId)).size !== canonical.length)
    throw new Error("Basalt asset family IDs must be unique");
  const material = {
    kind: "BasaltAssetFamilyRegistry" as const,
    abi: "basalt-asset-family-registry@1" as const,
    families: canonical,
  };
  return registrySchema.parse({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertWorldAssetFamilyRegistry(
  value: unknown,
): asserts value is WorldAssetFamilyRegistry {
  const registry = registrySchema.parse(value);
  const { hash, ...material } = registry;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Asset family registry hash mismatch");
  if (
    registry.families.some(
      (family, index) => index > 0 && registry.families[index - 1]!.familyId >= family.familyId,
    )
  )
    throw new Error("Asset family registry is not canonical");
}

/**
 * Resolve a small coherent family set with an inverted tag index. Candidate
 * scoring is linear in the postings touched by the request, rather than a
 * request-by-request scan of every catalog asset.
 */
export function resolveWorldAssetFamilies(input: {
  registry: WorldAssetFamilyRegistry;
  requests: readonly WorldBiomeFamilyRequest[];
}): Readonly<Record<string, readonly string[]>> {
  assertWorldAssetFamilyRegistry(input.registry);
  const requests = input.requests.map((request) => requestSchema.parse(request));
  const byToken = new Map<string, Set<string>>();
  for (const family of input.registry.families) {
    const tokens = new Set(
      [...family.semanticTags, ...family.styleTags, ...family.roleTags].map(normalize),
    );
    for (const token of tokens) {
      const posting = byToken.get(token) ?? new Set<string>();
      posting.add(family.familyId);
      byToken.set(token, posting);
    }
  }
  const familyById = new Map(input.registry.families.map((family) => [family.familyId, family]));
  const resolved: Record<string, readonly string[]> = {};
  for (const request of [...requests].sort((left, right) =>
    compareWorldStrings(left.biomeId, right.biomeId),
  )) {
    const semantic = new Set(request.semanticTags.map(normalize));
    const style = new Set(request.styleTags.map(normalize));
    const role = new Set(request.roleTags.map(normalize));
    const requested = [...semantic, ...style, ...role];
    const scores = new Map<string, number>();
    for (const token of requested)
      for (const familyId of byToken.get(token) ?? [])
        scores.set(
          familyId,
          (scores.get(familyId) ?? 0) +
            (semantic.has(token) ? 4 : style.has(token) ? 2 : role.has(token) ? 1 : 0),
        );
    const ranked = [...scores.entries()]
      .map(([familyId, score]) => ({ familyId, score, family: familyById.get(familyId)! }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.family.variantCount - left.family.variantCount ||
          compareWorldStrings(left.familyId, right.familyId),
      );
    const selected = ranked.slice(0, request.maximumFamilies).map((entry) => entry.familyId);
    if (selected.length < request.minimumFamilies)
      throw new Error(
        `No coherent family set satisfies biome ${request.biomeId}; refusing unrelated fallback families`,
      );
    resolved[request.biomeId] = selected;
  }
  return Object.freeze(resolved);
}

/**
 * Lower family choices and regional density intent into population plans. The
 * model chooses semantic families and density envelopes once per region; this
 * function merges repeated family usage before the deterministic population
 * compiler emits instance transforms.
 */
export function compileResolvedFamilyPopulationPlans(input: {
  registry: WorldAssetFamilyRegistry;
  requests: readonly WorldBiomeFamilyRequest[];
}): readonly WorldFamilyPopulationPlan[] {
  const parsed = input.requests.map((request) => requestSchema.parse(request));
  const resolved = resolveWorldAssetFamilies({ registry: input.registry, requests: parsed });
  const familyById = new Map(input.registry.families.map((family) => [family.familyId, family]));
  const merged = new Map<string, WorldFamilyPopulationPlan>();
  for (const request of parsed) {
    const familyIds = resolved[request.biomeId] ?? [];
    const regionIds = [...(request.regionIds ?? [request.biomeId])].sort(compareWorldStrings);
    const surfaceKinds = [...(request.surfaceKinds ?? (["terrain"] as const))].sort(
      compareWorldStrings,
    ) as WorldFamilyPopulationPlan["surfaceKinds"];
    const distribution = request.distribution ?? "poisson_scatter";
    const minimumCount = request.minimumCount ?? 0;
    const maximumCount = request.maximumCount ?? Math.max(1, familyIds.length * 64);
    if (minimumCount > maximumCount)
      throw new Error(`Family population count range is inverted for ${request.biomeId}`);
    const density = request.density ?? { minimum: 0, target: 0.35, maximum: 1 };
    const countShare = Math.ceil(maximumCount / Math.max(familyIds.length, 1));
    for (const [index, familyId] of familyIds.entries()) {
      const existing = merged.get(familyId);
      const candidate: WorldFamilyPopulationPlan = WORLD_FAMILY_POPULATION_PLAN_SCHEMA.parse({
        familyId,
        regionIds,
        surfaceKinds,
        distribution,
        minimumCount: Math.floor(minimumCount / Math.max(familyIds.length, 1)),
        maximumCount: countShare,
        archetypeCount: familyById.get(familyId)?.variantCount ?? 1,
        scaleRange: [0.92, 1.08],
        density,
        variationSeed: (request.variationSeed ?? 0) + index,
        excludedRouteIds: [...(request.excludedRouteIds ?? [])].sort(compareWorldStrings),
        excludedRegionIds: [...(request.excludedRegionIds ?? [])].sort(compareWorldStrings),
      });
      if (!existing) merged.set(familyId, candidate);
      else
        merged.set(
          familyId,
          WORLD_FAMILY_POPULATION_PLAN_SCHEMA.parse({
            ...existing,
            regionIds: [...new Set([...existing.regionIds, ...candidate.regionIds])].sort(
              compareWorldStrings,
            ),
            surfaceKinds: [...new Set([...existing.surfaceKinds, ...candidate.surfaceKinds])].sort(
              compareWorldStrings,
            ),
            minimumCount: existing.minimumCount + candidate.minimumCount,
            maximumCount: existing.maximumCount + candidate.maximumCount,
            archetypeCount: Math.max(existing.archetypeCount ?? 1, candidate.archetypeCount ?? 1),
            scaleRange: [
              Math.min(existing.scaleRange?.[0] ?? 0.92, candidate.scaleRange?.[0] ?? 0.92),
              Math.max(existing.scaleRange?.[1] ?? 1.08, candidate.scaleRange?.[1] ?? 1.08),
            ],
            density: {
              minimum: Math.min(existing.density.minimum, candidate.density.minimum),
              target: Math.max(existing.density.target, candidate.density.target),
              maximum: Math.max(existing.density.maximum, candidate.density.maximum),
            },
            excludedRouteIds: [
              ...new Set([...existing.excludedRouteIds, ...candidate.excludedRouteIds]),
            ].sort(compareWorldStrings),
            excludedRegionIds: [
              ...new Set([...existing.excludedRegionIds, ...candidate.excludedRegionIds]),
            ].sort(compareWorldStrings),
          }),
        );
    }
  }
  return [...merged.values()].sort((left, right) =>
    compareWorldStrings(left.familyId, right.familyId),
  );
}

function normalize(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}
function canonicalTags(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize))].sort(compareWorldStrings);
}
