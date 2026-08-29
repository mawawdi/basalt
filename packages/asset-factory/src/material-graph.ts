import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const PROCEDURAL_MATERIAL_GRAPH_ABI = "basalt-procedural-material-graph@2" as const;
export const MAXIMUM_PROCEDURAL_MATERIAL_NODES = 96 as const;
export const MAXIMUM_PROCEDURAL_MATERIAL_EVALUATION_COST = 384 as const;

const unitInterval = z.number().finite().min(0).max(1);
const boundedScalar = z.number().finite().min(-16).max(16);
const positiveStuds = z.number().finite().positive().max(100_000);
const positiveCycles = z.number().int().positive().max(256);
const phase = z.number().finite().min(-1024).max(1024);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

const scalarReference = entityId;
const colorReference = entityId;
const coordinateReference = entityId;
const tileFrequency = z
  .object({ u: positiveCycles, v: positiveCycles })
  .strict()
  .refine(({ u, v }) => u > 0 || v > 0, "A procedural field needs a nonzero frequency");
const exactColor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), color: hexColor }).strict(),
  z
    .object({
      kind: z.literal("palette"),
      paletteEntryId: entityId,
      channel: z.enum(["base_color", "emissive"]),
    })
    .strict(),
]);

const scalarNodes = [
  z.object({ id: entityId, kind: z.literal("scalar_constant"), value: boundedScalar }).strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("wave"),
      coordinateNodeId: coordinateReference,
      waveform: z.enum(["sine", "triangle", "saw", "square"]),
      cycles: z
        .object({ u: z.number().int().min(-256).max(256), v: z.number().int().min(-256).max(256) })
        .strict(),
      phase,
      dutyCycle: unitInterval.refine((value) => value > 0 && value < 1),
      softness: unitInterval,
    })
    .strict()
    .refine(({ cycles }) => cycles.u !== 0 || cycles.v !== 0, "A wave needs a nonzero cycle axis"),
  z
    .object({
      id: entityId,
      kind: z.literal("checker"),
      coordinateNodeId: coordinateReference,
      cells: tileFrequency,
      offset: z.object({ u: phase, v: phase }).strict(),
      softness: unitInterval,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("brick"),
      coordinateNodeId: coordinateReference,
      cells: tileFrequency,
      rowOffset: unitInterval,
      mortarFraction: z.number().finite().min(0).max(0.45),
      edgeSoftness: unitInterval,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("noise"),
      coordinateNodeId: coordinateReference,
      basis: z.enum(["value_fbm", "billow_fbm", "ridged_fbm"]),
      cells: tileFrequency,
      octaves: z.number().int().min(1).max(8),
      lacunarity: z.number().int().min(2).max(4),
      gain: z.number().finite().min(0).max(1),
      seedOffset: z.number().int().min(0).max(65_535),
      domainWarp: z
        .object({
          cells: tileFrequency,
          amplitude: z.number().finite().min(0).max(0.5),
          octaves: z.number().int().min(1).max(4),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("cellular"),
      coordinateNodeId: coordinateReference,
      cells: tileFrequency,
      metric: z.enum(["euclidean", "manhattan"]),
      output: z.enum(["distance", "edge_distance", "cell_value"]),
      jitter: unitInterval,
      seedOffset: z.number().int().min(0).max(65_535),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("motif"),
      coordinateNodeId: coordinateReference,
      shape: z.enum(["ellipse", "box", "diamond"]),
      cells: tileFrequency,
      center: z.object({ u: unitInterval, v: unitInterval }).strict(),
      size: z
        .object({
          u: z.number().finite().positive().max(1),
          v: z.number().finite().positive().max(1),
        })
        .strict(),
      rotationDegrees: z.number().finite().min(-360).max(360),
      edgeSoftness: unitInterval,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("coordinate_gradient"),
      coordinateNodeId: coordinateReference,
      axis: z.enum(["u", "v"]),
      low: boundedScalar,
      high: boundedScalar,
      clamp: z.boolean(),
      invert: z.boolean(),
    })
    .strict()
    .refine(({ low, high }) => low < high, "Coordinate-gradient range must ascend"),
  z
    .object({
      id: entityId,
      kind: z.literal("scalar_math"),
      operation: z.enum(["add", "subtract", "multiply", "minimum", "maximum"]),
      leftNodeId: scalarReference,
      rightNodeId: scalarReference,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("scalar_mix"),
      firstNodeId: scalarReference,
      secondNodeId: scalarReference,
      factorNodeId: scalarReference,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("remap"),
      inputNodeId: scalarReference,
      inputMinimum: boundedScalar,
      inputMaximum: boundedScalar,
      outputMinimum: boundedScalar,
      outputMaximum: boundedScalar,
      clamp: z.boolean(),
    })
    .strict()
    .refine(
      ({ inputMinimum, inputMaximum }) => inputMinimum < inputMaximum,
      "Remap input range must ascend",
    ),
  z
    .object({
      id: entityId,
      kind: z.literal("smoothstep"),
      inputNodeId: scalarReference,
      low: boundedScalar,
      high: boundedScalar,
    })
    .strict()
    .refine(({ low, high }) => low < high, "Smoothstep range must ascend"),
  z
    .object({
      id: entityId,
      kind: z.literal("invert"),
      inputNodeId: scalarReference,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("quantize"),
      inputNodeId: scalarReference,
      steps: z.number().int().min(2).max(64),
      ditherNodeId: scalarReference.optional(),
      ditherStrength: unitInterval,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("palette_property"),
      paletteEntryId: entityId,
      property: z.enum(["roughness", "metallic"]),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("context_field"),
      source: z.enum([
        "height_fraction",
        "normal_x",
        "normal_y",
        "normal_z",
        "upward_facing",
        "slope",
        "curvature",
        "contact",
        "edge_wear",
      ]),
      invert: z.boolean(),
    })
    .strict(),
] as const;

const coordinateNodes = [
  z
    .object({
      id: entityId,
      kind: z.literal("surface_coordinates"),
      projection: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("uv0") }).strict(),
        z
          .object({
            kind: z.literal("triplanar"),
            scaleStuds: z.object({ u: positiveStuds, v: positiveStuds }).strict(),
            blendExponent: z.number().finite().min(1).max(32),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("coordinate_transform"),
      inputNodeId: coordinateReference,
      translation: z.object({ u: boundedScalar, v: boundedScalar }).strict(),
      rotationDegrees: z.number().finite().min(-360).max(360),
      scale: z
        .object({
          u: z.number().finite().positive().max(256),
          v: z.number().finite().positive().max(256),
        })
        .strict(),
      pivot: z.object({ u: boundedScalar, v: boundedScalar }).strict(),
      wrap: z.enum(["repeat", "mirror"]),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("polar_coordinates"),
      inputNodeId: coordinateReference,
      center: z.object({ u: boundedScalar, v: boundedScalar }).strict(),
      radialScale: z.number().finite().positive().max(256),
      angularOffset: phase,
    })
    .strict(),
] as const;

const colorNodes = [
  z.object({ id: entityId, kind: z.literal("color_constant"), value: exactColor }).strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("color_ramp"),
      inputNodeId: scalarReference,
      interpolation: z.enum(["constant", "linear", "smooth"]),
      stops: z
        .array(z.object({ position: unitInterval, color: exactColor }).strict())
        .min(2)
        .max(16),
    })
    .strict()
    .superRefine(({ stops }, context) => {
      if (stops[0]?.position !== 0 || stops.at(-1)?.position !== 1)
        context.addIssue({
          code: "custom",
          path: ["stops"],
          message: "Color ramps must cover zero through one",
        });
      for (let index = 1; index < stops.length; index += 1)
        if (stops[index - 1]!.position >= stops[index]!.position)
          context.addIssue({
            code: "custom",
            path: ["stops", index, "position"],
            message: "Color-ramp stops must strictly ascend",
          });
    }),
  z
    .object({
      id: entityId,
      kind: z.literal("color_mix"),
      baseNodeId: colorReference,
      layerNodeId: colorReference,
      factorNodeId: scalarReference,
      operation: z.enum(["mix", "multiply", "screen", "overlay", "add"]),
    })
    .strict(),
] as const;

