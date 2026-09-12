import test from "node:test";
import assert from "node:assert/strict";
import { resolveAdmissionStatus } from "../packages/catalog-intelligence/src/contracts.js";

test("admission requires manifold geometry and texture evidence", () => {
  assert.equal(
    resolveAdmissionStatus({ isManifold: true, textureEvidence: "embedded" }),
    "locally_qualified",
  );
  assert.equal(
    resolveAdmissionStatus({ isManifold: true, textureEvidence: "external" }),
    "locally_qualified",
  );
  assert.equal(resolveAdmissionStatus({ isManifold: true, textureEvidence: "none" }), "incomplete");
  assert.equal(
    resolveAdmissionStatus({ isManifold: false, textureEvidence: "embedded" }),
    "incomplete",
  );
});
