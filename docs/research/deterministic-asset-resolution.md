# Deterministic Catalog Resolution

Catalog resolution converts a typed `CatalogRequirement` into either one exact
`ResolvedCatalogBinding` or a typed gap. It does not interpret language.

## Inputs

A requirement embeds one `SemanticRequirement`: an exact commitment reference,
`exact` or `descendant` match mode, realization forms, states, treatments,
affordances, minimum evidence levels, and its minimal semantic closure. It also
declares accepted entry kinds, placement and interface constraints, style,
metric bounds, rights, resource ceilings, and whether failure is required or
optional.

Runtime entries are `substitution_set`, `assembly_kit`, `attachment_set`,
`route_kit`, or `environment_realizer`. `collection` is authoring-only and is
never a resolution result.

## Algorithm

Resolution first rejects every candidate that fails any hard constraint, in this
order:

1. entry kind;
2. semantic commitment and realization form;
3. state, treatment, and affordance evidence;
4. placement and interfaces;
5. style and metric bounds;
6. rights and resource budgets.

Survivors are ranked lexicographically by ancestor distance, style preference,
metric slack, triangle cost, source-byte cost, and entry hash. The ordering is
ASCII/code-unit based and independent of input order. A content-derived seed and
canonical integer weights select a member; weights therefore affect results
without introducing mutable randomness.

Every rejected candidate and reason is retained in the binding or gap evidence.
No nearby noun, filename match, or lower-evidence member is substituted.

## Result semantics

- `SemanticGap`: the requirement’s semantic closure is invalid or unavailable.
- `EvidenceGap`: otherwise suitable entries lack the required evidence level.
- `CatalogGap`: no entry satisfies the remaining hard constraints.

An unresolved optional requirement is diagnostic. An unresolved required
requirement makes the resolution stage `incomplete`. Malformed or contradictory
authority makes it `rejected`. Neither status can be converted to success by a
fallback.

## Catalog admission

Measurements remain semantic-free. Admission joins exact asset evidence with
admitted assertions and a declaration. A substitution set seals only if all
members independently prove its complete signature; its capabilities are the
intersection of member capabilities and its measurements form an envelope.
Collision companions are evidence attached to a renderable asset and never
runtime entries.

Natural-language labels, visual hypotheses, model confidence, source names, and
folder structure remain above this boundary in `catalog-authoring`.

For corpus-scale admission, `catalog-authoring` constructs a panel from at least
two independent semantic hypothesis implementations. Exact signatures—not scalar
confidence—vote. Consensus sources are split using separately provenance-bound,
quantized visual embeddings and deterministic complete-link similarity, after hard
partitioning by semantic, metric, material-capability, and support evidence.

Basalt then produces an active review plan containing medoids, visual and metric
outliers, boundary cases, and a content-hash-seeded audit sample. The curator's
decision binds the complete cohort and every reviewed finding. A failed independent
audit blocks materialization. This converts thousands of per-asset inspections into
a bounded set of high-information cohort checks without treating model output as
authority.

The current authority is atomically committed to `registry/catalog.json`. It embeds
the exact sealed snapshot, declarations, assertions, dispositions, policy,
decisions, and audits. Expensive compact authoring evidence is retained by content
hash under `registry/evidence/`, including the exact measurements and render-index
metadata. Heavyweight rendered images remain externally backed and rebuildable.
This commit is a single current root—Git, not Basalt, supplies history.

## Gap fulfillment

A `CatalogGap` may produce a sealed, offline fulfillment plan. Exact coherent
bindings are reused. A pure style-profile rejection may produce material-restyle
jobs bound to the existing source geometry. A substitution set that lacks usable
coverage may receive new member jobs. With no matching substitution set, Basalt
may synthesize a new one only for independently substitutable whole objects.

The planner does not generate semantics. Semantic or evidence gaps stay
`incomplete`, and typed attachments, assemblies, route kits, or environment modes
must be authored before their assets can be generated. Every neural candidate
returns through finishing, measurement, visual review, admitted assertions,
disposition, catalog sealing, and a fresh resolution attempt. Provider output
never mutates or overwrites an admitted entry in place; the stable handle resolves
to a newly sealed content hash after admission.
