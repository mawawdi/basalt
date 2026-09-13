# Semantic Kernel Rationale and Governance

> **Status:** Non-authoritative rationale. The tracked registry and
> [Architecture](../ARCHITECTURE.md#semantics) define the current implementation.

This document records why Basalt’s implemented semantic kernel has its current
shape and how it may be extended without invalidating unrelated worlds.

## Decision

Basalt uses a frozen kernel with seven upper sorts: `object`, `aggregate`,
`substance`, `space`, `boundary`, `phenomenon`, and `information_content`.
Denotation is only one axis. Affordance, state, surface treatment, contextual
role, relation, and realization form are separately hashed definitions.

This separation prevents common category errors: a room is a space rather than
a structural object; a wall face is a boundary rather than the wall element; a
broken stair remains a stair while its state and traversability change; and a
corner piece is a component playing a topology role rather than a new noun.

The kernel and all 146 initial concept commitments are tracked under
`registry/semantics/`. Those sealed files are the authority. This document is
rationale, not a second registry.

## Stable commitments, additive vocabulary

A commitment contains an opaque concept ID, one upper sort, a normative
definition, necessary and excluded identity criteria, exact direct-parent
references, and materialized ancestor references. Labels, examples, aliases,
translations, mappings, filenames, and search terms are excluded.
Original asset basenames may still inform non-authoritative hypotheses as described
in [Visuals](../VISUALS.md); they never become commitment fields or admitted
semantic evidence.

After admission, a commitment is immutable. A future asset pack may reuse an
existing commitment, propose a genuinely new leaf for explicit review, or remain
`incomplete` while its meaning is unresolved. It may not rewrite an existing
definition or parent relationship. Artifacts bind their minimal
`SemanticDependencyClosure`, so adding an unrelated sibling leaves their hashes
unchanged.

## Authority boundary

The lexicon and visual models may produce `hypothesis` assertion bundles with
confidence or abstention. Only `admitted` bundles can satisfy compiler
requirements. Admitted assertions contain exact evidence and provenance hashes;
they cannot contain model confidence, path hints, or human-readable labels.

Runtime reasoning is intentionally bounded to materialized ancestry,
exact/descendant matching, set inclusion, state equality, evidence ordering, and
explicit symmetric/inverse relations. There is no fuzzy search or hidden
inference below the sealing boundary.

## Substitutability is not taxonomy

Two assets denoting the same noun are not necessarily interchangeable. A
`substitution_set` is the stronger, catalog-level promise that every member can
independently satisfy the complete semantic, state, affordance, realization,
placement, interface, evidence, metric, rights, and style signature. Composition
belongs in assembly kits, route kits, attachment sets, and environment realizers.

## Governance checks

Semantic sealing rejects unknown or cross-sort parents, cycles, stale materialized
ancestry, duplicate IDs, conflicting states, invalid relation domains/ranges,
out-of-scheme roles, ambiguous aliases, and hypothesis data presented as authority.
Changes require tests showing deterministic sealing and closure-local invalidation.

## Research lineage

The design follows a recurring pattern across ontology and 3D-data systems:
stable identity is separated from roles and states; lexical labels are separated
from concepts; spaces and boundaries are modeled explicitly; and exact object
models carry physical evidence beyond noun categories. Useful references include
[BFO](https://basic-formal-ontology.org/),
[SKOS](https://www.w3.org/TR/skos-reference/),
[OWL 2 profiles](https://www.w3.org/TR/owl2-profiles/),
[SHACL](https://www.w3.org/TR/shacl/),
[CityGML](https://www.ogc.org/standard/citygml/),
[ShapeNet](https://shapenet.org/), and
[PartNet](https://partnet.cs.stanford.edu/).
