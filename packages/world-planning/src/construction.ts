import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { SPATIAL_VECTOR3_SCHEMA, entityId } from "@basalt/spatial-core";

const finite = z.number().finite();

export const CONSTRUCTION_PARAMETER_SCHEMA = z
  .object({
    parameterId: entityId,
    kind: z.enum(["integer", "scalar"]),
    value: finite,
    minimum: finite,
    maximum: finite,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimum > value.value || value.value > value.maximum)
      context.addIssue({ code: "custom", message: "Construction parameter is outside its bounds" });
    if (
      value.kind === "integer" &&
      ![value.minimum, value.value, value.maximum].every(Number.isSafeInteger)
    )
      context.addIssue({
        code: "custom",
        message: "Integer construction parameters must be integers",
      });
  });
export type ConstructionParameter = z.output<typeof CONSTRUCTION_PARAMETER_SCHEMA>;

export const CONSTRUCTION_SCALAR_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: finite }).strict(),
  z
    .object({
      kind: z.literal("parameter_binding"),
      parameterId: entityId,
      multiplier: finite,
      offset: finite,
    })
    .strict(),
]);
export const CONSTRUCTION_INTEGER_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.number().int().positive().max(65_536) }).strict(),
  z.object({ kind: z.literal("integer_parameter"), parameterId: entityId }).strict(),
]);
export type ConstructionScalar = z.output<typeof CONSTRUCTION_SCALAR_SCHEMA>;
export type ConstructionInteger = z.output<typeof CONSTRUCTION_INTEGER_SCHEMA>;

const constructionVector = z
  .object({
    x: CONSTRUCTION_SCALAR_SCHEMA,
    y: CONSTRUCTION_SCALAR_SCHEMA,
    z: CONSTRUCTION_SCALAR_SCHEMA,
  })
  .strict();

const operationBase = {
  operationId: entityId,
  materialId: entityId.optional(),
};

const BOX_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("box"),
    centerMeters: constructionVector,
    sizeMeters: constructionVector,
    templateOnly: z.boolean(),
  })
  .strict();

const CYLINDER_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("cylinder"),
    centerMeters: constructionVector,
    radiusMeters: CONSTRUCTION_SCALAR_SCHEMA,
    heightMeters: CONSTRUCTION_SCALAR_SCHEMA,
    sides: z.number().int().min(8).max(128),
    templateOnly: z.boolean(),
  })
  .strict();

const LINEAR_REPEAT_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("linear_repeat"),
    sourceOperationId: entityId,
    count: CONSTRUCTION_INTEGER_SCHEMA,
    stepMeters: constructionVector,
  })
  .strict();

const RECTANGULAR_OPENING_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("rectangular_opening"),
    hostOperationId: entityId,
    plane: z.enum(["xy", "yz"]),
    centerOffsetMeters: z
      .object({ horizontal: CONSTRUCTION_SCALAR_SCHEMA, vertical: CONSTRUCTION_SCALAR_SCHEMA })
      .strict(),
    sizeMeters: z
      .object({ width: CONSTRUCTION_SCALAR_SCHEMA, height: CONSTRUCTION_SCALAR_SCHEMA })
      .strict(),
    portalId: entityId.optional(),
    clearanceMeters: CONSTRUCTION_SCALAR_SCHEMA,
  })
  .strict();

const SURFACE_ATTACHMENT_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("surface_attachment"),
    hostOperationId: entityId,
    childOperationId: entityId,
    hostFace: z.enum([
      "negative_x",
      "negative_y",
      "negative_z",
      "positive_x",
      "positive_y",
      "positive_z",
    ]),
    childFace: z.enum([
      "negative_x",
      "negative_y",
      "negative_z",
      "positive_x",
      "positive_y",
      "positive_z",
    ]),
    maximumGapMeters: CONSTRUCTION_SCALAR_SCHEMA,
  })
  .strict();

