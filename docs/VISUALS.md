# Visual system

Basalt treats visual quality as hierarchical art direction plus measurable realization,
not as a bag of asset labels.

## Hierarchy

- **World:** palette, climate, atmosphere, silhouette language, density, and global
  landmarks.
- **Region:** biome or district identity, terrain profile, route rhythm, focal hierarchy,
  and transitions to neighbors.
- **Meso:** lots, structures, vegetation clusters, shoreline bands, room programs, and
  repeated motifs.
- **Micro:** individual props, attachments, trim, clutter, decals, material variation,
  and local effects.

Each level seals its constraints and references its parent direction. A beautiful region
that contradicts the world palette is not coherent; a good asset cannot repair a broken
composition.

## Sealed world presentation

`WorldVisualEnvironment` carries engine-neutral presentation intent with the spatial plan
and compiled world. It binds sun time and latitude, direct and ambient balance, shadow
softness, atmosphere, color grading, and restrained sun rays. These settings control value
separation, warm/cool relationships, and depth without changing asset materials or claiming
semantic authority. Each profile is content-addressed, so a presentation change changes the
world build instead of becoming an unrecorded Studio adjustment.

The Roblox connector applies the profile only at the reversible commit boundary. It replaces
the prior atmosphere, color-correction, and sun-ray stack with three explicitly named effects,
reads their values back, and restores the complete prior Lighting state if the import does not
commit. Unrelated effect classes remain creator-owned and untouched. Mesh colors and material
expectations remain governed by their catalog bindings; global grading cannot be used to
disguise a defective asset texture.

The Harvest Valley composition uses detailed catalog building exteriors and an authored rural
palette, with terrain terraces beneath their complete footprints. Explicit entry selection and
single-instance yaw preserve intended silhouettes and facade orientation. Previously admitted
pine and willow models with visibly incorrect leaf texture projection are excluded from this
composition; an admission record alone does not establish attractive appearance.

Ground-supported catalog placements align the measured lower bound to the resolved surface;
the source pivot is not assumed to lie at the feet. The fixture protects full building and
fence footprints with final terrain pads after broad terrain shaping. Fence runs derive their
spacing from measured envelopes, account for asymmetric pivots, and retain an explicit rear
opening for the orchard path. These authored runs establish visible placement, not reusable
socket or modular-kit compatibility.

