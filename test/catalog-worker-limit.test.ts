import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LOCAL_CATALOG_WORKERS,
  requireLocalCatalogWorkerCount,
} from "@basalt/catalog-authoring";

test("local catalog concurrency has one hard four-worker ceiling", () => {
  assert.equal(MAX_LOCAL_CATALOG_WORKERS, 4);
  assert.equal(requireLocalCatalogWorkerCount(4), 4);
  assert.throws(() => requireLocalCatalogWorkerCount(5), /1 through 4/u);
  assert.throws(() => requireLocalCatalogWorkerCount(0), /1 through 4/u);
});