const STAIR_RUN_OPERATION_SCHEMA = z
  .object({
    ...operationBase,
    kind: z.literal("stair_run"),
    originMeters: constructionVector,
    direction: z.enum(["negative_x", "negative_z", "positive_x", "positive_z"]),
    widthMeters: CONSTRUCTION_SCALAR_SCHEMA,
    runMeters: CONSTRUCTION_SCALAR_SCHEMA,
    riseMeters: CONSTRUCTION_SCALAR_SCHEMA,
    maximumRiserHeightMeters: CONSTRUCTION_SCALAR_SCHEMA,
    maximumTreadDepthMeters: CONSTRUCTION_SCALAR_SCHEMA,
    minimumHeadroomMeters: CONSTRUCTION_SCALAR_SCHEMA,
    entryRouteId: entityId,
    landingOperationId: entityId,
  })
  .strict();

export const CONSTRUCTION_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  BOX_OPERATION_SCHEMA,
  CYLINDER_OPERATION_SCHEMA,
  LINEAR_REPEAT_OPERATION_SCHEMA,
  RECTANGULAR_OPENING_OPERATION_SCHEMA,
  SURFACE_ATTACHMENT_OPERATION_SCHEMA,
  STAIR_RUN_OPERATION_SCHEMA,
]);
export type ConstructionOperation = z.output<typeof CONSTRUCTION_OPERATION_SCHEMA>;

/** A bounded, declarative construction graph. It contains no expressions or callbacks. */
export const CONSTRUCTION_PROGRAM_SCHEMA = z
  .object({
    kind: z.literal("ConstructionProgram"),
    programId: entityId,
    regionId: entityId,
    semanticDependencyClosureHash: HASH_SCHEMA,
    styleProfileHash: HASH_SCHEMA,
    defaultMaterialId: entityId,
    anchor: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("region_point"),
          positionMeters: SPATIAL_VECTOR3_SCHEMA,
        })
        .strict(),
      z
        .object({
          kind: z.literal("placement_surface"),
          surfaceId: entityId,
          horizontalPositionMeters: z.object({ x: finite, z: finite }).strict(),
          elevationOffsetMeters: finite,
        })
        .strict(),
    ]),
    localFrame: z
      .object({
        originOffsetMeters: SPATIAL_VECTOR3_SCHEMA,
        yawQuarterTurns: z.number().int().min(0).max(3),
      })
      .strict(),
    parameters: z.array(CONSTRUCTION_PARAMETER_SCHEMA).max(256),
    operations: z.array(CONSTRUCTION_OPERATION_SCHEMA).min(1).max(8_192),
    contributionEvidenceHashes: z.array(HASH_SCHEMA).max(256),
    programHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => validateConstructionProgram(value, context));
export type ConstructionProgram = z.output<typeof CONSTRUCTION_PROGRAM_SCHEMA>;

export function sealConstructionProgram(
  input: Omit<ConstructionProgram, "kind" | "programHash">,
): ConstructionProgram {
  const material = {
    kind: "ConstructionProgram" as const,
    ...input,
    parameters: [...input.parameters].sort((left, right) =>
      compareCanonicalStrings(left.parameterId, right.parameterId),
    ),
    operations: [...input.operations].sort((left, right) =>
      compareCanonicalStrings(left.operationId, right.operationId),
    ),
    contributionEvidenceHashes: [...new Set(input.contributionEvidenceHashes)].sort(
      compareCanonicalStrings,
    ),
  };
  return deepFreezeJson(
    CONSTRUCTION_PROGRAM_SCHEMA.parse({
      ...material,
      programHash: contentHash(stableJson(material)),
    }),
  );
}

export function resolveConstructionScalar(
  value: ConstructionScalar,
  parameters: ReadonlyMap<string, ConstructionParameter>,
): number {
  if (value.kind === "literal") return value.value;
  const parameter = parameters.get(value.parameterId);
  if (!parameter) throw new Error(`Unknown construction parameter ${value.parameterId}`);
  return parameter.value * value.multiplier + value.offset;
}

