import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { ASSET_FINISHER_PROFILE, PREPARED_ASSET_TARGET_PROFILE } from "./contracts.js";

const FINISHER_MODULES = [
  ["prepared-asset/contracts", resolve(import.meta.dirname, "contracts.js")],
  ["prepared-asset/finish", resolve(import.meta.dirname, "finish.js")],
  ["prepared-asset/verify", resolve(import.meta.dirname, "verify.js")],
  ["asset-inspection/glb", resolve(import.meta.dirname, "../../asset-inspection/src/glb.js")],
] as const;

const FINISHER_QUALIFICATION = Object.freeze({
  kind: "PreparedAssetFinisherQualification",
  profile: ASSET_FINISHER_PROFILE,
  targetProfile: PREPARED_ASSET_TARGET_PROFILE,
  candidatePolicy: "one-sealed-intent-one-canonical-adapted-candidate",
  sizePolicy: "measured-world-bounds-0.67-to-1.0-no-rescale",
  geometryPolicy:
    "identity-node-canonical-axes-single-root-support-origin-support-contact-collision-and-detached-glb-inspection",
  surfacePolicy: "all-render-primitives-material-normal-uv-and-intent-required-textures",
  rightsPolicy: "commercial-or-creator-owned-retained-evidence",
  previewPolicy: "three-distinct-retained-png-views",
  replayPolicy: "reconstruct-and-compare-canonical-manifest",
});

export interface PreparedAssetFinisherIdentity {
  readonly finisherWorkerHash: string;
  readonly finisherQualificationHash: string;
}

/** Bind live resolution to the exact compiled finisher and its declared admission policy. */
export async function currentPreparedAssetFinisherIdentity(): Promise<PreparedAssetFinisherIdentity> {
  const hash = createHash("sha256");
  for (const [label, path] of FINISHER_MODULES) {
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await descriptor.stat();
      if (!before.isFile() || before.size < 1 || before.size > 2 * 1024 * 1024)
        throw new Error(`Prepared-asset finisher module is not a bounded regular file: ${label}`);
      const bytes = await descriptor.readFile();
      const after = await descriptor.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new Error(`Prepared-asset finisher module changed while reading: ${label}`);
      hash.update(label);
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    } finally {
      await descriptor.close();
    }
  }
  return {
    finisherWorkerHash: hash.digest("hex"),
    finisherQualificationHash: contentHash(stableJson(FINISHER_QUALIFICATION)),
  };
}
