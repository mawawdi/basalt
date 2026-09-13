import {
  CATALOG_ENTRY_KINDS,
  CATALOG_ENTRY_VALIDATOR_BY_KIND,
  REALIZATION_INTENT_SCHEMA,
} from "../packages/catalog-model/dist/index.js";
import { REALIZATION_INTENT_REALIZER_BY_KIND } from "../packages/world-compiler/dist/index.js";

assertExactlyOnce(
  "catalog entry validators",
  CATALOG_ENTRY_KINDS,
  Object.keys(CATALOG_ENTRY_VALIDATOR_BY_KIND),
);
const intentKinds = REALIZATION_INTENT_SCHEMA.options.map((option) => option.shape.kind.value);
assertExactlyOnce(
  "realization intent realizers",
  intentKinds,
  Object.keys(REALIZATION_INTENT_REALIZER_BY_KIND),
);
console.log(
  `Public unions are exhaustive (${CATALOG_ENTRY_KINDS.length} entry validators, ${intentKinds.length} intent realizers).`,
);

function assertExactlyOnce(label, expected, actual) {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)
  )
    throw new Error(
      `${label} differ: expected ${expectedSorted.join(", ")}; observed ${actualSorted.join(", ")}`,
    );
}