export const PROCEDURAL_MATERIAL_NODE_SCHEMA = z.discriminatedUnion("kind", [
  ...scalarNodes,
  ...coordinateNodes,
  ...colorNodes,
]);
export type ProceduralMaterialNode = z.infer<typeof PROCEDURAL_MATERIAL_NODE_SCHEMA>;

const MATERIAL_GRAPH_CONTENT_SCHEMA = z
  .object({
    kind: z.literal("ProceduralMaterialGraph"),
    abi: z.literal(PROCEDURAL_MATERIAL_GRAPH_ABI),
    seed: z.number().int().min(0).max(2_147_483_647),
    texelDensity: z
      .object({
        authority: z.literal("style_contract"),
        targetScale: z.number().finite().min(0.25).max(4),
      })
      .strict(),
    robloxLowering: z
      .object({
        target: z.literal("surface_appearance"),
        proceduralState: z.literal("bake_to_textures"),
        lossPolicy: z.literal("record_exact"),
      })
      .strict(),
    nodes: z.array(PROCEDURAL_MATERIAL_NODE_SCHEMA).min(1).max(MAXIMUM_PROCEDURAL_MATERIAL_NODES),
    outputs: z
      .object({
        baseColorNodeId: colorReference,
        roughnessNodeId: scalarReference,
        metallicNodeId: scalarReference,
        occlusionNodeId: scalarReference,
        opacityNodeId: scalarReference,
        normal: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("flat") }).strict(),
          z
            .object({
              kind: z.literal("height_gradient"),
              heightNodeId: scalarReference,
              amplitudeStuds: z.number().finite().positive().max(10),
            })
            .strict(),
        ]),
        emissiveNodeId: colorReference.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((graph, context) => validateMaterialGraph(graph, context));