export function resolveConstructionInteger(
  value: ConstructionInteger,
  parameters: ReadonlyMap<string, ConstructionParameter>,
): number {
  if (value.kind === "literal") return value.value;
  const parameter = parameters.get(value.parameterId);
  if (!parameter) throw new Error(`Unknown construction parameter ${value.parameterId}`);
  if (parameter.kind !== "integer")
    throw new Error(`Construction parameter ${value.parameterId} is not an integer`);
  return parameter.value;
}

export function constructionParameterMap(
  program: ConstructionProgram,
): ReadonlyMap<string, ConstructionParameter> {
  return new Map(program.parameters.map((entry) => [entry.parameterId, entry] as const));
}

export function replaceConstructionParameters(
  programInput: ConstructionProgram,
  changes: readonly { readonly parameterId: string; readonly value: number }[],
): ConstructionProgram {
  const program = CONSTRUCTION_PROGRAM_SCHEMA.parse(programInput);
  const replacements = new Map(changes.map((entry) => [entry.parameterId, entry.value] as const));
  if (replacements.size !== changes.length)
    throw new Error("Construction parameter changes must be unique");
  for (const parameterId of replacements.keys())
    if (!program.parameters.some((entry) => entry.parameterId === parameterId))
      throw new Error(`Unknown construction parameter ${parameterId}`);
  const { kind: _kind, programHash: _programHash, parameters: _parameters, ...unchanged } = program;
  return sealConstructionProgram({
    ...unchanged,
    parameters: program.parameters.map((parameter) => ({
      ...parameter,
      value: replacements.get(parameter.parameterId) ?? parameter.value,
    })),
  });
}

