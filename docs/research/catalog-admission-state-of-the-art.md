# Catalog Admission for an Open-World 3D Asset Registry

> **Status:** Non-authoritative research decision, recorded 2026-09-13. The
> implemented baseline is described in [Architecture](../ARCHITECTURE.md), accepted
> admission policy in [Visuals](../VISUALS.md), and unfinished work in the
> [Roadmap](../ROADMAP.md#catalog-admission-cutover). Basalt currently keeps bulk
> content local. Remote CAS replication is explicitly deferred and is not a claim
> about present behavior or a gate for the local admission pilot.

## Executive decision

Basalt should **revise the admission policy before running the full corpus**. The
current implementation has the right architectural center: measured evidence is
separate from semantic authority, model outputs are hypotheses, unknowns remain
incomplete, and the final catalog is content-addressed. Those choices are stronger
than the common alternative of asking one vision-language model to label every file
and treating its output as truth.

The complete admission method is not yet state of the art, however. Four mechanisms
are too weak to support high-confidence, pack-independent catalog growth:

1. Exact two-of-three model agreement treats implementation identity as statistical
   independence and gives all sources equal weight.
2. One visual embedding and one global cosine threshold conflate denotation, shape,
   material/style, and contextual substitutability.
3. Greedy complete-link clustering proves only similarity under that embedding; it
   does not prove that every member can replace every other member at the same
   semantic site.
4. A two-percent audit capped at eight items has no declared acceptance risk. With
   zero defects in eight independent observations, the one-sided 95% binomial upper
   bound on the defect rate is approximately 31.2%, not a production-quality bound.

The recommended replacement is a **risk-limiting multimodal admission system**:

```text
source identity
  -> deterministic integrity and geometry gates
  -> orthogonal render, material, shape, and metric evidence
  -> calibrated, factorized semantic prediction with abstention
  -> exact semantic-site candidate buckets
  -> pairwise substitution-compatibility evidence
  -> deterministic constrained partitioning
  -> active discovery review
  -> separate random acceptance audit
  -> curator or policy qualification
  -> admitted assertions, entries, dispositions, and a durable catalog root
```

There is no single published system that solves Basalt's exact problem. The best
available design is a synthesis of large-scale 3D curation, multimodal representation
learning, weak-supervision calibration, open-set and conformal prediction, active
clustering, statistical acceptance sampling, and content-addressed provenance. That
synthesis is the appropriate state-of-the-art baseline.

The immediate consequence is practical: do **not** spend money running several
frontier models over the whole corpus yet. First implement calibration, pairwise
substitution evidence, risk-based auditing, and locally verified evidence storage.
Then run a bounded pilot, qualify the policy on pack-held-out data, and scale only if
the pilot meets explicit false-admission bounds. Remote replication is a separate
infrastructure decision.

## What “state of the art” means here

Catalog admission is not ordinary image classification. It makes durable claims that
a compiler will later use without a human looking at the selected asset. A useful
admission system therefore has to satisfy five goals simultaneously:

- **Open-world safety.** New packs will contain unseen concepts, component dumps,
  odd coordinate systems, broken materials, collision meshes, and combinations that
  do not belong to any existing entry. The correct result is often `incomplete`.
- **Semantic stability.** A new pack may add evidence or new leaf commitments, but it
  must not silently reinterpret existing concepts or move existing assets because a
  clustering centroid changed.
- **Substitution precision.** Members of a substitution set must be interchangeable
  for the declared site. A false merge is more damaging than a false split: the
  former silently emits an invalid world, while the latter merely reduces variety or
  asks for review.
- **Bounded human effort.** Full per-asset manual review does not scale, but eliminating
  human calibration and audit entirely makes the authority claim indefensible.
- **Reproducibility and recovery.** Every decision must bind exact source, evidence,
  policy, model implementation, and semantic hashes; the small authority graph and
  the large evidence graph must both be recoverable after a local failure.

This framing rules out a leaderboard-driven answer. OpenShape and ULIP-2 demonstrate
that strong 3D representations can support open-vocabulary retrieval, but their
reported zero-shot top-1 accuracy on the 1,156-category Objaverse-LVIS benchmark was
46.8% and 50.6%, respectively.[^1][^2] Those are valuable candidate generators, not
authority-grade catalog adjudicators. The choice of backbone must be made by a Basalt
gold-set evaluation rather than by adopting whichever model has the newest paper.

## Inspected baseline snapshot

At the catalog root inspected on 2026-09-13, Basalt accounted for 3,441 unique content identities
from 3,447 source paths. Of these, 3,436 have measurement artifacts and five have
explicit measurement refusals. No source currently has an admitted semantic
assertion or catalog entry, so all dispositions remain incomplete. The tracked
evidence manifests occupy approximately 61 MiB of JSON, excluding source archives,
source assets, and rendered image payloads.

The implemented prototype path at that snapshot was:

```text
measured asset + multiview render
  -> independent semantic hypothesis receipts
  -> exact-signature panel consensus
  -> hard semantic/physical partition
  -> single-embedding complete-link cohorts
  -> medoid/outlier/metric/boundary/audit samples
  -> explicit cohort decision and optional audit
  -> admitted assertions and substitution-set declaration
  -> CatalogAuthorityCommit
```

The default policy requires at least two distinct hypothesis implementations, a
two-thirds exact-signature consensus, visual cosine similarity of at least 0.9, at
least three selected review items per cohort, and a deterministic two-percent audit
capped at eight. Only substitution sets can be materialized by this path. Model
confidence is correctly excluded from semantic authority.

### Assessment matrix

| Area                | Current mechanism                                                        | Assessment                                                                                                    | Decision                                                               |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Source identity     | Content hashes and exact evidence lineage                                | Strong                                                                                                        | Keep                                                                   |
| Failure semantics   | `eligible`, `incomplete`, `rejected`                                     | Strong and unusually important                                                                                | Keep                                                                   |
| Semantic authority  | Hypotheses cannot directly satisfy requirements                          | Strong                                                                                                        | Keep                                                                   |
| Multiview evidence  | Deterministic views, silhouette, depth, measurement                      | Good foundation; missing orthogonal shape/material channels                                                   | Extend                                                                 |
| Model panel         | Exact two-thirds vote across implementation hashes                       | Reproducible but statistically uncalibrated and correlation-blind                                             | Replace                                                                |
| Open-set behavior   | Abstention and incomplete outcomes                                       | Correct contract, weak detection policy                                                                       | Strengthen                                                             |
| Cohort formation    | Exact signature/physical bins, then greedy complete-link cosine grouping | Conservative prototype, not a substitution proof; order-sensitive partition geometry can fragment valid sets  | Replace                                                                |
| Human review        | Medoid, visual and metric outliers, boundary, deterministic sample       | Good defect discovery                                                                                         | Keep as a distinct discovery queue                                     |
| Acceptance audit    | Two percent, maximum eight                                               | No useful declared risk guarantee                                                                             | Replace                                                                |
| Admission authority | Curator decision is copied into assertions for all cohort members        | Clear provenance, but overstates what was individually reviewed                                               | Split curator and policy-qualified authority bases                     |
| Catalog durability  | Atomic Git-tracked root and retained JSON evidence                       | Good identity boundary; large monolithic evidence will make Git history costly and bulk payloads remain local | Shard authority and use a verified local CAS; defer remote replication |

## Evidence architecture

### Multiview rendering is necessary, but RGB alone is not enough

Cap3D showed that captions can be generated at large scale by rendering multiple
views, producing view-level descriptions, filtering them through image-text
alignment, and consolidating them. It applied the approach to 660,000 objects and
evaluated it with 41,000 human annotations.[^3] This validates Basalt's multiview
direction and the use of model output as scalable review evidence. It does not show
that captions should become semantic authority or that visual similarity implies
substitutability.

Large 3D repositories also keep orthogonal attributes separate. ShapeNet combines a
taxonomy with alignment, parts, symmetry, physical size, and keywords rather than
compressing them into one label or vector.[^4] The Amazon Berkeley Objects dataset
publishes 3D meshes, multiview images, camera information, material benchmarks, and
part labels as distinct evidence products.[^5] Objaverse++ manually annotated 10,000
objects for attributes such as aesthetic quality, texture/color, multi-object
composition, and transparency before training a network to extend the annotations
to a much larger set.[^6]

Basalt should therefore represent evidence as separate channels, each with its own
implementation hash and calibration result:

| Channel          | Evidence                                                                                                 | Primary use                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Integrity        | parse result, node/primitive counts, degenerate geometry, animation, skinning, external-resource closure | Reject or route malformed and unsupported artifacts                          |
| Geometry         | normalized point cloud or mesh samples, normals, topology summary, connected components, oriented bounds | Shape similarity, whole/component detection, dimensional compatibility       |
| Appearance       | canonical RGB views and per-view features                                                                | Visual coherence and coarse style                                            |
| Material         | unlit base-color/albedo, UV coverage, texture/PBR channel presence, transparency, material count         | Detect dark/missing textures and distinguish geometry from rendering failure |
| Silhouette/depth | per-view masks and normalized depth                                                                      | Shape without texture or lighting confounds                                  |
| Installation     | measured contact surfaces, support direction, sockets/interfaces, collision companions                   | Placement and substitution constraints                                       |
| Semantics        | model hypotheses grounded in the exact evidence set and semantic module                                  | Candidate denotation, realization, state, affordance, treatment              |

No single concatenated vector should control all downstream decisions. A semantic
image-text encoder such as SigLIP 2 is a plausible candidate for denotation and
appearance retrieval; it reports improvements over its predecessor in zero-shot
classification, image-text retrieval, localization, and dense prediction.[^7] A
self-supervised backbone such as DINOv3 is a plausible shape/appearance feature
channel and can be adapted with a lightweight head using a relatively small labeled
set.[^8] Native 3D encoders such as OpenShape, Uni3D, ULIP-2, or Point-Bind are
plausible geometry channels.[^1][^2][^9][^10]

These names are a benchmark slate, not a hard dependency decision. Each candidate
must be evaluated on the same content-addressed Basalt gold set for semantic
precision, pairwise substitution precision, calibration, latency, cost, licensing,
and pack-level shift. A smaller locally hosted model that satisfies the risk policy
is preferable to a nominally stronger but uncalibrated frontier service.

### Use multimodal diversity, not merely multiple model names

The present panel counts distinct `(adapterHash, modelImplementationHash)` pairs as
independent. That establishes provenance uniqueness, not error independence. Models
trained on overlapping web data, sharing a vision encoder, or prompted with the same
ontology can make strongly correlated mistakes.

Weak-supervision research makes this distinction explicit. Snorkel models the
unknown accuracy and correlations of noisy labeling sources rather than resolving
disagreement with an unweighted majority vote.[^11] Subsequent work found measurable
gains from learning source dependency structures compared with assuming conditional
independence.[^12] Basalt should apply the same principle at the facet level.

A hypothesis receipt should preserve, for each facet:

- the candidate values or hierarchy nodes;
- an explicit abstention;
- raw provider evidence when available, such as logits or retrieval scores;
- the prompt, adapter, model implementation, and evidence hashes;
- the empirical calibration bucket and calibration-set hash;
- the source's estimated confusion behavior and dependency group.

Self-reported language-model confidence must remain non-authoritative. However,
discarding all numerical evidence is unnecessarily blunt. Vision-language models
are not inherently calibrated, but empirical work found that post-hoc temperature
scaling consistently improves their calibration and can work with relatively small
calibration sets.[^13] For providers that expose no logits, Basalt can calibrate
observable features—agreement pattern, retrieval margin, output stability, pack,
and predicted concept depth—against adjudicated data. Those values influence a
qualification gate; they never directly author a commitment or assertion.

The panel should be factorized. A source may correctly identify `chair` while being
uncertain whether an artifact is a whole object, a connected aggregate, or a modular
component. Requiring one exact signature match across denotation, realization,
states, affordances, and treatments throws away useful partial agreement and hides
which facet needs review. Basalt should aggregate each facet separately, enforce
cross-facet constraints afterward, and preserve every abstention and conflict.

### Open-set and hierarchical prediction must be explicit

A closed-set classifier tends to assign an unknown input to some known class.
Open-set recognition research was motivated precisely by this forced-label failure,
and later energy-based methods showed that softmax confidence can remain
overconfident on out-of-distribution inputs.[^14][^15] Outlier exposure offers one
way to improve anomaly detection by training against diverse auxiliary outliers.[^16]

Basalt has a natural advantage: its semantic kernel already has a hierarchy and an
`incomplete` state. The admission system should return a calibrated prediction set,
not just a top label:

- a singleton exact leaf may proceed to the next gate;
- a singleton internal concept may form a review bucket but cannot satisfy a leaf
  requirement;
- several plausible leaves return `incomplete` with a bounded candidate set;
- no supported concept returns an unknown/novelty gap;
- an apparent new concept is proposed to semantic governance, never authored by the
  ingestion model.

Conformal prediction is useful here because it can create set-valued predictions
under an explicit calibration assumption. Conformal risk control generalizes this
idea to monotone losses such as false-negative rate and graph distance.[^17]
Hierarchical conformal methods can return internal hierarchy nodes while targeting
coverage.[^18] Basalt should use these tools as a selective prediction mechanism,
not advertise a universal guarantee.

The limitation matters: ordinary conformal guarantees rely on exchangeability or
specified shift assumptions. WILDS shows that real domain shifts can substantially
reduce performance even when standard in-distribution evaluation looks strong.[^19]
An unseen asset pack is exactly such a shift. Consequently:

- split calibration and evaluation by pack/creator, never randomly by asset alone;
- report leave-one-pack-out performance across existing packs;
- keep Office as a final untouched operational holdout if it has not influenced
  thresholds or prompts;
- run a shift detector and a small requalification audit on every new pack;
- route a shifted pack to `incomplete` rather than borrowing old guarantees.

## Substitution is a relation, not a label

The deepest issue is that denotation and substitutability are different questions.
Two assets may both denote `stairs`, have similar silhouettes, and still be
non-substitutable because one is a complete staircase and the other is a broken
segment; because their rise/run and connection interfaces differ; because one is a
wall attachment; or because their styles are incompatible. Conversely, two assets
with visibly different silhouettes may be valid variants at the same tree site.

The current exact semantic signature and physical buckets are useful candidate
filters. They should not be treated as proof. Introduce a non-authoritative
`SubstitutionCompatibilityReceipt` over an exact semantic-site signature:

```text
SubstitutionCompatibilityReceipt
  left asset/evidence hash
  right asset/evidence hash
  semantic dependency closure hash
  semantic-site signature hash
  denotation compatibility
  realization-form compatibility
  fixed-state compatibility
  placement/contact compatibility
  interface compatibility
  metric-envelope compatibility
  appearance/style compatibility
  outcome: must_link | cannot_link | uncertain
  evidence and implementation hashes
```

Hard contract violations—different realization form, incompatible support,
incompatible socket/interface, disjoint required state, or out-of-envelope
measurement—produce `cannot_link` without a model. Learned pairwise scorers handle
shape and style only after the hard gates. Borderline pairs are cheaper for a human
to judge as “can these replace one another here?” than to fully classify from
scratch; active-clustering research explicitly exploits the lower cost of pairwise
same-class judgments.[^20]

Candidate sets should then be partitioned as a signed constraint graph, not by
greedy insertion into the first cosine-compatible group. The solver minimizes
disagreement while respecting hard cannot-links and deterministic tie-breaking.
Correlation clustering is one established formulation for partitioning positive
and negative similarity graphs.[^21] Basalt need not import a general optimizer if a
small deterministic solver is easier to verify, but the contract should be expressed
as signed evidence and constraints.

Every proposed substitution set must pass an all-member invariant checker after
partitioning. It verifies one denotation and realization form, compatible fixed
states, a common placement/interface contract, an admitted metric envelope, style
coherence, and a complete evidence graph. An uncertain edge cannot be silently
treated as positive. It either splits the proposal or sends the boundary pair to
review.

This does not require human review of every pair. Exact semantic-site filtering makes
candidate graphs small; cheap machine scorers can evaluate all remaining pairs;
transitive structure reduces the number of human questions; and review focuses on
the weakest positive edge, strongest negative edge, cross-pack boundary, medoid,
visual outlier, metric extreme, and structural anomaly. The system should optimize
for substitution precision and accept extra singleton sets or incomplete assets.

## Human review and statistical acceptance

### Separate defect discovery from prevalence estimation

The existing medoid/outlier/boundary policy is a good active-review strategy. It is
designed to find informative and suspicious examples. Modern active-learning methods
likewise combine uncertainty and diversity, while active clustering focuses human
questions on useful pairs.[^20][^22]

That sample is not a random sample of the cohort. It cannot, by itself, estimate the
remaining defect rate. Active-testing research warns that adaptively choosing test
items creates sample-selection bias unless the estimator explicitly corrects for the
selection probabilities.[^23] Basalt should therefore create two separately hashed
review plans:

1. **Discovery review** chooses medoids, outliers, anomalies, disagreements, weakest
   links, and nearest cross-cohort boundaries. Any failure repairs or splits the
   proposal.
2. **Acceptance audit** samples randomly without replacement from the post-repair
   finite cohort under a declared statistical plan. It estimates or bounds residual
   defects. Discovery observations do not count toward the random bound unless they
   were also selected by the audit design.

The random selection may remain deterministic and reproducible by ranking source
hashes with a sealed audit seed. What matters statistically is that the sampling
mechanism is fixed independently of unknown conformance outcomes and that its
inclusion probabilities are known.

### Replace a sample percentage with an operating characteristic

Acceptance sampling is defined by a sample size, an acceptance number, and an
operating-characteristic curve that states the probability of accepting lots at
different defect rates.[^24] “Inspect two percent” is not a risk policy: the same
percentage has radically different evidential value for different cohort sizes, and
the maximum of eight prevents confidence from improving for large cohorts.

For a large population, a zero-defect sample can reject the hypothesis that the true
defect rate is at least \(p_*\) with one-sided confidence \(1-\delta\) when:

```text
n >= ceil(log(delta) / log(1 - p*))
```

At 95% confidence and zero observed defects, the approximate large-population sample
sizes are:

| Target upper defect rate | All-pass sample size |
| -----------------------: | -------------------: |
|                      10% |                   29 |
|                       5% |                   59 |
|                       2% |                  149 |
|                       1% |                  299 |

The same calculation gives an upper bound of about 31.2% after zero defects in only
eight observations. These are analytical binomial results, not measurements of the
current catalog. For a finite cohort sampled without replacement, Basalt should use
the exact hypergeometric probability, which can require fewer observations as the
sample approaches the cohort size.[^25]

A single universal target is also inappropriate. Define defect classes and
criticality:

- **identity/realization error:** wrong concept, component mistaken for whole object,
  collision mesh admitted as renderable;
- **installation error:** wrong support, contact, orientation, or interface;
- **substitution error:** member cannot satisfy the entry's declared site;
- **appearance error:** material failure or style incoherence;
- **rights/provenance error:** unproven or incompatible usage rights.

Structural and rights errors should have the strictest policy, often requiring
complete review or deterministic proof. Appearance may tolerate a different bound.
Each `AdmissionRiskPolicy` should declare the population scope, defect predicate,
maximum tolerated rate, confidence, sample design, acceptance number, response to a
failure, calibration set, and holdout definition. Every generated audit plan should
include its operating characteristic or exact finite-population acceptance
probabilities.

One failure should not merely produce a red audit badge. It should invalidate the
qualification, add a cannot-link or evidence gap, split/recompute the cohort, and
generate a new post-repair audit population. Sequential or double-sampling plans can
reduce average review cost while preserving the declared risk, but the simple
zero-acceptance plan is the clearest initial baseline.

### Authority without pretending every item was manually inspected

The present admission code names a curator decision as declared evidence for every
member in the cohort. That is understandable but semantically too broad when the
curator reviewed only a sample. Basalt should distinguish two admitted authority
bases:

- `curator_assertion`: the named curator directly adjudicated the exact asset or
  pair;
- `policy_qualification`: a sealed admission policy accepted the asset based on
  calibrated evidence, a finite population, review findings, and an audit receipt.

Both can produce an admitted semantic assertion, but their provenance differs.
Neither contains model confidence as authority. The policy qualification binds the
model and calibration evidence, the risk target, every cohort member, the sample
selection proof, audit findings, and the policy implementation hash. This accurately
describes scalable human supervision: humans author the ontology, gold labels,
pairwise judgments, and acceptance policy; automation applies the qualified policy
to the rest.

This approach means one person does not inspect 3,441 assets. It does mean that no
defensible system begins with zero human adjudication. Objaverse++ followed the same
broad pattern at a much larger scale: experts labeled a high-quality seed set, then a
trained model extended those annotations.[^6] Basalt's stronger addition is selective
abstention, substitution-specific evidence, and a risk receipt before compiler
authority.

## Proposed contracts

The semantic kernel, catalog model, artifact store, and package boundaries should
remain. Replace the policy-level contracts inside `catalog-authoring` with the
following engine-neutral artifacts.

### Evidence and calibration

- `AssetEvidenceSet`
  - exact source, measurement, render, geometry, material, installation, and
    implementation hashes;
  - per-channel status and diagnostics;
  - no semantic authority.
- `FacetHypothesisReceipt`
  - one subject and one facet;
  - candidates or hierarchy nodes, abstention, raw observable scores, source
    dependency group, and provenance;
  - no compiler authority.
- `CalibrationCorpus`
  - exact curator-adjudicated assets and pairwise substitution judgments;
  - pack/creator groups and frozen train/calibration/evaluation roles;
  - immutable content identity.
- `CalibratedSemanticPrediction`
  - per-facet prediction sets and empirical calibration receipts;
  - in-distribution/shift result;
  - eligible to propose, never to assert.

### Substitution and grouping

- `SemanticSiteSignature`
  - exact concept commitment and match mode;
  - realization, fixed states, treatments, proven affordances;
  - placement, contact, interface, metric, resource, rights, and style bounds.
- `SubstitutionCompatibilityReceipt`
  - exact pair, site, hard constraints, learned scores, and
    `must_link | cannot_link | uncertain` outcome.
- `ConstrainedCohortProposal`
  - all source identities, signed edges, connected constraints, solver
    implementation hash, objective/evidence, and deterministic partition.
- `CohortInvariantReport`
  - whole-set verification of every required substitution condition.

### Review, risk, and authority

- `DiscoveryReviewPlan` and `DiscoveryReviewDecision`
  - anomaly and boundary cases selected for finding defects;
  - may repair constraints, split cohorts, or keep items incomplete.
- `AdmissionRiskPolicy`
  - defect types, population strata, tolerated rates, confidence, sample design,
    acceptance number, calibration/evaluation hashes, and shift policy.
- `RandomAcceptanceAuditPlan` and `RandomAcceptanceAuditReceipt`
  - exact finite population, deterministic randomization proof, inclusion
    probabilities, observations, and exact acceptance calculation.
- `AdmissionQualificationReceipt`
  - either direct curator adjudication or policy qualification;
  - binds every predecessor and is the evidence source for admitted assertions.

All artifacts continue to return `eligible`, `incomplete`, or `rejected`. A missing
calibration, unknown concept, shifted pack, uncertain pair, failed invariant, or
failed audit remains incomplete or rejected according to its contract. No fallback
may weaken the site or silently choose a nearby concept.

## Recommended operating architecture

### Stage A: deterministic triage

Run every source through inexpensive deterministic gates first. Deduplicate by exact
content; resolve all glTF dependencies; identify parse failures, empty/degenerate
geometry, disconnected multi-object aggregates, animation/skinning, suspicious
component dumps, collision companions, missing textures, unsupported transparency,
and measurement refusal. These gates save model cost and often determine `rejected`
or `incomplete` without semantics.

Collision companions remain evidence. Multi-object and component artifacts enter
specific authoring queues rather than substitution sets. Assembly kits, route kits,
and attachment sets require their own authored roles/interfaces; no visual model may
invent a structural grammar.

### Stage B: orthogonal representation

Regenerate deterministic evidence with canonical material handling. Store per-view
RGB, unlit base color, silhouette, depth, and normal evidence, plus a normalized 3D
sample and physical/interface vector. Produce channel-specific embeddings and keep
per-view features so an aggregation bug cannot erase a view-specific anomaly.

Use a small Basalt benchmark to select one semantic image-text channel, one
self-supervised appearance/shape channel, and one native 3D geometry channel. The
ensemble is diversified by modality and training objective, not by sending the same
contact sheet to three closely related language models.

### Stage C: calibrated semantic triage

Run the cheapest local models and deterministic labeling functions first. Escalate
only uncertain items to more expensive vision-language adapters. Aggregate evidence
per facet with calibrated source weights and dependency groups. Produce hierarchical
prediction sets and explicit novelty/shift results. Exact singleton concepts proceed;
ambiguous or unknown assets enter targeted review.

Filename and folder signals may remain low-cost, abstaining review hints. They must
not enter admitted assertions, semantic-site signatures, or catalog hashes that can
change runtime resolution.

### Stage D: substitution graph

Build candidate buckets only after exact semantic-site compatibility. Evaluate every
remaining pair with deterministic constraints and learned comparison channels.
Partition the signed graph deterministically. Prefer singleton or fragmented cohorts
over a weak positive edge. Run the whole-set invariant checker after partitioning.

### Stage E: review and qualification

Generate a discovery queue over individual anomalies and pairwise boundaries. Apply
review decisions, recompute proposals, then freeze each finite candidate cohort.
Generate a separate random acceptance audit from the risk policy. Successful direct
or policy qualification creates admitted assertions and catalog entries; failures
split, reject, or leave assets incomplete.

### Stage F: local storage integrity

Commit a small, atomic catalog authority root to ordinary Git. It should include or
reference sharded semantic assertions, entry declarations, dispositions, human
decisions, risk policies, and qualification receipts. Large evidence should move to
a verified local content-addressed store and be referenced by an unversioned
descriptor:

```text
{ kind, artifactHash, bytesHash, bytes }
```

This pattern mirrors the useful part of OCI content descriptors: a component is
identified by digest, size, and media/type information, components form a Merkle DAG,
and retrieved bytes are verified before use.[^26] Basalt should adopt the content
integrity idea, not OCI's media-type or schema-version conventions. The existing
hypothesis/activity/evidence separation also aligns with W3C PROV's distinction among
entities, activities, agents, generation, derivation, and attribution.[^27]

The accepted near-term boundary is local: resolve every authority-reachable
descriptor from one declared local root, rehash bytes on read, reject dangling
descriptors, and define reachability before garbage collection. The operator must
back up that root independently; a clean Git clone is not full disaster recovery.

Git LFS, an S3-compatible store, or another remote CAS may later replicate the same
provider-neutral descriptor graph.[^28] That transport must use create-only writes,
rehash downloaded bytes, preserve every reachable blob, and expose explicit
push/pull/verify operations. No remote backend is selected or implemented now, and
remote concerns must not enter semantic or catalog identity.

The current monolithic evidence snapshot is tolerable as a bootstrap, but repeated
runs will multiply Git history and clone cost. Sharding small human authority by
stable entity ID and moving bulky machine evidence behind locally resolvable
descriptors should happen before repeated full-corpus runs. Remote replication may
follow without changing those descriptors.

## Calibration and rollout for the current corpus

The rollout should be empirical and stop at failed gates. The numbers below are
initial engineering budgets, not universal statistical guarantees; final sample
sizes come from the declared risk policy and observed strata.

### 1. Freeze evaluation definitions

Define adjudication rubrics for each semantic facet, artifact health class, entry
kind, and pairwise substitutability. Define false-merge, false-split, semantic
mislabel, installation, appearance, and rights defects. Decide which errors block
runtime admission and which create optional diagnostics.

Keep the semantic commitments immutable. Review may expose a genuine missing leaf,
but adding it is a separate semantic-governance action. Re-running the model cannot
alter old commitments.

### 2. Build a grouped gold corpus

Select a stratified seed across packs, semantic depths, metric scales, texture/PBR
conditions, whole/component/aggregate cases, attachments, collision companions, and
known failures. An initial budget of several hundred fully adjudicated assets and
several hundred targeted pair judgments is reasonable for a pilot; continue labeling
until calibration intervals and pack-held-out performance stabilize.

Use creator/pack groups for all splits. Tune on multiple leave-one-pack-out folds.
Preserve one untouched pack for the final operational test. If Office has already
influenced prompts, thresholds, or error analysis, it is no longer a valid untouched
holdout and a future unseen pack must fill that role.

### 3. Benchmark evidence channels

For every candidate backbone, record exact implementation and weights hashes. Measure:

- exact-leaf and ancestor-aware semantic precision/recall;
- prediction-set coverage and set size;
- novelty/OOD discrimination;
- pairwise substitution precision and recall;
- appearance/style retrieval precision;
- latency, peak memory, and cost per asset;
- performance by held-out pack and failure category.

Choose the smallest channel set that meets the policy. More models are not inherently
safer; correlated models add cost without proportional evidence.

### 4. Pilot one bounded stratum

Choose a low-risk, well-represented category such as whole, ground-supported props
with good material evidence. Run deterministic gates, calibrated hypotheses,
substitution graph construction, discovery review, and the full random audit. Do not
start with modular structures, route components, animated characters, or attachment
semantics; those need richer role/interface contracts.

The pilot succeeds only if the held-out and audit results satisfy the declared risk
target. Otherwise add evidence, split the stratum, increase abstention, or lower
coverage. Do not merely lower thresholds to admit more assets.

### 5. Expand by risk tier

Progress from simple whole props to aggregates and environment realizers, then
attachments, then explicit components and authored kits. Each tier gets its own
policy, gold examples, and failure predicates. Assets without adequate semantics or
interfaces remain explicitly incomplete and are still fully accounted for.

### 6. Admit the full corpus selectively

Run the cost cascade over all evidence-complete assets. Automatically qualify only
assets inside calibrated strata with singleton predictions, complete substitution
evidence, passing invariants, and passing audits. Send disagreements, novel concepts,
shifted packs, and boundary pairs to a compact review queue. Commit the authority
graph and locally rehash every referenced evidence payload after each accepted
batch.

## Acceptance metrics

The admission system is ready to scale when all of the following are measured on
pack-held-out data and bound in an `AdmissionQualificationReceipt`:

| Metric                        | Required interpretation                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Substitution false-merge rate | Primary quality metric; upper confidence bound below the policy target                                              |
| Semantic precision            | Exact commitment precision at the admitted coverage, reported by concept depth                                      |
| Hierarchical coverage         | Prediction-set coverage and mean set size; no guarantee claimed outside the calibrated population                   |
| Abstention/coverage           | Fraction auto-qualified, reviewed, incomplete, and rejected; high abstention is acceptable initially                |
| Installation precision        | Support/contact/interface correctness for admitted members                                                          |
| Artifact-health recall        | Detection of broken, component, aggregate, collision, animation, and material failures                              |
| Cross-pack robustness         | Worst-pack and leave-one-pack-out results, not only micro-averages                                                  |
| Calibration                   | Reliability by facet, model source, semantic depth, and pack                                                        |
| Audit risk                    | Exact finite-population acceptance probability and upper defect bound by defect class                               |
| Determinism                   | Identical inputs and implementations emit byte-identical proposals, samples, decisions, and roots                   |
| Stability                     | Adding an unrelated pack leaves semantic commitments, existing admitted assertions, and unrelated entries unchanged |
| Local recoverability          | Every authority reference resolves from the declared local artifact root and all retrieved hashes verify            |

Coverage must never be optimized alone. The preferred operating point is high
precision with explicit incompleteness. The catalog can improve incrementally as
review evidence accumulates, without weakening compiler guarantees.

## Decisions by component

### Keep unchanged in principle

- the seven-sort semantic kernel and orthogonal facets;
- hypotheses versus admitted assertions;
- source-content and evidence hashes;
- deterministic measurement and multiview receipts;
- provider-neutral model adapters;
- explicit incomplete/rejected dispositions;
- strict entry kinds and the substitution-set invariant;
- source paths as review hints only;
- engine-neutral catalog and compiler contracts;
- exact catalog root identity.

### Change before scaling

- replace exact majority voting with factorized, calibrated, dependency-aware
  aggregation;
- add explicit open-set, hierarchy-aware prediction sets and pack-shift gates;
- replace the single embedding with orthogonal semantic, geometry, appearance, and
  installation evidence;
- replace visual cohorts as authority candidates with constrained substitution
  graphs and set-level invariant proofs;
- split active discovery review from random acceptance auditing;
- replace percentage/capped audits with risk-defined finite-population plans;
- distinguish direct curator assertions from policy-qualified assertions;
- shard small authority and move bulky machine evidence to a verified local CAS;
  preserve remote replication as a later transport concern.

### Do not do

- do not classify all assets from filenames or folders;
- do not force every asset into an existing concept or entry;
- do not treat agreement among uncalibrated VLMs as truth;
- do not use one cosine threshold across concepts, styles, and modalities;
- do not equate visual similarity with substitutability;
- do not let models author concepts, kit roles, interface meanings, or assembly
  grammars;
- do not claim a statistical guarantee from actively selected examples;
- do not claim a new-pack guarantee from random asset-level train/test splits;
- do not store repeated large evidence snapshots as ordinary monolithic Git blobs;
- do not run paid full-corpus inference until the gold corpus and risk gates exist.

## Final recommendation

Basalt's current pipeline should be treated as a strong **contract skeleton and
prototype**, not the frozen admission algorithm. Its most important decision—the
separation of evidence, hypotheses, and authority—is correct. The next iteration
should preserve that boundary while changing the statistical and relational core.

The best durable baseline is not “three models plus a sample.” It is:

1. deterministic, orthogonal 3D evidence;
2. calibrated selective prediction with explicit unknowns;
3. substitution-specific pair and set evidence;
4. active review for discovering failures;
5. random, risk-defined audits for bounding residual failures;
6. honest policy-qualified provenance; and
7. a small Git authority graph backed by a verified local content-addressed store,
   with the lack of remote disaster recovery stated honestly.

That architecture makes it realistic to admit thousands of assets without inspecting
each one, while preserving the property Basalt actually needs: a catalog addition
cannot silently weaken the world compiler's semantic guarantees.

## Sources

[^1]: Minghua Liu et al., “[OpenShape: Scaling Up 3D Shape Representation Towards Open-World Understanding](https://papers.nips.cc/paper_files/paper/2023/hash/8c7304e77c832ddc70075dfee081ca6c-Abstract-Conference.html),” NeurIPS 2023.

[^2]: Le Xue et al., “[ULIP-2: Towards Scalable Multimodal Pre-training for 3D Understanding](https://arxiv.org/abs/2305.08275),” CVPR 2024.

[^3]: Tiange Luo et al., “[Scalable 3D Captioning with Pretrained Models](https://arxiv.org/abs/2306.07279),” 2023.

[^4]: Angel X. Chang et al., “[ShapeNet: An Information-Rich 3D Model Repository](https://arxiv.org/abs/1512.03012),” 2015.

[^5]: Jasmine Collins et al., “[ABO: Dataset and Benchmarks for Real-World 3D Object Understanding](https://openaccess.thecvf.com/content/CVPR2022/papers/Collins_ABO_Dataset_and_Benchmarks_for_Real-World_3D_Object_Understanding_CVPR_2022_paper.pdf),” CVPR 2022; [official dataset](https://amazon-berkeley-objects.s3.amazonaws.com/index.html).

[^6]: Chendi Lin et al., “[Objaverse++: Curated 3D Object Dataset with Quality Annotations](https://arxiv.org/abs/2504.07334),” CVPR 2025 Workshop on Efficient Large Vision Models.

[^7]: Michael Tschannen et al., “[SigLIP 2: Multilingual Vision-Language Encoders with Improved Semantic Understanding, Localization, and Dense Features](https://arxiv.org/abs/2502.14786),” 2025.

[^8]: Meta AI Research, “[DINOv3](https://ai.meta.com/research/dinov3/),” 2025.

[^9]: Junsheng Zhou et al., “[Uni3D: Exploring Unified 3D Representation at Scale](https://proceedings.iclr.cc/paper_files/paper/2024/hash/cc2c03ce028a1d6cbed6f98cede7f5a9-Abstract-Conference.html),” ICLR 2024.

[^10]: Ziyu Guo et al., “[Point-Bind & Point-LLM: Aligning Point Cloud with Multi-modality for 3D Understanding, Generation, and Instruction Following](https://arxiv.org/abs/2309.00615),” 2023.

[^11]: Alexander Ratner et al., “[Snorkel: Rapid Training Data Creation with Weak Supervision](https://www.vldb.org/pvldb/vol11/p269-ratner.pdf),” Proceedings of the VLDB Endowment 11(3), 2017.

[^12]: Paroma Varma et al., “[Learning Dependency Structures for Weak Supervision Models](https://proceedings.mlr.press/v97/varma19a.html),” ICML 2019.

[^13]: Weijie Tu et al., “[An Empirical Study Into What Matters for Calibrating Vision-Language Models](https://proceedings.mlr.press/v235/tu24a.html),” ICML 2024.

[^14]: Abhijit Bendale and Terrance Boult, “[Towards Open Set Deep Networks](https://openaccess.thecvf.com/content_cvpr_2016/papers/Bendale_Towards_Open_Set_CVPR_2016_paper.pdf),” CVPR 2016.

[^15]: Weitang Liu et al., “[Energy-based Out-of-distribution Detection](https://papers.neurips.cc/paper/2020/hash/f5496252609c43eb8a3d147ab9b9c006-Abstract.html),” NeurIPS 2020.

[^16]: Dan Hendrycks, Mantas Mazeika, and Thomas Dietterich, “[Deep Anomaly Detection with Outlier Exposure](https://arxiv.org/abs/1812.04606),” ICLR 2019.

[^17]: Anastasios N. Angelopoulos et al., “[Conformal Risk Control](https://research.google/pubs/conformal-risk-control/),” ICLR 2024.

[^18]: Thomas Mortier et al., “[Conformal Prediction in Hierarchical Classification with Constrained Representation Complexity](https://proceedings.mlr.press/v300/mortier26a.html),” AISTATS 2026.

[^19]: Pang Wei Koh et al., “[WILDS: A Benchmark of in-the-Wild Distribution Shifts](https://proceedings.mlr.press/v139/koh21a.html),” ICML 2021.

[^20]: Quentin Lutz et al., “[Active Clustering for Labeling Training Data](https://proceedings.neurips.cc/paper/2021/hash/47841cc9e552bd5c40164db7073b817b-Abstract.html),” NeurIPS 2021.

[^21]: Nikhil Bansal, Avrim Blum, and Shuchi Chawla, “[Correlation Clustering](https://www.cs.cmu.edu/~shuchi/papers/clusteringfull.pdf),” Machine Learning 56, 2004.

[^22]: Jordan T. Ash et al., “[Deep Batch Active Learning by Diverse, Uncertain Gradient Lower Bounds](https://arxiv.org/abs/1906.03671),” ICLR 2020.

[^23]: Jannik Kossen et al., “[Active Testing: Sample-Efficient Model Evaluation](https://proceedings.mlr.press/v139/kossen21a.html),” ICML 2021.

[^24]: NIST/SEMATECH, “[Acceptance Sampling and Operating Characteristic Curves](https://www.itl.nist.gov/div898/handbook/pmc/section2/pmc243.htm),” e-Handbook of Statistical Methods.

[^25]: Eric W. Brown et al., “[Sample Size Determination for Food Sampling](https://doi.org/10.1016/j.jfp.2023.100134),” Journal of Food Protection 86(11), 2023.

[^26]: Open Containers Initiative, “[OCI Content Descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md),” Image Specification.

[^27]: W3C Provenance Working Group, “[PROV-O: The PROV Ontology](https://www.w3.org/TR/prov-o/),” W3C Recommendation, 2013.

[^28]: Git LFS Project, “[Git Large File Storage](https://git-lfs.com/),” official documentation.