export const PROCEDURAL_MATERIAL_GRAPH_SCHEMA = MATERIAL_GRAPH_CONTENT_SCHEMA.safeExtend({
  hash: hashSchema,
})
  .strict()
  .superRefine((graph, context) => {
    const { hash, ...material } = graph;
    if (contentHash(stableJson(material)) !== hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Procedural material graph identity is invalid",
      });
  });
export type ProceduralMaterialGraph = z.infer<typeof PROCEDURAL_MATERIAL_GRAPH_SCHEMA>;

export function sealProceduralMaterialGraph(
  input: z.input<typeof MATERIAL_GRAPH_CONTENT_SCHEMA>,
): ProceduralMaterialGraph {
  const material = MATERIAL_GRAPH_CONTENT_SCHEMA.parse(input);
  return PROCEDURAL_MATERIAL_GRAPH_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertProceduralMaterialGraphIdentity(
  value: unknown,
): asserts value is ProceduralMaterialGraph {
  PROCEDURAL_MATERIAL_GRAPH_SCHEMA.parse(value);
}

export function proceduralMaterialGraphPaletteEntryIds(
  graph: ProceduralMaterialGraph,
): readonly string[] {
  return [...new Set(proceduralMaterialGraphPaletteBindings(graph).map(({ id }) => id))].sort(
    compareSpatialStrings,
  );
}

export function proceduralMaterialGraphPaletteBindings(graph: ProceduralMaterialGraph): readonly {
  readonly id: string;
  readonly channel: "base_color" | "emissive" | "roughness" | "metallic";
}[] {
  const bindings = new Map<string, "base_color" | "emissive" | "roughness" | "metallic">();
  const retain = (value: z.infer<typeof exactColor>): void => {
    if (value.kind === "palette")
      bindings.set(`${value.paletteEntryId}\0${value.channel}`, value.channel);
  };
  for (const node of graph.nodes) {
    if (node.kind === "palette_property")
      bindings.set(`${node.paletteEntryId}\0${node.property}`, node.property);
    if (node.kind === "color_constant") retain(node.value);
    if (node.kind === "color_ramp") for (const stop of node.stops) retain(stop.color);
  }
  return [...bindings.entries()]
    .map(([key, channel]) => ({ id: key.split("\0", 1)[0]!, channel }))
    .sort((left, right) =>
      compareSpatialStrings(`${left.id}\0${left.channel}`, `${right.id}\0${right.channel}`),
    );
}

export function proceduralMaterialGraphEvaluationCost(graph: ProceduralMaterialGraph): number {
  return graph.nodes.reduce((total, node) => {
    if (node.kind === "noise")
      return total + node.octaves * 4 + (node.domainWarp ? node.domainWarp.octaves * 8 : 0);
    if (node.kind === "cellular") return total + 18;
    if (node.kind === "brick" || node.kind === "motif") return total + 4;
    if (node.kind === "surface_coordinates")
      return total + (node.projection.kind === "triplanar" ? 8 : 1);
    if (node.kind === "coordinate_transform") return total + 3;
    if (node.kind === "polar_coordinates") return total + 4;
    if (node.kind === "color_ramp") return total + node.stops.length;
    return total + 1;
  }, 0);
}

function nodeOutputType(node: ProceduralMaterialNode): "scalar" | "color" | "coordinate" {
  if (
    node.kind === "surface_coordinates" ||
    node.kind === "coordinate_transform" ||
    node.kind === "polar_coordinates"
  )
    return "coordinate";
  return node.kind === "color_constant" || node.kind === "color_ramp" || node.kind === "color_mix"
    ? "color"
    : "scalar";
}

function nodeReferences(
  node: ProceduralMaterialNode,
): readonly { id: string; type: "scalar" | "color" | "coordinate" }[] {
  switch (node.kind) {
    case "wave":
    case "checker":
    case "brick":
    case "noise":
    case "cellular":
    case "motif":
    case "coordinate_gradient":
      return [{ id: node.coordinateNodeId, type: "coordinate" }];
    case "coordinate_transform":
    case "polar_coordinates":
      return [{ id: node.inputNodeId, type: "coordinate" }];
    case "scalar_math":
      return [
        { id: node.leftNodeId, type: "scalar" },
        { id: node.rightNodeId, type: "scalar" },
      ];
    case "scalar_mix":
      return [
        { id: node.firstNodeId, type: "scalar" },
        { id: node.secondNodeId, type: "scalar" },
        { id: node.factorNodeId, type: "scalar" },
      ];
    case "remap":
    case "smoothstep":
    case "invert":
      return [{ id: node.inputNodeId, type: "scalar" }];
    case "quantize":
      return [
        { id: node.inputNodeId, type: "scalar" },
        ...(node.ditherNodeId ? [{ id: node.ditherNodeId, type: "scalar" as const }] : []),
      ];
    case "color_ramp":
      return [{ id: node.inputNodeId, type: "scalar" }];
    case "color_mix":
      return [
        { id: node.baseNodeId, type: "color" },
        { id: node.layerNodeId, type: "color" },
        { id: node.factorNodeId, type: "scalar" },
      ];
    default:
      return [];
  }
}

function validateMaterialGraph(
  graph: z.infer<typeof MATERIAL_GRAPH_CONTENT_SCHEMA>,
  context: z.RefinementCtx,
): void {
  const ids = graph.nodes.map(({ id }) => id);
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify([...ids].sort(compareSpatialStrings))
  )
    context.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "Material nodes must be unique and canonical by ID",
    });
  const nodes = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const dependencies = new Map<string, string[]>();
  for (const [index, node] of graph.nodes.entries()) {
    const references = nodeReferences(node);
    dependencies.set(
      node.id,
      references.map(({ id }) => id),
    );
    for (const reference of references) {
      const target = nodes.get(reference.id);
      if (!target)
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: `Material node references an absent node: ${reference.id}`,
        });
      else if (nodeOutputType(target) !== reference.type)
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: `Material node reference has the wrong type: ${reference.id}`,
        });
    }
  }
  for (const [field, id, type] of [
    ["baseColorNodeId", graph.outputs.baseColorNodeId, "color"],
    ["roughnessNodeId", graph.outputs.roughnessNodeId, "scalar"],
    ["metallicNodeId", graph.outputs.metallicNodeId, "scalar"],
    ["occlusionNodeId", graph.outputs.occlusionNodeId, "scalar"],
    ["opacityNodeId", graph.outputs.opacityNodeId, "scalar"],
    ...(graph.outputs.normal.kind === "height_gradient"
      ? [["normal.heightNodeId", graph.outputs.normal.heightNodeId, "scalar"]]
      : []),
    ...(graph.outputs.emissiveNodeId
      ? [["emissiveNodeId", graph.outputs.emissiveNodeId, "color"]]
      : []),
  ] as const) {
    const target = nodes.get(id);
    if (!target || nodeOutputType(target) !== type)
      context.addIssue({
        code: "custom",
        path: ["outputs", field],
        message: `Material output must reference a ${type} node`,
      });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (ids.some((id) => !visit(id)))
    context.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "Material node graph must be acyclic",
    });
  const cost = graph.nodes.reduce((total, node) => {
    if (node.kind === "noise")
      return total + node.octaves * 4 + (node.domainWarp ? node.domainWarp.octaves * 8 : 0);
    if (node.kind === "cellular") return total + 18;
    if (node.kind === "brick" || node.kind === "motif") return total + 4;
    if (node.kind === "surface_coordinates")
      return total + (node.projection.kind === "triplanar" ? 8 : 1);
    if (node.kind === "coordinate_transform") return total + 3;
    if (node.kind === "polar_coordinates") return total + 4;
    if (node.kind === "color_ramp") return total + node.stops.length;
    return total + 1;
  }, 0);
  if (cost > MAXIMUM_PROCEDURAL_MATERIAL_EVALUATION_COST)
    context.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "Material graph exceeds its deterministic evaluation budget",
    });
}
