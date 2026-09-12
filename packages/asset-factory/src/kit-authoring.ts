import { z } from "zod";
import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";
import { compareSpatialStrings } from "../../spatial-core/src/primitives.js";
import { JOINT_PLANE_DISTANCE_STUDS } from "../../asset-inspection/src/joint-planes.js";
import { buildJointSockets, type JointSocketFit } from "../../catalog-intelligence/src/sockets.js";
import {
  evaluateModularKit,
  matingFaceSets,
  type ModularKitMember,
} from "../../catalog-intelligence/src/joint-mating.js";
import { PLACEMENT_SURFACE_KINDS } from "../../world-planning/src/contracts.js";
import {
  MODULAR_KIT_REQUIREMENT_SCHEMA,
  type ModularKitAdjacencyRule,
  type ModularKitRequirement,
} from "./modular-kit.js";

/**
 * Kit specs authored from measured evidence. A kit definition names member
 * assets plus optional authored adjacency; everything structural —
 * archetype sockets, mating pairs, module pitch — derives from sealed
 * joint measurement through the modularity gate. A kit whose members do
 * not hang together fails with the gate's reason: incoherent kits never
 * seal. Socket IDs index every measured face (not the mating subset), so
 * the same face keeps its ID across family and kit seals. Authored rules
 * reference sealed mating faces: they reweight and emphasize measured
 * adjacency rather than vouching for faces the gate refused.
 */

export interface KitMemberEvidence {
  readonly assetId: string;
  readonly variantName: string;
  readonly semanticRole: string;
  readonly sourceFamilyId: string;
  readonly sourceVariantIndex: number;
  readonly boundsStuds: readonly [number, number, number];
  readonly boundsMinimumQ32_32: { readonly x: string; readonly y: string; readonly z: string };
  readonly boundsMaximumQ32_32: { readonly x: string; readonly y: string; readonly z: string };
  readonly triangleCount: number;
  readonly supportedSurfaceKinds: ReadonlyArray<string>;
  readonly jointPlaneFits: ReadonlyArray<JointSocketFit>;
  readonly jointPlaneRefusal: string | null;
}

export interface KitAuthoredAdjacencyRule {
  readonly sourceArchetypeId: string;
  readonly sourceSocketId: string;
  readonly targetArchetypeId: string;
  readonly targetSocketId: string;
  readonly probabilityWeight?: number;
}

export interface KitDefinition {
  readonly kitId: string;
  readonly name: string;
  readonly styleContractHash: string;
  readonly members: ReadonlyArray<KitMemberEvidence>;
  readonly modulePitchStuds?: number;
  readonly authoredRules?: ReadonlyArray<KitAuthoredAdjacencyRule>;
}

const PLACEMENT_KINDS = new Set<string>(PLACEMENT_SURFACE_KINDS);

function failKit(kitId: string, reason: string): never {
  throw new Error(`Kit ${kitId} is not authorable: ${reason}`);
}

