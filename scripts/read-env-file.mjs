import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read one variable from the repo-root .env file. Synchronous: the file is
 * tiny and callers are CLIs. Last non-empty assignment wins. The value is
 * never logged; callers must keep it out of output. Returns undefined when
 * the file is missing or carries no non-empty assignment.
 */
export function readEnvFileKey(repositoryRoot, name) {
  let text;
  try {
    text = readFileSync(resolve(repositoryRoot, ".env"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*("?)([^"\\n]*)\\1\\s*$`);
  let found;
  for (const line of text.split("\n")) {
    const match = pattern.exec(line);
    if (match && match[2].trim()) found = match[2].trim();
  }
  return found;
}
