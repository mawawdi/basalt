import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesPatchQuarantineSignature,
  resolveAdmissionStatus,
} from "../packages/catalog-intelligence/src/contracts.js";

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

test("patch signature catches single-texel flat family outliers", () => {
  // Measured grass-patch shape: ~one texel, flat, 12x its cohort.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 9.6e-7,
      minSpanStuds: 0.49,
      maxSpanStuds: 17.86,
      familyMedianMaxSpanStuds: 1.49,
    }),
    true,
  );
  // Solid-color boulder: single texel but volumetric.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 0,
      minSpanStuds: 8,
      maxSpanStuds: 10,
      familyMedianMaxSpanStuds: 9,
    }),
    false,
  );
  // Ground tile: flat and single-texel but matches its flat cohort.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 0,
      minSpanStuds: 0.4,
      maxSpanStuds: 12,
      familyMedianMaxSpanStuds: 12,
    }),
    false,
  );
  // Textured flat: wide UV sampling is painted detail, not a patch.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 0.2,
      minSpanStuds: 0.4,
      maxSpanStuds: 18,
      familyMedianMaxSpanStuds: 1.5,
    }),
    false,
  );
  // Signboard: flat and single-texel but only 2.5x its cohort.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 0,
      minSpanStuds: 0.33,
      maxSpanStuds: 15,
      familyMedianMaxSpanStuds: 6,
    }),
    false,
  );
  // Untextured geometry carries no UV evidence and never matches.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: Number.NaN,
      minSpanStuds: 0.4,
      maxSpanStuds: 18,
      familyMedianMaxSpanStuds: 1.5,
    }),
    false,
  );
  // Degenerate spans never match.
  assert.equal(
    matchesPatchQuarantineSignature({
      uvBboxArea: 0,
      minSpanStuds: 0,
      maxSpanStuds: 0,
      familyMedianMaxSpanStuds: 1.5,
    }),
    false,
  );
});