export function buildKitRequirement(definition: KitDefinition): ModularKitRequirement {
  if (definition.members.length === 0) failKit(definition.kitId, "declares no members");
  if (definition.members.length > 64)
    failKit(
      definition.kitId,
      `declares ${definition.members.length} members, beyond 64 archetypes`,
    );
  const seen = new Set<string>();
  for (const member of definition.members) {
    if (seen.has(member.assetId)) failKit(definition.kitId, `declares ${member.assetId} twice`);
    seen.add(member.assetId);
  }
  // Canonical member order absorbs declaration order everywhere below.
  const members = [...definition.members].sort((left, right) =>
    compareSpatialStrings(left.assetId, right.assetId),
  );
  const kitMembers: ModularKitMember[] = members.map((member) => ({
    assetId: member.assetId,
    variantName: member.variantName,
    sockets:
      member.jointPlaneFits.length > 0
        ? buildJointSockets({
            variantName: member.variantName,
            jointPlaneFits: member.jointPlaneFits,
          })
        : [],
    refusal: member.jointPlaneRefusal,
    boundsMinimumQ32_32: member.boundsMinimumQ32_32,
    boundsMaximumQ32_32: member.boundsMaximumQ32_32,
  }));
  const verdict = evaluateModularKit(kitMembers);
  if (verdict.status !== "modular") failKit(definition.kitId, verdict.reason);
  const matingSets = matingFaceSets(verdict, kitMembers.length);
  const archetypes = members.map((member, index) => {
    const mating = matingSets[index]!;
    const sockets = kitMembers[index]!.sockets.filter((_, socketIndex) => mating.has(socketIndex));
    if (sockets.length === 0)
      failKit(definition.kitId, `member ${member.assetId} mates nothing after the verdict`);
    if (sockets.length > 64)
      failKit(
        definition.kitId,
        `member ${member.assetId} seals ${sockets.length} mating sockets, beyond 64 per archetype`,
      );
    if (!Number.isInteger(member.triangleCount) || member.triangleCount < 1)
      failKit(definition.kitId, `member ${member.assetId} reports no measurable triangles`);
    if (member.triangleCount > 65_536)
      failKit(
        definition.kitId,
        `member ${member.assetId} reports ${member.triangleCount} triangles, beyond the 65536 archetype budget`,
      );
    if (!Number.isInteger(member.sourceVariantIndex) || member.sourceVariantIndex < 0)
      failKit(definition.kitId, `member ${member.assetId} carries a bad source variant index`);
    const boundsMinimum = {
      x: dequantizeQ32_32(member.boundsMinimumQ32_32.x),
      y: dequantizeQ32_32(member.boundsMinimumQ32_32.y),
      z: dequantizeQ32_32(member.boundsMinimumQ32_32.z),
    };
    const boundsMaximum = {
      x: dequantizeQ32_32(member.boundsMaximumQ32_32.x),
      y: dequantizeQ32_32(member.boundsMaximumQ32_32.y),
      z: dequantizeQ32_32(member.boundsMaximumQ32_32.z),
    };
    return {
      archetypeId: member.assetId,
      name: member.variantName,
      semanticRole: member.semanticRole,
      sourceFamilyId: member.sourceFamilyId,
      sourceVariantIndex: member.sourceVariantIndex,
      boundsCenterStuds: [
        (boundsMinimum.x + boundsMaximum.x) / 2,
        (boundsMinimum.y + boundsMaximum.y) / 2,
        (boundsMinimum.z + boundsMaximum.z) / 2,
      ],
      boundingEnvelope: [member.boundsStuds[0], member.boundsStuds[1], member.boundsStuds[2]] as [
        number,
        number,
        number,
      ],
      maxTriangleBudget: member.triangleCount,
      sockets,
      supportedSurfaceKinds: [...new Set(member.supportedSurfaceKinds)]
        .filter((kind) => PLACEMENT_KINDS.has(kind))
        .sort(compareSpatialStrings),
    };
  });
  const ruleKey = (rule: {
    readonly sourceArchetypeId: string;
    readonly sourceSocketId: string;
    readonly targetArchetypeId: string;
    readonly targetSocketId: string;
  }): string =>
    `${rule.sourceArchetypeId}|${rule.sourceSocketId}|${rule.targetArchetypeId}|${rule.targetSocketId}`;
  const rules = new Map<string, ModularKitAdjacencyRule>();
  for (const pair of verdict.matingPairs) {
    const source = kitMembers[pair.leftMember]!;
    const target = kitMembers[pair.rightMember]!;
    const rule: ModularKitAdjacencyRule = {
      sourceArchetypeId: source.assetId,
      sourceSocketId: source.sockets[pair.leftSocket]!.socketId,
      targetArchetypeId: target.assetId,
      targetSocketId: target.sockets[pair.rightSocket]!.socketId,
      probabilityWeight: 1.0,
    };
    const key = ruleKey(rule);
    const prior = rules.get(key);
    if (prior === undefined || prior.probabilityWeight < rule.probabilityWeight)
      rules.set(key, rule);
  }
  const authored = [...(definition.authoredRules ?? [])].sort((left, right) =>
    compareSpatialStrings(ruleKey(left), ruleKey(right)),
  );
  const archetypeIds = new Set(archetypes.map((archetype) => archetype.archetypeId));
  const socketIds = new Map(
    archetypes.map((archetype) => [
      archetype.archetypeId,
      new Set(archetype.sockets.map((socket) => socket.socketId)),
    ]),
  );
  for (const rule of authored) {
    for (const [role, archetypeId, socketId] of [
      ["source", rule.sourceArchetypeId, rule.sourceSocketId],
      ["target", rule.targetArchetypeId, rule.targetSocketId],
    ] as const) {
      if (!archetypeIds.has(archetypeId))
        failKit(
          definition.kitId,
          `authored rule references unknown ${role} archetype ${archetypeId}`,
        );
      if (!socketIds.get(archetypeId)!.has(socketId))
        failKit(
          definition.kitId,
          `authored rule references unknown ${role} socket ${socketId} on ${archetypeId}`,
        );
    }
    const weight = rule.probabilityWeight ?? 1.0;
    if (!Number.isFinite(weight) || weight <= 0)
      failKit(definition.kitId, `authored rule carries a non-positive weight`);
    const full: ModularKitAdjacencyRule = {
      sourceArchetypeId: rule.sourceArchetypeId,
      sourceSocketId: rule.sourceSocketId,
      targetArchetypeId: rule.targetArchetypeId,
      targetSocketId: rule.targetSocketId,
      probabilityWeight: weight,
    };
    const key = ruleKey(full);
    const prior = rules.get(key);
    if (prior === undefined || prior.probabilityWeight < weight) rules.set(key, full);
  }
  if (rules.size > 4096)
    failKit(definition.kitId, `seals ${rules.size} adjacency rules, beyond 4096`);
  const pitch =
    definition.modulePitchStuds ??
    Math.min(...members.map((member) => Math.max(member.boundsStuds[0], member.boundsStuds[2])));
  if (!Number.isFinite(pitch) || pitch <= 0)
    failKit(definition.kitId, "derives a non-positive module pitch from member bounds");
  try {
    return MODULAR_KIT_REQUIREMENT_SCHEMA.parse({
      kind: "ModularKitRequirement",
      abi: "basalt-modular-kit@1",
      kitId: definition.kitId,
      name: definition.name,
      styleContractHash: definition.styleContractHash,
      modulePitchStuds: pitch,
      archetypes,
      adjacencyRules: [...rules.values()],
      // Solver tolerances inherit the measurement gate: faces mate within
      // the fitter's plane gate, volumes never interpenetrate.
      tolerances: {
        socketMismatchThreshold: JOINT_PLANE_DISTANCE_STUDS,
        maxMeshInterpenetration: 0,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      failKit(
        definition.kitId,
        error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    throw error;
  }
}
