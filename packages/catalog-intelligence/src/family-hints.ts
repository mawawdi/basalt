import { contentHash } from "../../contracts/src/index.js";
import { entityId } from "../../spatial-core/src/primitives.js";

export interface FamilyHintInput {
  readonly kit: string;
  readonly fileName: string;
  readonly tags: readonly string[];
}

export interface FamilyHint {
  readonly kitId: string;
  readonly familyKey: string;
  readonly familyId: string;
  readonly roleTags: readonly string[];
}

/**
 * Derive a reversible grouping hint from source metadata only. This is never
 * treated as validated semantic truth; geometry measurement and visual review
 * may promote it to an authoritative family later.
 */
export function deriveFamilyHint(input: FamilyHintInput): FamilyHint {
  const kitId = toEntityId(`kit_${slug(input.kit)}`);
  const base = (input.fileName.split(/[\\/]/u).pop() ?? input.fileName).replace(/\.[^.]+$/u, "");
  const tokens = base
    .normalize("NFC")
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.toLocaleLowerCase("en-US"))
    .filter((token) => token.length > 1 && !/^\d+$/u.test(token) && !/^\d+x\d+$/u.test(token));
  const familyTokens = [...new Set(tokens)].slice(0, 4);
  const familyKey = familyTokens.join("/") || "unclassified";
  const familyId = `family_${contentHash(JSON.stringify({ kitId, familyKey })).slice(0, 32)}`;
  return {
    kitId,
    familyKey,
    familyId: entityId.parse(familyId),
    roleTags: [...new Set(input.tags.map((tag) => tag.toLocaleLowerCase("en-US")))].sort(),
  };
}

function slug(value: string): string {
  return (
    value
      .normalize("NFC")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "source"
  );
}

function toEntityId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 64);
  return entityId.parse(/^[A-Za-z]/u.test(normalized) ? normalized : `kit_${normalized}`);
}