Planting follows the established pattern of authored density regions, individual orientation
and geometry-aware separation used by [Houdini Scatter and Align](https://www.sidefx.com/docs/houdini/nodes/sop/scatteralign.html).
The Harvest Valley fixture uses shared vegetation communities to declare irregular woods
with mature canopy anchors, smaller birch and pine stands, canopy-conditioned understory,
and sparse meadow verges. Separate intents retain flower beds beside buildings, fenced crops,
orchard rows, farmyard prop groups, and empty pasture. The compiler owns seeded candidate
placement and measured collision. Ground scatter, clusters and grids also exclude complete
rotated bounds from grounded routes' clearance masks; this is separate from object-to-object
occupancy. Authored singles still require explicit composition review. Total instance count
is not a visual-quality gate; the mesh preview exposes the resulting composition for inspection.

Population intents optionally bind a shared smooth density field and boundary fade. This
modulates candidate probability. The ordinary scatter path replenishes toward a target and,
without measured collision or packing evidence, reserves full visual boxes. The retained
composition trials show that these controls alone do not establish a natural forest edge
or usable clearing.

The explicit vegetation path coordinates canopy, understory and ground-cover layers. Plant
palettes share spatial fields; shrubs and ferns can prefer accepted canopy, while flowers can
prefer open ground. These are authored community preferences, not ecological facts inferred
from captions. Crown influence is a geometric field, not a sunlight simulation. Finite trials
and variable spacing produce clumps and gaps without quota replenishment. Grounded routes
reserve an authored clearance height; clearings reserve full 3D activity volumes. Canopies
can overhang these volumes only when the measured occupied geometry stays clear.

Source-derived height bands retain trunks and low branches while permitting plants in empty
space beneath crowns. They do not shrink geometry based on a model's interpretation, change
source meshes or redefine engine physics. A rotated bottom-envelope terrain probe rejects
excessive support relief and allows a small authored embed rather than suspending wide roots
from a center-only height sample. This sampled check does not certify every root contact.
Refinement uses retained measured reservations.
Terrain `paint` operations apply authored polygon material masks without moving the ground.
Later paint wins on overlap; resolved route materials retain precedence. These discrete masks
are sampled into the same sealed base field and passed through engine lowering, not preview
decoration. Harvest Valley uses leafy woodland ground and soil beneath selected groves and
crops. Native material relief remains an engine concern: Roblox's
[terrain materials](https://create.roblox.com/docs/parts/terrain) affect appearance and shape,
so a WebGL color patch does not establish the final contact or texture quality.
The [vegetation assessment](research/vegetation-distribution.md) records the production and
research baselines behind this bounded implementation. It does not establish generalized
visual quality, automatic biome inference or streaming consistency. The comparison protocol
and retained observations are documented in `EVALS.md`.

The bounded Three.js preview renders exact GLBs, compiled placements, route surfaces and sampled
final terrain. It supports orbiting and reproducible camera captures. Approximate preview terrain
shading and lighting are visual aids; creator-run Roblox appearance and traversal remain separate
evidence. The fixed Studio asset-capture action observes unparented published models and returns
exact material paths and texture IDs without modifying the place or inventing a visual verdict.

## Asset evidence

Every source identity is measured independently of its semantic admission. Measurement
records source bytes and rights, axes and units, Q32.32 metric bounds, geometry and parts,
materials and PBR evidence, support/contact evidence, collision companions, and measured
interfaces. Collision companions are evidence, never catalog entries.

Bottom support distinguishes `planar_patch_fit` from `lower_extrema`. The former carries a
positive fitted planar contact area. The latter proves only that static Y-up geometry can be
aligned to a horizontal plane at its measured lower extent and therefore carries exactly zero
planar area. It is not evidence of stability or intended installation. Animated and skinned
support stays unknown because its lower extent is pose-dependent. An authored placement and
creator admission remain separate authority.

Canonical review evidence contains twelve deterministic views:

- eight azimuths at 25 degrees elevation;
- four offset azimuths at 55 degrees elevation;
- RGB, silhouette/alpha, normalized depth, and surface-normal channels;
- exact camera, renderer, lighting, material-mode, and source hashes;
- one deterministic contact sheet.

Embedded and external glTF textures must resolve before evidence is accepted. A renderer
that substitutes black placeholders makes the visual gate incomplete rather than
misclassifying the asset.

## Open-vocabulary metadata

The optional bulk metadata adapter receives a measured decimal summary plus either four cardinal RGB
views or the canonical twelve, resized by a hashed preprocessor to a maximum 384-pixel
long edge. Twelve is the safe default until production qualification demonstrates that
four is non-inferior. Qualification compares:

- `visual_only`, which cannot expose any source name; and
- `visual_and_name`, which may receive original basenames marked as weak hints.

Pack, archive, and directory identities are never model or ranking inputs. The compact
receipt contains a caption, primary and alternate nouns, materials, colors, style terms,
visible text, plausible uses and environments, visual composition, a source-role
hypothesis, completeness relative to intended use, visible damage, and issue notes.
Completeness and damage are independent: a purposeful ruin component may be both
intentionally partial and visibly damaged. Scale, axes, dimensions, support/contact, part
counts, and triangles come from the bound measurement summary and are not guessed by the
model. Every uncertain field explicitly abstains. Confidence scores and magic unknown
labels are forbidden.

The current writer and validator are independently selected roles. Qwen3-VL 8B is the
default for both; Qwen3-VL 32B remains a challenger until production qualification shows
a material role-specific gain. Receipts bind the source,
measurement, render, prompt, schema, preprocessor, adapter, worker, model commit, raw
output, and resource use. They have `compilerAuthority: false`.

A useful starting catalog does not wait for bulk-worker qualification. Bounded agent-authored
metadata batches bind the same measurement and render evidence while recording the actual producer,
certainty, reviewer, review coverage, and exact decision artifact. Unreviewed concrete hypotheses
may improve search, but remain visibly unreviewed; uncertain items and audit samples can be reviewed
without pretending the whole batch received creator authority. Agent-authored records have no
compiler authority and cannot authorize qualification or admission. Worker receipts and authored
records are distinct evidence kinds and cannot silently replace one another for the same source.

Qualification answer keys are a separate authority surface. Filename-derived nouns, confusers,
query expectations, relevance judgments, and validator verdicts remain proposals until a creator
or explicitly identified delegated reviewer independently reviews their bound visual pages. A
delegated-AI decision remains development evidence and must never masquerade as personal creator or
human holdout review. The finalized key is derived from the complete bound decision; a status label
or provenance hash by itself cannot promote proposed labels.

Platform upload adaptation is also separate from visual authority. Catalog source GLBs remain
immutable; the Roblox boundary may derive an exact retained payload for importer compatibility.
Its current rule preserves the primary glTF material color set (`COLOR_0`) and removes secondary
color sets (`COLOR_1+`) that Roblox can expose as appearance even when source tooling used them as
control data. A publication receipt records that derivation, while creator inspection still decides
whether the imported materials are acceptable.

## Hybrid search

Every measured asset with an original basename can enter the index before learned
enrichment is complete. Search applies hard rights, size, triangle, and byte filters before
ranking. It then:

1. runs independent field-weighted BM25 channels over weak basename tokens and available
   metadata;
2. ranks query text against aggregate SigLIP2 image embeddings when present;
3. fuses the top 200 from available channels with reciprocal-rank fusion at `k = 60`,
   normalized by each document's available channels;
4. breaks ties by source-content hash; and
5. optionally asks the selected VLM to validate at most eight candidates against the
   exact requirement and all twelve views.

Reference-asset queries use DINOv3 shape embeddings instead of SigLIP text/image vectors.
They return `incomplete` if DINO evidence is absent; DINO is not required for text search.
Per-view vectors are optional diagnostics; canonical aggregate matrices are little-endian
quantized `int16` blobs in the local CAS. Metadata style matches affect rank but do not
silently exclude an asset. Validator results annotate the base rank as `match`,
`uncertain`, or `mismatch`; evidence is never discarded.

Nearest-neighbor retrieval never decides that an asset is suitable. A separately hashed,
frozen decision policy considers the bounded validated candidates and returns
`suitable_match`, `evidence_insufficient`, or `no_suitable_match`. An uncertain candidate
prevents a conclusive no-match claim.

Search remains authoring evidence. It cannot create a concept, admitted assertion,
catalog entry, or substitution set. Hidden affordances, sockets, collision behavior, and
assembly semantics stay incomplete without measured or engine evidence.

## Assembly context

Per-asset renders often cannot reveal whether a mesh is a whole object, one module, a
collision companion, or a piece intended to mate with another. Context requests therefore
group 2–32 assets from auditable basename stems, metric/interface compatibility, and bounded
retrieval. Pack and directory identity never supply meaning.

A request may include attributed source prefabs or demonstrated assemblies, exact
component transforms and parent/child relationships, authored role declarations, and
supporting documentation. Every source and claim binds an identity and evidence hash.
Observed context claims without evidence are invalid. The interpreter may propose
whole/component relationships, roles, mates, aggregates, collision companions, or visual
alternatives, but it must abstain when isolated or contextual evidence is insufficient.
A deterministic construction-eligibility assessment turns this into a review queue; it
does not admit an assertion or entry.

## Catalog realization

Style profiles are orthogonal to semantic identity and placement. Resolution first checks
exact or descendant semantic compatibility, entry kind, realization form, state,
treatment, affordances, placement, interfaces, rights, resources, and metric bounds.
Only survivors are ranked deterministically.

A substitution set is valid only when every member independently satisfies the complete
site signature. Member weights are canonical integers and participate in content-hash
seeded selection. Components that require assembly, a host surface, or a route topology
belong to their typed entry instead.

Shared full-3D occupancy uses transformed bounds, collision evidence, surfaces, and
vertical strata. Unknown surfaces, regions, routes, normals, interfaces, or endpoints are
rejected instead of coerced. Required underfill is incomplete and visible in diagnostics.

Route appearance is independent of route construction. A woodland trail, paved road, and
boardwalk may share a destination while using different materials, colors, terrain
treatments, and support behavior. Every grounded route emits a material mask and
vegetation-clearance mask from its resolved footprint. Ground population consumes grounded
route masks. Elevated routes emit a mask, preserve terrain and must explicitly choose no edge protection or sealed guardrails
with posts and rails. Radius-constrained bends and authored junctions are composition
evidence, not catalog assets. Smooth ordinary bends use deterministic five-degree-or-finer
sampling and mitered native spans. Designed elevation profiles use one-degree-or-finer pitch
sampling and full-depth profile miters, so a changing grade does not expose each native
span's end face. Terrain-following routes retain real relief, and visible tread boundaries
remain intentional only for explicit stepped construction. The deterministic grounding gate
establishes geometry, not visual harmony; player-view route readability remains a separate
visual observation.

At the Roblox boundary, the visible route top must clear reconstructed smooth terrain while
the route body's underside determines whether a void is exposed. Small voxel-only residuals
are covered by deterministic grounding geometry in the same appearance; they are not hidden
by widening a tolerance. Both the residual and the added depth remain available in the import
diagnostic report for visual review. Any bounded vertical correction applied to a deck also
moves its rails and posts and extends its supports back to ground, preserving the compiled
assembly rather than correcting only the travel surface.

## Neural asset production

TRELLIS.2, Hunyuan3D 2.1, and Pixel3D remain provider adapters for offline catalog-gap
fulfillment. Generation and retexturing are not part of macro world compilation. Every
result is content-addressed and must pass the same measurement, render, review, rights,
and admission gates as a sourced asset. A generated output cannot automatically define
semantics or overwrite an entry.

## Evidence scalability

Metadata, embedding, and validation work is split into deterministic resumable shards.
Each shard is bounded by all of the following:

- at most eight assets;
- at most 192 evidence files;
- at most 64 MiB of input evidence;
- a fixed preprocessed-pixel ceiling derived from a 384-pixel long edge.

The asset count is a checkpoint ceiling, not a GPU batch size. Actual inference may be
sequential. Remote model execution is optional, has no default provider, and must be selected
explicitly; at most one remote GPU worker and four local CPU tasks are allowed. The
tracked 32-asset fixture is a smoke test only. Corpus execution remains locked until the
larger pooled, leakage-isolated qualification covers mixed enrichment, independent writer
and validator roles, four versus twelve views, confusers, no-match cases, and
evidence-insufficient cases.
