# Catalog Admission for an Open-World 3D Asset Registry

> **Status:** Non-authoritative research decision, recorded 2026-09-13. The
> implemented baseline is described in [Architecture](../ARCHITECTURE.md), accepted
> admission policy in [Visuals](../VISUALS.md), and unfinished work in the
> [Roadmap](../ROADMAP.md#catalog-admission-qualification). Basalt currently keeps bulk
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
frontier models over the whole corpus yet. First resolve the asset-rights gate
identified below, then implement calibration, pairwise substitution evidence,
risk-based auditing, and locally verified evidence storage. Run a bounded pilot,
qualify the policy on physical-leakage-group-disjoint data, and scale only if the
pilot meets explicit false-admission bounds. Remote replication is a separate
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

At the catalog root inspected on 2026-09-13, Basalt accounted for 3,441 unique
content identities from 3,447 source paths. All 3,441 identities have measurement
artifacts; five skinned sources are explicitly measured at rest/bind pose while
refusing pose-dependent support and interface claims. No source currently has an
admitted semantic assertion or catalog entry, so all dispositions remain
incomplete. The leakage analysis contains 2,756 connected groups: 1,663 development,
540 calibration, and 553 evaluation groups, representing 2,064, 689, and 688 source
identities respectively.

The tracked authority and compact evidence manifests exclude source archives,
source GLBs, and rendered image payloads. At the inspection point, the ignored
`.basalt` working state occupied approximately 43 GB, the tracked source-asset area
approximately 1.5 GB, and the volume had approximately 35 GB free. These are
operational observations, not stable contracts. A Git clone cannot recover the
ignored source archives, extracted GLBs, or render corpus.

The deterministic low-risk candidate ceiling is narrower than the corpus total:
1,531 assets are static, single-part, single-material, and have measured bottom
contact. This is useful for pilot sampling, but it is not evidence that those assets
are whole objects or semantically admissible. Those are separate claims.

The implemented prototype path at that snapshot was:

```text
canonical source identity
  -> measured asset + orthogonal multiview channels
  -> basename-only weak hints for semantic hypotheses
  -> physical leakage graph and whole-group split
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

| Area                | Current mechanism                                                                    | Assessment                                                                                                   | Decision                                                              |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Source identity     | Content hashes and exact evidence lineage                                            | Strong                                                                                                       | Keep                                                                  |
| Failure semantics   | `eligible`, `incomplete`, `rejected`                                                 | Strong and unusually important                                                                               | Keep                                                                  |
| Semantic authority  | Hypotheses cannot directly satisfy requirements                                      | Strong                                                                                                       | Keep                                                                  |
| Multiview evidence  | Deterministic RGB, silhouette, depth, normal, unlit-albedo, and measurement receipts | Strong source-neutral evidence spine; learned channel qualification remains unfinished                       | Keep and qualify                                                      |
| Model panel         | Exact two-thirds vote across implementation hashes                                   | Reproducible but statistically uncalibrated and correlation-blind                                            | Replace                                                               |
| Open-set behavior   | Abstention and incomplete outcomes                                                   | Correct contract, weak detection policy                                                                      | Strengthen                                                            |
| Cohort formation    | Exact signature/physical bins, then greedy complete-link cosine grouping             | Conservative prototype, not a substitution proof; order-sensitive partition geometry can fragment valid sets | Replace                                                               |
| Human review        | Medoid, visual and metric outliers, boundary, deterministic sample                   | Good defect discovery                                                                                        | Keep as a distinct discovery queue                                    |
| Acceptance audit    | Two percent, maximum eight                                                           | No useful declared risk guarantee                                                                            | Replace                                                               |
| Admission authority | Curator decision is copied into assertions for all cohort members                    | Clear provenance, but overstates what was individually reviewed                                              | Split curator and policy-qualified authority bases                    |
| Catalog durability  | Atomic Git-tracked root, split manifests, and retained compact JSON evidence         | Good identity boundary; bulk payloads remain local and some evidence is still monolithic                     | Shard evidence and add a verified local CAS; defer remote replication |

## Current readiness verdict

The current system is **ready for preflight engineering, but not for production
catalog admission or paid full-corpus inference**. “Ready” here means that the
existing measurement and rendering work should be reused rather than rebuilt. It
does not mean that the prototype voting and cohort path is qualified to create
authority.

| Gate                                       | Finding                                                                                                    | Decision before catalog admission                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Source identity and deterministic evidence | Complete for all 3,441 content identities                                                                  | Reuse; do not rerender unless an implementation or evidence hash changes                                 |
| Leakage isolation                          | A whole-group development/calibration/evaluation split exists                                              | Benchmark missed near-duplicate and containment edges before relying on it                               |
| Semantic authority                         | All 146 commitments seal, but their identity criteria are largely upper-sort templates                     | Red-team and repair identity criteria now, before any admission depends on them                          |
| Intent lexicon                             | 272 entries exist, but none has alternate labels, positive examples, counterexamples, or external mappings | Enrich the non-authoritative lexicon and freeze a review rubric                                          |
| Learned evidence                           | No hypothesis receipts or learned visual-embedding receipts exist in the active catalog root               | Implement and qualify receipts on a pilot; do not launch the full run                                    |
| Admission algorithm                        | Exact-signature voting, one visual vector, greedy cohorts, and a capped-eight audit remain prototypes      | Replace cleanly with calibrated facets, typed unknowns, substitution evidence, and risk-defined auditing |
| Rights                                     | One blanket record claims commercial use and redistribution for all 3,447 source records                   | Block ML/VLM processing and catalog publication until exact license evidence supports each intended use  |
| Recoverability                             | Compact authority can live in Git; bulk evidence and source payloads are ignored and local-only            | Commit the current authority baseline and make one independently verified local backup                   |
| Capacity                                   | The live evidence corpus is larger than the remaining free-space margin                                    | Do not start another full render/inference wave without reclaiming or adding local capacity              |
| Remote CAS                                 | Explicitly deferred                                                                                        | Not a pilot blocker; retain provider-neutral descriptors so it can be added later                        |

### Hard stop: rights are not represented with enough precision

This is a rights-control finding, not legal advice. The exact purchase channel,
purchase date, accompanying licence, and any written custom permission govern each
asset. Those records were not available in the inspected catalog.

Every one of the 3,447 provenance records currently uses the same declaration:
`commercialUsePermitted: true`, `redistributionPermitted: true`, and a generic
“creator-provided commercial rights” note. That declaration is not supported by a
hashed licence document or acquisition record and collapses several legally distinct
uses into two booleans.

That is materially unsafe for the proposed workflow. Synty's current one-time
purchase licence, dated 9 July 2026, permits incorporation into products under the
licensee's direct control but separately prohibits content for game-creation
software, inclusion in generative-AI datasets or development, generative-AI 3D model
creation, third-party source/model uploads for 3D generation, and distribution for
third-party reuse.[^29] Synty's FAQ says a platform owner needs a custom licence and
names Roblox as an example; it distinguishes that from a Roblox creator embedding
assets in one game under direct control.[^30] Unity's current Asset Store terms also
require express provider and/or Unity consent for using assets as AI/ML inputs and
restrict monetization where a product's primary purpose is user-generated-content
creation.[^31]

These current public terms do not establish which terms govern an older purchase.
Synty's current licence explicitly says later changes do not affect already-purchased
licences, and it publishes prior EULA versions.[^29][^32] The correct response is
therefore not to infer either permission or infringement. It is to recover the actual
receipts and licence text for every acquisition origin and obtain written permission
or qualified legal review where the intended Basalt use is not explicit.

Until that is resolved, covered meshes and renders should not be sent to either local
or hosted ML/VLM inference, used as inputs to neural generation or texture adaptation,
or published as a reusable catalog. Running a model locally does not cure a licence
that restricts the use itself. Deterministic integrity checks can continue only
within whatever rights the applicable licence actually grants.

Replace the current rights shape outright with an evidence-bound permission profile
that distinguishes at least:

- commercial end-product use;
- machine analysis and inference;
- model training or fine-tuning;
- third-party processing and upload;
- use inside game-creation software;
- source-asset redistribution;
- compiled or embedded distribution;
- sharing derived preview and measurement evidence.

Each permission needs an exact acquisition source, licence-document hash, effective
date, territorial or product constraints where relevant, and an outcome of
`eligible`, `incomplete`, or `rejected`. Commercial game use must never imply the
other permissions.

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
and distribution shift. A smaller locally hosted model that satisfies the risk
policy is preferable to a nominally stronger but uncalibrated frontier service.

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

An original GLB basename is useful as one such noisy source: names often expose a
noun, component role, numbered alternative, or collision-companion convention that
is expensive to recover from pixels alone. Basalt therefore aggregates every
basename observed for identical bytes and binds a normalized, separately hashed
hint into hypothesis requests. It excludes archive, vendor, and directory identity;
preserves contradictory names; and gives the hint no admission authority. Model
qualification must compare visual-only, basename-only, and combined conditions so
that systematic naming errors and accidental acquisition leakage are measurable.

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
observable features—agreement pattern, retrieval margin, output stability, and
predicted concept depth—against adjudicated data. Source origin is deliberately
excluded. Those values influence a qualification gate; they never directly author
a commitment or assertion.

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
A genuinely unseen future acquisition may be such a shift, but vendor packs in the
current corpus are not valid experimental groups: overlapping content and reused
geometry can cross those packaging boundaries, while shared atlases create broad
style correlations. Consequently:

- compute connected leakage groups from exact content and geometry identity,
  geometry containment, and near-duplicate shape;
- retain shared material payloads as contextual strata, not identity edges—a
  common atlas may connect thousands of otherwise unrelated objects;
- assign each complete leakage group to exactly one of development, calibration,
  or evaluation, never randomly by asset and never by vendor/archive origin;
- report performance by physical, semantic, metric, material, and installation
  strata within the disjoint evaluation partition;
- reserve a genuinely unseen future acquisition for the final distribution-shift
  test, and run a shift detector plus a requalification audit when it arrives;
- route shifted or unsupported evidence to `incomplete` rather than borrowing old
  guarantees.

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
the weakest positive edge, strongest negative edge, hard partition boundary, medoid,
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
  - physical leakage groups and frozen development/calibration/evaluation roles;
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
calibration, unknown concept, shifted evidence, uncertain pair, failed invariant, or
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

The original basename may enter only as a separately hashed, ablatable
weak-supervision input. Directory, archive, vendor, pack, and creator-origin signals
belong only to the provenance and rights ledger; they are not model features, split
keys, admitted assertions, semantic-site signatures, or catalog-resolution inputs.

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

## Immediate next work package

The next milestone is a **catalog-admission qualification pilot**, not a full-corpus
admission run. It has four ordered phases. A failed phase stops the next one; no
manual or model fallback may convert that stop into authority.

### Phase 0: rights and recoverability preflight

1. Reconstruct an acquisition ledger per origin with provider, store, order or
   receipt, acquisition date, applicable licence artifact, and any written custom
   permission. Hash the evidence and evaluate each intended use independently.
2. Replace the two-boolean rights contract with the permission profile above. Mark
   affected identities `incomplete` until the applicable evidence supports catalog
   analysis, Basalt's game-creation use, and the intended distribution boundary.
3. Commit the compact code, registries, policies, and authority manifests as one
   coherent baseline. This protects semantic work but does not protect ignored
   binary payloads.
4. Create and verify an independent local backup of source archives, canonical GLBs,
   and every authority-reachable evidence payload. Remote CAS remains deferred.
5. Restore enough disk headroom for the worst-case pilot outputs plus atomic-write
   duplication. Do not regenerate the existing 43 GB evidence tree merely as a
   preflight ritual.

If rights cannot be cleared for the current packs, the engineering work can proceed
against a small corpus with explicit public-domain, self-authored, or otherwise
compatible rights. The Synty-derived corpus must remain excluded rather than being
silently used as calibration data.

### Phase 1: freeze meaning and risk

1. Red-team all 146 concept commitments. The current necessary and exclusion
   criteria are mostly generic upper-sort templates; replace genuine placeholders
   before any catalog artifact depends on them. Keep labels and examples outside the
   commitment hash.
2. Enrich the separate lexicon with alternate labels, positive examples,
   counterexamples, and external mappings. The current 272 entries have none of
   these, which makes both human calibration and model abstention needlessly
   ambiguous.
3. Author adjudication rubrics for denotation, realization form, state, treatment,
   affordance, placement, artifact health, and pairwise substitutability.
4. Define an `AdmissionRiskPolicy` by risk stratum. It must name defect classes,
   tolerated rates, confidence, random sample design, acceptance number, response to
   a failure, and which outcomes can be policy-qualified rather than directly
   curated.
5. Measure the leakage graph's recall on manually selected exact, near-duplicate,
   containment, and component/whole cases. Freeze group assignments only after this
   test; vendor pack is neither a split key nor an admission feature.

### Phase 2: replace the prototype authority path

Implement the following as one clean break before paying for broad inference:

- factorized hypothesis receipts that bind the prompt/template, evidence selector,
  per-view inputs, adapter and weight hashes, decoding configuration, raw response,
  normalized assertions, abstentions, diagnostics, and resource use;
- channel-specific, per-view embedding receipts and explicit view-disagreement
  evidence rather than one collapsed visual vector;
- calibrated facet predictions, hierarchical prediction sets, open-set/OOD outcomes,
  and source-dependency-aware weak-supervision aggregation;
- separate discovery-review and probability-sampled acceptance-audit artifacts;
- qualification receipts that distinguish direct curator observations from
  policy-qualified claims and never imply that every cohort member was viewed;
- singleton admission before grouping, followed by exact-site pairwise compatibility,
  deterministic signed-graph partitioning, and a whole-set substitution invariant.

SigLIP 2, DINOv3, and OpenShape are reasonable local benchmark candidates for
semantic/appearance, self-supervised visual structure, and native 3D structure
respectively, but none should be hard-coded as authority.[^1][^7][^8] Multiview
fusion should preserve per-view evidence and benchmark learned fusion against mean
pooling; recent CAMFusion results reinforce that naïve view aggregation can leave
substantial performance unused, but the preprint is evidence for an experiment, not
a production dependency.[^33]

### Phase 3: run a bounded qualification pilot

After rights clearance, choose a deterministic sample from leakage groups inside the
1,531-asset low-risk candidate ceiling. Whole-object status remains an adjudicated
semantic condition; measured static/single-part/single-material/bottom-supported
properties do not prove it.

An efficient first experiment is 192 leakage groups:

- 64 development groups for rubric refinement and active error discovery;
- 64 calibration groups sampled independently within the declared low-risk stratum;
- 64 locked evaluation groups sampled independently from the same declared stratum.

All identities in one leakage group stay together. Evaluate visual-only,
basename-only, and combined weak-supervision ablations so a helpful filename channel
cannot mask a broken visual channel. Report facet calibration, OOD rejection,
coverage, individual-admission precision, pairwise substitution precision, and
worst-stratum performance. Freeze the locked evaluation set before tuning.

This 192-group run is a **non-production qualification experiment**. Even zero
defects in 64 approximately independent locked observations gives a conservative
one-sided 95% binomial upper defect bound of about 4.6%. A zero-defect claim below 1%
requires about 299 independent random observations; below 0.5% requires about 598.
Exact finite-population designs may reduce those counts, but the policy must state
the calculation rather than relying on a percentage or a cap.[^24][^25]

### Phase 4: expand selectively

If the pilot passes, enlarge the random evaluation and audit populations until each
declared risk target is met, then admit only qualified low-risk identities. Expand
from whole ground-supported objects to environment realizers and aggregates, then
attachments, and only later to route and assembly components with authored
interfaces and grammars. Each tier requires its own calibration and risk receipt.

The following are deliberately **not prerequisites** for the first pilot:

- remote CAS replication;
- production qualification of TRELLIS.2, Hunyuan3D, or Pixal3D;
- attachment, route-kit, or assembly-kit admission;
- final Roblox import/play verification;
- a second engine adapter;
- durable distributed execution; or
- 100% catalog eligibility.

Neural 3D generation remains an offline response to a qualified catalog gap. It
should consume the eventual admitted semantic/style requirements and return through
the same measurement, rights, hypothesis, review, and admission gates. It must not
be used to compensate for an unqualified catalog pipeline.

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

Select a stratified seed across semantic depths, metric scales, texture/PBR
conditions, whole/component/aggregate cases, attachments, collision companions, and
known failures. An initial budget of several hundred fully adjudicated assets and
several hundred targeted pair judgments is reasonable for a pilot; continue labeling
until calibration intervals and leakage-group-disjoint performance stabilize.

First construct connected physical leakage groups. Exact duplicates, shared
geometry, component/whole containment, and near-duplicate shapes must not cross
split boundaries. Retain shared material payloads for stratification and exposure
reporting without treating atlas membership as object identity. Freeze group
assignments before tuning. Vendor, archive, and original path metadata are not
visible to this process. The
final operational shift test requires a future acquisition that did not influence
prompts, thresholds, adapters, rubrics, or error analysis.

### 3. Benchmark evidence channels

For every candidate backbone, record exact implementation and weights hashes. Measure:

- exact-leaf and ancestor-aware semantic precision/recall;
- prediction-set coverage and set size;
- novelty/OOD discrimination;
- pairwise substitution precision and recall;
- appearance/style retrieval precision;
- latency, peak memory, and cost per asset;
- performance by held-out leakage groups, evidence stratum, and failure category.

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
shifted evidence, and boundary pairs to a compact review queue. Commit the authority
graph and locally rehash every referenced evidence payload after each accepted
batch.

## Acceptance metrics

The admission system is ready to scale when all of the following are measured on
leakage-group-disjoint data and bound in an `AdmissionQualificationReceipt`:

| Metric                        | Required interpretation                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Substitution false-merge rate | Primary quality metric; upper confidence bound below the policy target                                              |
| Semantic precision            | Exact commitment precision at the admitted coverage, reported by concept depth                                      |
| Hierarchical coverage         | Prediction-set coverage and mean set size; no guarantee claimed outside the calibrated population                   |
| Abstention/coverage           | Fraction auto-qualified, reviewed, incomplete, and rejected; high abstention is acceptable initially                |
| Installation precision        | Support/contact/interface correctness for admitted members                                                          |
| Artifact-health recall        | Detection of broken, component, aggregate, collision, animation, and material failures                              |
| Disjoint-group robustness     | Worst physical/evidence stratum and leakage-group-disjoint results, not only micro-averages                         |
| Calibration                   | Reliability by facet, model source, semantic depth, metric scale, material condition, and installation class        |
| Audit risk                    | Exact finite-population acceptance probability and upper defect bound by defect class                               |
| Determinism                   | Identical inputs and implementations emit byte-identical proposals, samples, decisions, and roots                   |
| Stability                     | Adding unrelated content leaves semantic commitments, existing admitted assertions, and unrelated entries unchanged |
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
- pack-neutral multimodal hypothesis inference and source-neutral review,
  calibration, and runtime authority;
- engine-neutral catalog and compiler contracts;
- exact catalog root identity.

### Change before scaling

- replace exact majority voting with factorized, calibrated, dependency-aware
  aggregation;
- add explicit open-set, hierarchy-aware prediction sets and distribution-shift gates;
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
- do use original basenames as a separately hashed, ablatable weak-supervision
  channel while excluding pack, archive, and directory identity;
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

The immediate go/no-go decision is:

1. **Do not start full-corpus catalog inference or admission.**
2. Resolve and encode exact rights for machine analysis, game-creation use, and
   distribution before any model sees the current commercial asset evidence.
3. Checkpoint the compact authority in Git, independently back up the ignored local
   corpus, and create safe disk headroom.
4. Repair semantic identity criteria, enrich the lexicon, define the risk policy,
   and replace the prototype authority path.
5. Run the 192-leakage-group qualification pilot, then expand the random evaluation
   and audit only as the measured risk requires.

The best durable admission baseline is not “three models plus a sample.” It is:

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

[^29]: Synty Studios, “[One Time Purchase Licence](https://syntystore.com/pages/one-time-purchase-licence),” current text dated 9 July 2026.

[^30]: Synty Studios, “[Frequently Asked Questions: Metaverse and Roblox licensing](https://syntystore.com/community/faq),” accessed 13 September 2026.

[^31]: Unity Technologies, “[Asset Store Terms of Service and EULA](https://unity.com/legal/as-terms),” sections 3.8 and Appendix 1 section 2.2.1.1, accessed 13 September 2026.

[^32]: Synty Studios, “[EULA Version History](https://syntystore.com/pages/eula-versions-history),” accessed 13 September 2026.

[^33]: Fangyu Li et al., “[CAMFusion: End-to-End Multiview Fusion for Robust 3D Object Classification](https://arxiv.org/abs/2604.12551),” preprint, 2026.
