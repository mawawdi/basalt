# Catalog support measurement

> **Status:** implementation rationale and corpus audit. Runtime authority remains the
> measurement policy, sealed asset artifacts, and creator-reviewed catalog declarations.

## Failure observed

The original bottom-contact extractor accepted a triangle only when all three of its vertices
fell within a `max(1 µm, height × 10⁻⁵)` slice at the global minimum Y coordinate. That is a
valid way to locate authored planar bases, but it is not a valid prerequisite for bottom
placement. Rounded rocks, horizontal logs, pointed trunks, open rims, and crossed foliage cards
often touch the minimum at points or lines and therefore contain no qualifying triangle.

The failure was systematic. Before the repair, the 3,441-source measurement set contained:

| Result                                    | Sources |
| ----------------------------------------- | ------: |
| Fitted planar bottom patch                |   1,703 |
| Refused with `no_patches`                 |   1,733 |
| Refused because support is pose-dependent |       5 |

Eighteen of the twenty-four creator-reviewed outdoor base cases were in the `no_patches`
group. Removing or replacing them would have hidden a corpus-wide formulation error.

## Reused baseline and Basalt-owned remainder

Trimesh separates contact alignment from the stronger question of stable resting pose. Its
stable-pose implementation evaluates convex-hull faces and center of mass, then translates a
selected pose by the negative lower bound so the geometry is just touching the workspace
plane. Trimesh also exposes mesh-plane section and planar projection operations for callers
that need an outline. These are useful established patterns; requiring an authored triangle
exactly on the global minimum is not.[^1][^2][^3]

Basalt does not import Trimesh or attempt alternate-pose physics here. The source frame is
already measured as right-handed, Y-up evidence, and intended installation belongs to the
creator-reviewed entry declaration. Basalt's remaining job is smaller:

1. retain the existing deterministic planar-patch fit when it succeeds;
2. otherwise bind the canonical Q32.32 lower extrema as evidence that static geometry can be
   aligned to a horizontal plane at its bottom;
3. report zero planar contact area for that fallback instead of estimating or inventing one;
4. keep animated and skinned support refused because the lower extent is pose-dependent; and
5. expose the measurement method to review and model-facing metric summaries so it cannot be
   mistaken for stability or intended placement.

`planar_patch_fit` is therefore a positive-area geometric surface measurement.
`lower_extrema` is only bottom-alignment evidence and always has zero planar area. Neither one
asserts that an asset ought to be ground-mounted; admission still requires an authored
placement and independent creator review.

## Bounded pilot and corpus result

The implementation was first exercised against three synthetic boundary cases: a closed
planar base, a pointed tetrahedral lower extent, and two crossed zero-thickness foliage cards.
It retained positive area only for the planar base and produced deterministic zero-area lower
extrema for the other two. The existing disconnected-foot stress case continued to preserve
both planar components.

The twenty-four real outdoor cases then produced six `planar_patch_fit` measurements and
eighteen `lower_extrema` measurements. No source was removed, and no fallback acquired a
fabricated positive area. Only after that pilot did the full corpus run proceed.

The repaired 3,441-source measurement set has hash
`ba51d4e7a66cfd360b43cdc2dad2fb7fac9a18594d5f9f4b976a8f33d75d2e25` and contains:

| Method             | Sources | Contact | Area semantics                     |
| ------------------ | ------: | ------- | ---------------------------------- |
| `planar_patch_fit` |   1,703 | bottom  | fitted positive planar area        |
| `lower_extrema`    |   1,733 | bottom  | exactly zero; alignment only       |
| `refused`          |       5 | unknown | pose-dependent deformable geometry |

The near-universal bottom result for static sources is not a learned placement prediction. It
states the modest geometric fact that a bounded static mesh in its measured Y-up frame has a
lower side that can be brought into contact with a horizontal plane. Search metadata and
filename hints cannot promote that capability into catalog authority. Wall, ceiling, socket,
free, and ground intent remain declaration and review decisions.

## Future regression rule

A support-policy change must run the synthetic cases and the reviewed outdoor tranche before a
full corpus rewrite. Stop if a lower-extrema case gains positive contact area, a deformable case
loses its refusal, an exact planar case loses its fit, or a reviewed bottom-placement case
becomes unknown. Because measurement hashes change with the policy, downstream review and
admission artifacts must be regenerated and re-signed rather than relabeled.

[^1]: [Trimesh stable-pose implementation](https://github.com/mikedh/trimesh/blob/main/trimesh/poses.py)

[^2]: [Trimesh mesh API, including stable poses, sections, and projections](https://trimesh.org/trimesh.html)

[^3]: [Trimesh mesh-plane intersection implementation](https://github.com/mikedh/trimesh/blob/main/trimesh/intersections.py)
