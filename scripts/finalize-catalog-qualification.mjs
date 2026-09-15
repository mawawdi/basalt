import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA,
  sealCatalogQualificationAdjudicationDecision,
  sealCreatorReviewedCatalogQualificationFixture,
} from "../packages/catalog-authoring/dist/index.js";

const root = resolve(".");
const options = parseOptions(process.argv.slice(2));
const decisionInput = options.get("--decision");
if (!decisionInput)
  throw new Error(
    "Qualification finalization requires --decision with the completed creator decision draft",
  );
const proposalPath = options.get("--proposal") ?? "registry/catalog-qualification.json";
const reviewPacketPath =
  options.get("--review-packet") ??
  "registry/qualifications/catalog-adjudication-review-packet.json";
const finalFixturePath = options.get("--output") ?? "registry/catalog-qualification.json";
const retainedProposalPath =
  options.get("--output-proposal") ?? "registry/qualifications/catalog-qualification-proposal.json";
const decisionOutputPath =
  options.get("--output-decision") ?? "registry/qualifications/catalog-adjudication-decision.json";

const proposal = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(await readJson(proposalPath));
if (proposal.adjudication.status !== "pending_creator_review")
  throw new Error("The input qualification fixture is not the pending proposal");
const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(
  await readJson(reviewPacketPath),
);
const rawDecision = await readJson(decisionInput);
const decisionMaterial = { ...rawDecision };
delete decisionMaterial.kind;
delete decisionMaterial.hash;
const decision = sealCatalogQualificationAdjudicationDecision(decisionMaterial);
const finalized = sealCreatorReviewedCatalogQualificationFixture({
  proposal,
  reviewPacket,
  decision,
});

await writeJson(retainedProposalPath, proposal);
await writeJson(decisionOutputPath, decision);
await writeJson(finalFixturePath, finalized);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "eligible",
      fixture: resolve(root, finalFixturePath),
      fixtureHash: finalized.hash,
      proposal: resolve(root, retainedProposalPath),
      proposalHash: proposal.hash,
      reviewPacket: resolve(root, reviewPacketPath),
      reviewPacketHash: reviewPacket.hash,
      decision: resolve(root, decisionOutputPath),
      decisionArtifactHash: decision.hash,
      reviewer: decision.reviewer,
      reviewed: {
        assetDescriptions: decision.assets.length,
        queries: decision.queries.length,
        queryAssetRelationships: decision.queries.reduce(
          (total, query) => total + query.judgments.length,
          0,
        ),
        validatorVerdicts: decision.validationCases.length,
      },
    },
    null,
    2,
  )}\n`,
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("Qualification finalization options must be --name value pairs");
    result.set(key, value);
  }
  return result;
}