function validateConstructionProgram(value: ConstructionProgram, context: z.RefinementCtx): void {
  const material = { ...value };
  delete (material as Partial<ConstructionProgram>).programHash;
  if (contentHash(stableJson(material)) !== value.programHash)
    context.addIssue({
      code: "custom",
      path: ["programHash"],
      message: "Construction program hash mismatch",
    });
  const parameterIds = value.parameters.map((entry) => entry.parameterId);
  const operationIds = value.operations.map((entry) => entry.operationId);
  if (new Set(parameterIds).size !== parameterIds.length)
    context.addIssue({
      code: "custom",
      path: ["parameters"],
      message: "Construction parameters must be unique",
    });
  if (new Set(operationIds).size !== operationIds.length)
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Construction operations must be unique",
    });
  if (stableJson([...parameterIds].sort(compareCanonicalStrings)) !== stableJson(parameterIds))
    context.addIssue({
      code: "custom",
      path: ["parameters"],
      message: "Construction parameters must be canonical",
    });
  if (stableJson([...operationIds].sort(compareCanonicalStrings)) !== stableJson(operationIds))
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Construction operations must be canonical",
    });
  const parameters = new Map(value.parameters.map((entry) => [entry.parameterId, entry] as const));
  const operations = new Map(value.operations.map((entry) => [entry.operationId, entry] as const));
  const scalarReferences = (candidate: unknown): string[] => {
    if (!candidate || typeof candidate !== "object") return [];
    if (Array.isArray(candidate)) return candidate.flatMap(scalarReferences);
    const record = candidate as Record<string, unknown>;
    return [
      ...((record.kind === "parameter_binding" || record.kind === "integer_parameter") &&
      typeof record.parameterId === "string"
        ? [record.parameterId]
        : []),
      ...Object.values(record).flatMap(scalarReferences),
    ];
  };
  const referencedParameters = new Set(value.operations.flatMap(scalarReferences));
  for (const [index, parameter] of value.parameters.entries())
    if (!referencedParameters.has(parameter.parameterId))
      context.addIssue({
        code: "custom",
        path: ["parameters", index],
        message: `Construction parameter ${parameter.parameterId} does not control any operation`,
      });
  for (const [index, operation] of value.operations.entries()) {
    for (const parameterId of scalarReferences(operation))
      if (!parameters.has(parameterId))
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: `Operation references unknown parameter ${parameterId}`,
        });
    if (operation.kind === "linear_repeat") {
      const source = operations.get(operation.sourceOperationId);
      if (!source || (source.kind !== "box" && source.kind !== "cylinder") || !source.templateOnly)
        context.addIssue({
          code: "custom",
          path: ["operations", index, "sourceOperationId"],
          message: "Linear repeat requires a template-only box or cylinder",
        });
      if (operation.count.kind === "integer_parameter") {
        const parameter = parameters.get(operation.count.parameterId);
        if (parameter?.kind !== "integer")
          context.addIssue({
            code: "custom",
            path: ["operations", index, "count"],
            message: "Linear repeat count requires an integer parameter",
          });
      }
    }
    if (operation.kind === "rectangular_opening") {
      const host = operations.get(operation.hostOperationId);
      if (!host || host.kind !== "box" || host.templateOnly)
        context.addIssue({
          code: "custom",
          path: ["operations", index, "hostOperationId"],
          message: "Rectangular opening requires one emitted box host",
        });
    }
    if (operation.kind === "surface_attachment") {
      const host = operations.get(operation.hostOperationId);
      const child = operations.get(operation.childOperationId);
      if (
        !host ||
        !child ||
        host.operationId === child.operationId ||
        (host.kind !== "box" && host.kind !== "cylinder") ||
        (child.kind !== "box" && child.kind !== "cylinder") ||
        host.templateOnly ||
        child.templateOnly
      )
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: "Surface attachment requires distinct emitted primitive operations",
        });
    }
    if (operation.kind === "stair_run") {
      const landing = operations.get(operation.landingOperationId);
      if (!landing || landing.kind !== "box" || landing.templateOnly)
        context.addIssue({
          code: "custom",
          path: ["operations", index, "landingOperationId"],
          message: "A stair run requires one emitted box landing",
        });
    }
  }
  const openingHosts = value.operations
    .filter((entry) => entry.kind === "rectangular_opening")
    .map((entry) => entry.hostOperationId);
  if (new Set(openingHosts).size !== openingHosts.length)
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "One box host may have at most one rectangular opening",
    });
  const templateIds = new Set(
    value.operations
      .filter((entry) => entry.kind === "linear_repeat")
      .map((entry) => entry.sourceOperationId),
  );
  for (const operation of value.operations)
    if (
      (operation.kind === "box" || operation.kind === "cylinder") &&
      operation.templateOnly &&
      !templateIds.has(operation.operationId)
    )
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Template ${operation.operationId} is not repeated`,
      });

  const attachedChildren = value.operations
    .filter((entry) => entry.kind === "surface_attachment")
    .map((entry) => entry.childOperationId);
  if (new Set(attachedChildren).size !== attachedChildren.length)
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "A construction operation may have at most one surface host",
    });
  const dependencyEdges = value.operations.flatMap((operation) => {
    if (operation.kind === "linear_repeat")
      return [[operation.sourceOperationId, operation.operationId] as const];
    if (operation.kind === "rectangular_opening")
      return [[operation.hostOperationId, operation.operationId] as const];
    if (operation.kind === "surface_attachment")
      return [[operation.hostOperationId, operation.childOperationId] as const];
    if (operation.kind === "stair_run")
      return [[operation.landingOperationId, operation.operationId] as const];
    return [];
  });
  if (hasDirectedCycle(operationIds, dependencyEdges))
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Construction operation dependencies must be acyclic",
    });
  requireCanonicalStrings(value.contributionEvidenceHashes, "construction evidence", context);
}

function hasDirectedCycle(
  nodes: readonly string[],
  edges: readonly (readonly [string, string])[],
): boolean {
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]] as const));
  const indegree = new Map<string, number>(nodes.map((node) => [node, 0]));
  for (const [from, to] of edges) {
    if (!outgoing.has(from) || !indegree.has(to)) continue;
    outgoing.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const queue = [...nodes.filter((node) => indegree.get(node) === 0)].sort(compareCanonicalStrings);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    for (const child of outgoing.get(node) ?? []) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
    queue.sort(compareCanonicalStrings);
  }
  return visited !== nodes.length;
}

function requireCanonicalStrings(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (
    new Set(values).size !== values.length ||
    stableJson([...values].sort(compareCanonicalStrings)) !== stableJson(values)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}
