# Visual and Catalog Evidence

This document owns Basalt’s visual, physical-evidence, catalog-entry, and
admission policies. The implemented dataflow lives in
[Architecture](ARCHITECTURE.md); unfinished qualification work lives in the
[Roadmap](ROADMAP.md).

Visual compilation keeps denotation, realization form, state, affordance,
treatment, contextual role, placement, interfaces, style, and evidence level
orthogonal. Neither a noun nor an embedding is a placement contract.

## Entry kinds

- `substitution_set`: independently interchangeable realizations of one complete
  semantic and placement signature.
- `assembly_kit`: leaf providers plus authored roles, interfaces, lattice,
  transitions, terminal rules, topology, and coverage.
- `attachment_set`: members that require a host surface or typed socket.
- `route_kit`: network components and admitted topology transitions.
- `environment_realizer`: typed sky, atmosphere, water-surface, overhead, or
  far-field realization.
- `collection`: authoring organization that runtime resolution cannot return.

Multi-object dumps, broken objects, animation-only payloads, ambiguous components,
and unbound collision geometry remain incomplete until their exact identity and
use are adjudicated. A collision companion is evidence attached to a renderable
asset, never a standalone entry.

## Evidence channels

Measurement is independent of semantic admission. Each source identity retains
source and rights hashes, coordinate frame, units, transforms, bounds, parts,
topology, deformation/rest-pose state, material/PBR channels, contact/support
facts, collision geometry, and measured interfaces. Measurement proves geometry;
an author declares interface meaning. Pose-dependent support and interfaces are
refused rather than inferred from a skinned rest pose.

Evidence remains separated by what it can prove:

| Channel      | Purpose                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Integrity    | Parse closure, empty or degenerate geometry, components, animation, skinning, and external resources      |
| Geometry     | Point or mesh samples, normals, topology, connected components, oriented bounds, and metric compatibility |
| Appearance   | Canonical multiview RGB and appearance features                                                           |
| Material     | Unlit base color, UV coverage, texture/PBR channels, transparency, and material count                     |
| Shape        | Silhouette, normalized depth, normals, and shape features independent of texture                          |
| Installation | Contact surfaces, support direction, sockets, collision companions, and host requirements                 |
| Semantics    | Hypotheses grounded in exact evidence and the pinned semantic module and lexicon                          |

Renderer, camera, lighting, material mode, source, and implementation hashes bind
render receipts, together with an explicit channel-encoding hash. Existing evidence
is reusable only when every relevant input hash matches. The canonical 12-view
outputs bind lit RGBA, alpha silhouette, linear normalized depth, world-space
encoded surface normals, and linear unlit base color. Contact sheets are derived
review UI and changing their layout does not invalidate those views.
Origin archives, vendor folders, and directory paths are absent from inference and
review contracts. Original GLB basenames are the one deliberate exception:
`catalog hypothesize` aggregates every name observed for the same content bytes,
normalizes it with a hashed deterministic tokenizer, and binds the resulting
`CatalogSourceNameHint` into each model request. The artifact is explicitly
non-authoritative and pack-neutral. It may improve candidate generation for nouns,
components, numbered alternatives, and `_Collision` companions, but it cannot
decide semantics, placement, entry kind, or substitution membership. Conflicting
names are retained as disagreement evidence; image and measurement evidence remain
independent channels.

## Admission policy

A substitution set is a relation stronger than shared classification or visual
similarity. Every member must independently satisfy the complete denotation,
realization, state, affordance, treatment, placement, interface, evidence, metric,
rights, and style signature. The set exposes only capability intersections and
measured envelopes. False splits reduce variety; false merges can silently break a
world, so admission prefers abstention and smaller sets.

Model and embedding adapters emit non-authoritative receipts with confidence,
abstention, provenance, and resource use. Compiler authority requires an explicit
curator assertion or a separately qualified policy receipt. Qualification must be
based on leakage-group-disjoint calibration and evaluation, factorized facet
predictions, explicit unknown/shift behavior, pairwise substitution evidence, a
whole-set invariant check, active discovery review, and a distinct random
acceptance audit whose risk is declared. Exact and near-duplicate geometry and
contained components must remain in one split. Shared material payloads are
contextual stratification evidence rather than identity proof because one atlas
can serve many unrelated objects. Source-pack membership is neither a feature nor
a grouping rule. Model
self-confidence and raw majority vote cannot become authority.

The implemented leakage pre-pass uses canonical metric geometry for exact matches,
records exact texture bytes as material context, and uses a source-neutral
perceptual signature over silhouette, normalized depth, and surface-normal views
for near duplicates.
It compares every rendered source pair at the sealed threshold and binds the image
decoder and worker bytes. This is a split-safety signal, not semantic evidence and
not proof of substitutability.

The current code has a conservative prototype: distinct implementation hashes vote
on exact signatures, one quantized visual channel forms complete-link cohorts, and
deterministic medoid/outlier/boundary/audit samples lead to a finite-cohort curator
decision. This machinery preserves abstention and provenance, but it is not yet
qualified for unattended full-corpus admission. The exact replacement work is the
[catalog admission cutover](ROADMAP.md#catalog-admission-cutover), grounded in the
[admission research](research/catalog-admission-state-of-the-art.md).

## Neural fulfillment

Neural 3D output follows the same evidence spine as imported assets. A generation
receipt is only source evidence: raw provider coordinates may be normalized and
unscaled, and the receipt records that fact. `asset-production` owns orientation
baking, scale establishment, geometry repair, UVs, PBR baking, and previews;
`asset-inspection` measures the finished GLB. A provider response cannot admit
itself.

Style mismatch and missing coverage are different operations. Restyling binds the
retained source-geometry hash and changes material evidence. Extending or
synthesizing a substitution set creates independently admissible members with
content-derived seeds. A failed restyle returns evidence to planning rather than
silently becoming whole-object regeneration. Provider names and transports remain
outside catalog and compiler contracts.

## Style and placement

Style profiles are independent of semantics. The neutral profile preserves source
shape, materials, and measured detail without inventing art direction.

Every placement uses one typed intent: single, surface scatter, cluster, along
route, surface grid, socket attachment, wall attachment, route network, assembly,
or environment layer. Intent kinds have exhaustive validator and realizer maps; no
kind degrades into scatter. Occupancy uses full 3D bounds and measured narrow-phase
geometry. Attachments use qualified `{instanceId, socketId}` endpoints.

Basalt makes no visibility claim until a real visibility solver exists. Catalog
storage and recovery are defined only in
[Architecture](ARCHITECTURE.md#storage-and-recovery).
