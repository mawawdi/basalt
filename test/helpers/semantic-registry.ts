import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AFFORDANCE_DEFINITION_SCHEMA,
  ANNOTATION_PREDICATE_DEFINITION_SCHEMA,
  CONCEPT_COMMITMENT_SCHEMA,
  REALIZATION_FORM_DEFINITION_SCHEMA,
  RELATION_DEFINITION_SCHEMA,
  ROLE_SCHEME_DEFINITION_SCHEMA,
  SEMANTIC_CONSTRAINT_SET_SCHEMA,
  SEMANTIC_KERNEL_SCHEMA,
  STATE_DIMENSION_DEFINITION_SCHEMA,
  SURFACE_TREATMENT_DEFINITION_SCHEMA,
  sealSemanticModule,
  type SemanticModule,
} from "@basalt/semantic-kernel";

const registryRoot = resolve("registry/semantics");

export async function loadSemanticRegistry(): Promise<SemanticModule> {
  const conceptFiles = (await readdir(resolve(registryRoot, "concepts"))).sort();
  const roleFiles = (await readdir(resolve(registryRoot, "roles"))).sort();
  return sealSemanticModule({
    kernel: SEMANTIC_KERNEL_SCHEMA.parse(await json("kernel.json")),
    concepts: await Promise.all(
      conceptFiles.map(async (file) =>
        CONCEPT_COMMITMENT_SCHEMA.parse(await json(`concepts/${file}`)),
      ),
    ),
    affordances: AFFORDANCE_DEFINITION_SCHEMA.array().parse(await json("affordances.json")),
    realizationForms: REALIZATION_FORM_DEFINITION_SCHEMA.array().parse(
      await json("realization-forms.json"),
    ),
    stateDimensions: STATE_DIMENSION_DEFINITION_SCHEMA.array().parse(await json("states.json")),
    surfaceTreatments: SURFACE_TREATMENT_DEFINITION_SCHEMA.array().parse(
      await json("treatments.json"),
    ),
    roleSchemes: await Promise.all(
      roleFiles.map(async (file) =>
        ROLE_SCHEME_DEFINITION_SCHEMA.parse(await json(`roles/${file}`)),
      ),
    ),
    relations: RELATION_DEFINITION_SCHEMA.array().parse(await json("relations.json")),
    annotationPredicates: ANNOTATION_PREDICATE_DEFINITION_SCHEMA.array().parse(
      await json("annotation-predicates.json"),
    ),
    constraints: SEMANTIC_CONSTRAINT_SET_SCHEMA.parse(await json("constraints.json")),
  });
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(registryRoot, path), "utf8"));
}
