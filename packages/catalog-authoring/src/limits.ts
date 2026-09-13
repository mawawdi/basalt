/** Local admission work is intentionally capped to protect interactive machines.
 * Distributed execution may shard tasks across hosts later; each host still
 * enforces its own explicit resource policy. */
export const MAX_LOCAL_CATALOG_WORKERS = 4;

export function requireLocalCatalogWorkerCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOCAL_CATALOG_WORKERS)
    throw new Error(
      `Catalog workers must be an integer from 1 through ${MAX_LOCAL_CATALOG_WORKERS}`,
    );
  return value;
}
