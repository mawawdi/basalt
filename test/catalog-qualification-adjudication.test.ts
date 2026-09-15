import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA,
  requireCreatorReviewedQualificationFixture,
  sealCatalogQualificationAdjudicationDecision,
  sealCatalogQualificationFixture,
  sealCreatorReviewedCatalogQualificationFixture,
} from "@basalt/catalog-authoring";

test("qualification execution requires the exact complete creator answer-key decision", async () => {
  const proposal = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    JSON.parse(await readFile("registry/catalog-qualification.json", "utf8")),
  );
  const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(
    JSON.parse(
      await readFile("registry/qualifications/catalog-adjudication-review-packet.json", "utf8"),
    ),
  );
  assert.equal(proposal.adjudication.status, "pending_creator_review");
  assert.equal(
    reviewPacket.queries.reduce((total, query) => total + query.proposedJudgments.length, 0),
    625,
  );
  assert.equal(reviewPacket.validationCases.length, 144);

  const decision = sealCatalogQualificationAdjudicationDecision({
    proposalFixtureHash: proposal.hash,
    reviewPacketHash: reviewPacket.hash,
    reviewer: { authority: "creator", reviewerId: "synthetic-test-creator" },
    reviewMethod: "independent_visual_review",
    reviewerStatement:
      "Synthetic test authority confirms every enumerated answer-key surface for contract testing only.",
    reviewedAt: "2026-09-15T00:00:00.000Z",
    coverage: {
      assetDescriptions: "complete",
      queryAssetRelevance: "complete",
      validatorVerdicts: "complete",
    },
    assets: reviewPacket.assets.map((asset) => ({
      sourceContentHash: asset.sourceContentHash,
      reviewAction: "confirmed",
      evidenceExpectation: asset.proposedEvidenceExpectation,
      stratum: asset.proposedStratum,
      adjudicatedNouns: asset.proposedNouns,
    })),
    queries: reviewPacket.queries.map((query) => ({
      queryId: query.queryId,
      expectationReviewAction: "confirmed",
      expectation: query.proposedExpectation,
      judgments: query.proposedJudgments.map((judgment) => ({
        ...judgment,
        reviewAction: "confirmed",
      })),
    })),
    validationCases: reviewPacket.validationCases.map((validationCase) => ({
      caseId: validationCase.caseId,
      reviewAction: "confirmed",
      expectedVerdict: validationCase.proposedVerdict,
    })),
  });
  const fixture = sealCreatorReviewedCatalogQualificationFixture({
    proposal,
    reviewPacket,
    decision,
  });
  assert.doesNotThrow(() =>
    requireCreatorReviewedQualificationFixture({ fixture, proposal, reviewPacket, decision }),
  );
  if (fixture.adjudication.status !== "creator_reviewed")
    throw new Error("Synthetic finalized fixture did not enter creator-reviewed state");

  const { kind: _fixtureKind, hash: _fixtureHash, ...fixtureMaterial } = fixture;
  const statusOnlyMutation = sealCatalogQualificationFixture({
    ...fixtureMaterial,
    adjudication: {
      ...fixture.adjudication,
      decisionArtifactHash: "f".repeat(64),
    },
  });
  assert.throws(
    () =>
      requireCreatorReviewedQualificationFixture({
        fixture: statusOnlyMutation,
        proposal,
        reviewPacket,
        decision,
      }),
    /does not bind the exact creator review artifacts/iu,
    "editing status or provenance fields cannot substitute for the decision artifact",
  );

  const firstQuery = decision.queries[0]!;
  const firstJudgment = firstQuery.judgments[0]!;
  const changedRelevance = firstJudgment.relevance === "irrelevant" ? "uncertain" : "irrelevant";
  const { kind: _kind, hash: _hash, ...decisionMaterial } = decision;
  const mismatchedDecision = sealCatalogQualificationAdjudicationDecision({
    ...decisionMaterial,
    queries: decision.queries.map((query) =>
      query.queryId === firstQuery.queryId
        ? {
            ...query,
            judgments: query.judgments.map((judgment) =>
              judgment.sourceContentHash === firstJudgment.sourceContentHash
                ? { ...judgment, relevance: changedRelevance, reviewAction: "revised" }
                : judgment,
            ),
          }
        : query,
    ),
  });
  assert.throws(
    () =>
      requireCreatorReviewedQualificationFixture({
        fixture,
        proposal,
        reviewPacket,
        decision: mismatchedDecision,
      }),
    /does not bind the exact creator review artifacts|does not match creator decision/iu,
  );
  assert.throws(
    () =>
      CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse({
        ...decision,
        reviewerStatement: `${decision.reviewerStatement} tampered`,
      }),
    /artifact hash mismatch/iu,
  );
  assert.throws(
    () =>
      CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse({
        ...decision,
        assets: decision.assets.slice(1),
      }),
    /artifact hash mismatch/iu,
  );
});
