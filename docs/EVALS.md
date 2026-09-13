# Evaluation and Claim Semantics

This document owns Basalt’s gate statuses, evidence ordering, and the claims made
by automated or creator-run evaluation. Test presence never upgrades an
unqualified subsystem into production authority.

Every local gate returns exactly one status:

- `eligible`: every required claim has sufficient evidence.
- `incomplete`: the request is valid but a decision, asset, resource, or solver
  solution is missing.
- `rejected`: the input or evidence violates a schema, semantic contract, or
  policy.

Optional gaps remain diagnostics. Required gaps make the enclosing stage
incomplete. No fallback upgrades either failure state.

## Evidence order

`declared < measured < simulated < engine_verified`

Schema evidence proves canonical shape and hashes. Measurement evidence proves
physical and material facts. Solver evidence proves propagation, decisions,
contradictions, backtracks, occupancy, coverage, and resource bounds. Adapter
evidence proves deterministic lowering. Only creator-run readback proves observed
engine state.

Hypothesis bundles can contain confidence and abstention but cannot satisfy an
authoritative requirement. Admitted bundles contain exact evidence and provenance
hashes and forbid model confidence and source-path hints.

## Automated suites

- Semantic registry: 146 commitments, all facets, identity criteria, ancestry,
  cross-sort rules, cycles, relations, roles, states, lexicon isolation, and local
  closure invalidation.
- Catalog: source accounting, substitution invariants, exact evidence,
  composition, deterministic filtering/ranking/weights, rights, resources, and
  typed gaps.
- Current admission prototype: independent implementation identity,
  exact-signature consensus, confidence isolation, complete-link visual coherence,
  input-order independence, medoid/outlier/boundary/audit sampling, finite-cohort
  decisions, failed-audit blocking, and deterministic tracked commits.
- Spatial: immutable plans, route-first foundations, meter contracts, complete
  footprint clearance, occupancy, qualified sockets, and explicit underfill.
- Constraints: directed/symmetric edges, AC-3 propagation, weighted entropy,
  deterministic backtracking, unsatisfiable evidence, and bounded termination.
- Artifacts: predecessor hashes, deterministic recompilation, and local semantic
  dependency closures.
- Roblox: 0.28-meter transform conversion, 1.12-meter terrain voxels,
  authentication, bounded local service behavior, exact observed-state hashes,
  sequential import, cancellation, rollback, and plugin parsing.

## Visual gates

The production gates are a lake/forest region, a multi-floor modular city block
with attachments, and a mixed multi-region world with route transitions and
environment realization. Each must compile twice to identical hashes. Final play,
visual judgment, and readback are performed by the user in Roblox Studio.

These suites prove contract behavior and deterministic execution. They do not yet
prove semantic accuracy across unseen packs, substitution false-merge risk,
perceptual quality, playability, or remote recoverability. The missing admission
qualification is tracked in the
[catalog admission cutover](ROADMAP.md#catalog-admission-cutover).
