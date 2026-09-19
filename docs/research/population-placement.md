# Deterministic Population Placement

The catalog-first-use creator gate exposed a generic population failure: the tree cluster
requested six instances with a minimum of four, but the compiler emitted only two. Catalog
resolution, source measurement, Roblox publication, and engine lowering were all correct. The
population realizer generated exactly six candidate centers, discarded four after conservative
measured-footprint and separation checks, and had no candidates left to backfill them.

## Proven baseline

Poisson-disk systems do not equate the requested output count with the number of candidates tried.
Bridson's algorithm keeps an active sample set and tries a bounded number of candidates around a
sample (typically 30), accepting valid points until the requested distribution is filled or the
active set is exhausted. SciPy's maintained `qmc.PoissonDisk` follows that iterative pattern and
stops when the requested sample count is reached or its candidate pool is exhausted. Unreal
Engine's production PCG tooling likewise treats point production and bounds- or collision-based
self-pruning as separate operations.

Basalt does not need to reproduce SciPy or Unreal's complete sampling stack. Its existing
content-hash-seeded candidate sequence, measured 3D occupancy reservations, region checks,
terrain sampling, and priority order are already the Basalt-specific authority. The missing
commodity behavior was bounded replenishment after a candidate is pruned.

## Implemented rule

`cluster` and `surface_scatter` now expose deterministic candidate streams instead of arrays whose
length equals the target instance count. The realizer consumes candidates until it reaches the
authored target or exhausts an explicit attempt bound: at least 4,096 candidates, 64 per target,
and never more than 10,000,000. Candidates remain content-hash seeded and are checked against the
same region, transformed measured bounds, collision evidence, surface, vertical stratum, and
minimum separation rules. No minimum is weakened and no overlap is accepted to make a fixture
pass. Failed underfill now reports candidate, region-rejection, and occupancy-conflict counts.

The retained outdoor pilot is the regression case. Its formerly failing large-tree cluster now
reaches all six targets; the complete pilot reaches 25 instances and an eligible world while
preserving unrelated-placement stability under the prop requirement change.

This rule establishes bounded replenishment, not a Poisson-disk distribution or convincing
vegetation composition. The current implementation independently samples hash-seeded coordinates
and yaw and optionally filters them through a smooth relative density field. The
[vegetation distribution assessment](vegetation-distribution.md) records the remaining
layering, activity-space and conservative tree-occupancy limitations.

## Sources

- Robert Bridson, [Fast Poisson Disk Sampling in Arbitrary Dimensions](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf), SIGGRAPH 2007. Bounded iterative candidate generation and the typical `k = 30` baseline.
- SciPy, [`scipy.stats.qmc.PoissonDisk`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.qmc.PoissonDisk.html), maintained open-source implementation documentation. Candidate-pool iteration, configurable candidates per iteration, and requested-count/exhaustion stopping behavior.
- Epic Games, [Procedural Content Generation Framework Node Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-framework-node-reference-in-unreal-engine), current production-engine documentation. Point bounds, mesh-derived bounds, intersection tests, and self-pruning.
