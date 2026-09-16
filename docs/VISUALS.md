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
vegetation-clearance mask from its resolved footprint; an elevated route clears vegetation
but preserves terrain and must explicitly choose no edge protection or sealed guardrails
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
