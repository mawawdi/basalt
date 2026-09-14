# Basalt Catalog Search and Architecture Assessment

Basalt should retain the move to open-vocabulary search. The available evidence supports correcting the evaluation, the evidence supplied to models, and the amount of work required before an asset becomes searchable. It does not justify another wholesale taxonomy redesign, abandoning the starting corpus, or replacing the world compiler with an external generator.

The model decision is less settled. Both Qwen3-VL 8B and 32B retrieve the designated asset first for all twelve selection queries, but the search collection contains only eight assets. The recorded SigLIP ranking achieves the same result without the lexical contribution. The reported 12.5-percentage-point validation improvement is one additional positive match, and metadata generation alone takes 3.27 times as long on 32B. These are useful development results; they do not establish that 32B should enrich every future asset.[^2][^3][^4]

The recommended pivot is therefore bounded: **keep searchable descriptions separate from authoritative construction claims; give modular-kit interpretation its required assembly context; repair the benchmark and model-facing evidence; and choose enrichment and validation models independently.** Isolated-mesh description cannot be the universal route to construction readiness. Use a small world-generation extension to decide which stronger catalog guarantees are actually needed. The earlier outdoor generation remains a concrete capability to preserve.[^1][^22]

> **Status:** Non-authoritative research assessment and proposed experiments. This document does not change model selection, benchmark policy, catalog authority, or the implemented architecture.

The [world construction and refinement assessment](world-construction-and-refinement.md) follows the catalog recommendations through a large-world request and a missing observation tower. It identifies additional construction and feedback capabilities required even when catalog discovery and kit interpretation work correctly.

## Decision scope

| Decision | Recommendation | Basis |
| --- | --- | --- |
| Open-vocabulary search versus a universal asset classifier | Keep search | The earlier score formulation was unsuitable for novelty; the current retrieval path produces useful results and follows an established implementation pattern. |
| 32B for all metadata | Keep provisional; do not infer a general win | No observed retrieval improvement, one additional positive validation, coupled writer/validator changes, and a higher ingestion cost. |
| Exact noun matching | Replace as the main recognition criterion | It rejects useful paraphrases while failing to separate visible identity from functional role. |
| Identifying every construction role from one isolated asset | Drop this requirement; interpret ambiguous modules in kit context | Intended role and joining rules may be absent from the individual mesh, regardless of model size. |
| Deterministic semantic evaluation framework | Keep the rubric small and authored | Deterministic scoring needs reliable judgments; an elaborate phrase-matching system would recreate the original problem. |
| Twelve VLM views and complete enrichment for every item | Compare with a compact route | The current fixed workload has not been shown necessary for ordinary search. |
| DINO depth features as mandatory search input | Separate from ordinary text search; qualify for its own use | The tested text queries do not use shape ranking, while the current index requires shape evidence. |
| Semantic kernel and geometric authority | Retain | A description cannot establish a usable opening, modular interface, or target-engine result. |
| Starting 3,441 assets | Keep as content and diagnostic coverage | Neither perfection of the whole corpus nor its removal is supported as the next prerequisite. |
| Broader generation architecture | Exercise a bounded extension first | Basalt has a prior outdoor result; structured composition remains a separate capability to demonstrate. |

The table distinguishes recommendations from current implementation. In particular, allowing cheaper search before full enrichment would require a deliberate change to the current index contract. Pending or partially described assets would still need the existing authority gates before compilation.

## Evidence state

The latest operational account, supplied September 14, 2026, states that no Modal job is running, the full corpus has not launched, the holdout has not run, and 32B is provisionally preferred. This supersedes the earlier account of a running corpus job. The local records contain baseline and challenger selection evidence, while the selected-model metadata and committed search manifest are absent. Local artifacts are consistent with that account; they are not a live cloud-status measurement.[^1][^2]

The baseline metadata set contains 24 distinct development/selection assets in both visual-only and combined modes, giving 48 receipts. The challenger set contains eight selection assets in combined mode. Both selection search indexes contain eight documents. The tracked benchmark specifies sixteen development assets, eight selection assets, and eight holdout assets, with twelve selection queries and sixteen selection validation pairs.[^2][^3]

The earlier outdoor images show terrain, water, sandy shoreline, trees, grass, rocks, and smaller vegetation. They support a prior generation result worth retaining through the rewrite. They do not establish the present implementation's repeated-run quality, arbitrary instruction following, city generation, or navigation correctness. Catalog evaluation and world-generation evaluation answer different questions.[^1]

## Selection results

### Retrieval and recognition

| Selection measure | 8B | 32B | Interpretation |
| --- | ---: | ---: | --- |
| Assets in search index | 8 | 8 | A small heterogeneous collection. |
| Queries with designated target at rank one | 12/12 | 12/12 | Successful local ranking; no measured model difference. |
| Target ranked first by the recorded embedding branch | 12/12 | 12/12 | SigLIP alone suffices for these particular rankings. |
| Target ranked first by the lexical branch | 11/12 | 12/12 | One lexical improvement, with no resulting hybrid-ranking gain. |
| Exact accepted noun phrases | 4/8 | 4/8 | Both encounter the same brittle scoring method. |
| Positive validation matches | 5/8 | 6/8 | The difference is the broken-stair case. |
| Matches on supplied negative pairs | 0/8 | 0/8 | No observed false acceptance on these eight pairs. |

The retrieval and validation numbers are reproduced from the selection evidence and the current scoring definitions. The successful final challenger metadata batch has eight schema-valid receipts. That is an execution-completion result, distinct from eight correct asset descriptions.[^2][^3]

A filename-only diagnostic supplies another useful comparison. Applying the current tokenizer and BM25 formula to only the source-basename field, on the unchanged eight selection documents, gives seven rank-one hits, eight queries with any relevant hit, and MRR 0.625. It misses the bridge wording and several descriptive paraphrases. Thus the richer retrieval path adds value over this simple name baseline; the results do not isolate an added benefit from 32B metadata.[^4]

| Retrieval route on the same eight documents | Rank-one hits | MRR | Evidence |
| --- | ---: | ---: | --- |
| Source names only | 7/12 | 0.625 | Offline BM25 recomputation from stored name tokens. |
| SigLIP image/text ranking | 12/12 | 1.000 | Stored embedding ranks. |
| Names and 8B metadata, lexical ranking | 11/12 | 0.958 | Stored lexical ranks; one target is second. |
| Hybrid with 8B metadata | 12/12 | 1.000 | Stored fused ranks. |
| Hybrid with 32B metadata | 12/12 | 1.000 | Stored fused ranks. |

These are component comparisons within an easy collection, not a replacement benchmark. Several queries target the same asset. The current evidence cannot establish resistance to hundreds of similar bridges, stairs, walls, and near-duplicate props, nor retrieval of several different acceptable alternatives. Standard retrieval evaluation considers the collection, information needs, and relevance judgments together; changing the collection changes the task.[^10]

The correct conclusion is that search is promising and the expensive enrichment layer still needs an attributable benefit. Discarding metadata because SigLIP succeeds on eight objects would be as premature as requiring 32B because it describes one case better. Metadata may help difficult paraphrases, inspection, filtering, and later requirement interpretation even when it adds no rank-one improvement here.

### Negative cases and uncertainty

The selection negatives include bones against an air conditioner, a bridge against a monitor, mushrooms against a desktop computer, and a sword against a rock pile. These test gross category rejection. They provide little evidence about the errors most likely among search results: a similar bridge with the wrong material, a single step instead of a stair flight, the wrong handed corner, or a building with an unusable entrance.[^3]

The benchmark also has no expected `uncertain` outcome: its validation gold permits only `match` and `mismatch`, and every retrieval query must have at least one relevant source. It therefore does not directly test a correct decision that no adequate candidate exists, or that a requested property cannot be established from the supplied evidence. A validator intended to preserve uncertainty needs such cases.[^3]

Zero observed errors should remain a count with a denominator. Even under independent representative sampling, zero failures in eight trials gives a one-sided 95% binomial upper bound of approximately 31.2% on the failure probability. These cases are deliberately selected, so that calculation is only an illustration of how little eight observations can constrain a rate; it is not a confidence claim about Basalt's production errors.[^13]

Research on vision-language evaluation supplies a relevant warning: distractors can make a benchmark solvable through shortcuts without testing the intended distinction. SugarCrepe addresses this with plausible compositional negatives. Its results do not measure Qwen or Basalt, but the experimental lesson applies: challenge the specific object, attribute, count, or relationship that matters while keeping the rest of the request similar.[^12]

### Model attribution

The comparison changes both the metadata writer and the validator. Each validator receives the metadata produced by its corresponding model, alongside the renders and measured facts. Consequently, a better verdict could result from better metadata, a better validator, their interaction, or a changed interpretation of the gold requirement.[^5]

The broken-stair case is the only positive verdict that changes. Both models still reject the designated wall-module and greatsword positives. This supports investigating the stair interpretation; it does not isolate a reason to use 32B for every ingestion task. A controlled comparison should hold metadata fixed while comparing validators, and hold the validator fixed while comparing metadata writers.

The current policy selects the challenger if any of noun accuracy, positive validation, or MRR improves by at least five percentage points, negative false matches do not increase, and recorded time stays within three times the baseline. The observed values satisfy that rule. However, with eight positives, one changed answer is already 12.5 points; passing the rule is not evidence of a stable population improvement. The rule also allows a gain on one quality measure without an explicit non-regression floor on the other two.[^3]

## Evidence and label problems

### Physical dimensions

The proposed simplification described a VLM receiving a name, dimensions, and four views. The current metadata worker instead supplies twelve RGB views and optional basenames. Its request binds a measurement hash, but the metadata prompt does not contain the dimensions themselves. Provenance binding is useful for traceability; it does not make the bound information visible to the model.[^5]

This matters because the output includes `scaleClass`. Both models describe the approximately 5.06 by 4.92 by 5.06-meter cylindrical asset as a `small_prop`. An isolated camera-normalized render cannot resolve that scale reliably, and the metadata model was not given the numbers that could challenge its assumption.[^5][^6]

Validation does receive measured bounds, but as Q32.32 integers. In the greatsword case, the 32B result explicitly treats that encoding as arbitrary units and says real-world scale cannot be established. Decoding the stored bounds gives dimensions of approximately 0.307 by 1.580 by 0.052 meters. Those bounds alone do not establish the precise sword subtype, but the validator's assertion that no calibrated size information exists is incorrect.[^6]

**Recommendation:** keep the exact numeric representation for solvers and present clearly labeled decimal meters to models. Provide deterministic dimension summaries where they are relevant. Specify axis conventions and avoid treating an axis-aligned bound as a semantic measurement such as walking width or blade length when orientation or occlusion matters. Re-evaluate the affected cases before attributing their failures to model capacity.

### Visible appearance and intended role

The round-wall source is named `SM_Env_Wall_Round_01_Texture.glb`. Its gold nouns are “cylindrical wall module” and “round wall section,” while its gold defect note acknowledges that the rendered geometry reads as a closed cylinder. Both models describe a barrel-like object and reject the wall-module query. The isolated render indeed shows a closed, faceted cylinder with a reddish texture and dark emblem.[^6]

Neither the filename nor that appearance settles intended construction use. A cylindrical tower or wall component need not resemble a planar wall, while a closed cylindrical silhouette does not prove a storage container. The models overstate what appearance proves; the benchmark also needs to explain which evidence authorizes its intended-role label.

This case should carry separate judgments: a visible description, an attributed source-role hint, and the evidence needed to use it as a wall component. If intended kit membership matters, author declarations, compatible dimensions, interfaces, or demonstrated assembly can support it. A visual benchmark should permit a descriptive answer or uncertainty about function without silently replacing construction-role evaluation with filename imitation.

The distinction is central to Basalt's original concern. Some catalog disagreements are not recognition errors at all. They arise because the same asset has an appearance, a source author's intended role, a potential use in a particular world, and a set of verified capabilities. Those can overlap without being identical.

### Modular kits and missing context

The stronger limitation is an input problem. Some modular pieces have recognizable features, so it would be inaccurate to claim that models can never identify a wall or corner module. However, a generic slab can serve as a wall panel, floor, roof, or platform under different assembly conventions. Its geometry does not uniquely determine the author's intended role. This is an identifiability argument, not a measured failure rate: when different intended roles produce the same isolated evidence, no inference procedure can always recover the intended one from that evidence alone. Additional views or a larger model can improve guesses without supplying the missing convention.

The current metadata prompt instructs the model that “visual evidence wins” over source basenames. That is too broad for unobservable construction roles. A visible contradiction can challenge a name, but a generic silhouette cannot disprove a source author's intended use. The cylindrical wall example should retain both its barrel-like appearance and its attributed wall-role hint until contextual evidence resolves the distinction. A source name is useful evidence of intent; it still does not establish mating interfaces, substitutability, or compiler eligibility.[^5][^6][^22]

An established procedural workflow makes these inputs explicit. SideFX's Building Generator Utility operates on named modules such as walls and corners, and accepts authored module dimensions. Its documentation explains that automatic geometry bounds may differ from the intended module extent, using protruding flagpoles as an example. This supports reusing a pattern of explicit assembly metadata; it does not establish that a model can recover that metadata automatically.[^23]

**Recommendation:** retain per-asset measurement and searchable descriptions, and add a bounded interpretation workflow for candidate kits using the existing `assembly_kit` declaration as its target. That contract already expresses providers, roles, interfaces, allowed mates, transitions, and topology. The missing research task is obtaining defensible declarations from source context, rather than designing another universal taxonomy.[^24]

| Scope | Useful evidence | Result and limit |
| --- | --- | --- |
| Individual asset | Mesh measurements, renders, source basename | Searchable appearance and attributed hints; intended construction role may remain unknown. |
| Candidate kit | Source-authored documentation, prefabs or sample assemblies with transforms, relevant names, component groups, grid/pivot and interface measurements | Proposed component roles and assembly rules tied to evidence. Co-membership alone does not prove compatibility. |
| Particular assembly | Admitted providers and rules, requested envelope, measured joints and clearance | A checked construction for the requested use; visual recognition alone cannot establish this result. |

Processing context does not require submitting an entire vendor pack in one enormous model call. Start with an explicit source assembly or a bounded proposed group, preserve component identifiers and relative transforms, inspect representative assemblies and ambiguous subgroups, and check the proposed interfaces. Source organization can help locate relevant evidence; a shared folder must never decide compatibility or substitution membership. Geometry can constrain a hypothesis without proving the original design intent. If documentation or usable sample scenes do not exist, limited author input may be necessary; an arbitrary unlabeled pile cannot be promised automatic recovery.

This is a proposed workflow change. The current visual contract explicitly excludes pack, archive, and directory identities from model and ranking inputs. Introducing source-group context to a separate kit interpretation stage therefore needs deliberate adoption into that contract. It must preserve the boundary between provenance hints, model proposals, authored commitments, and measured assembly evidence. No such policy change is made by this assessment.[^22]

The process objective also needs to be explicit. If success means inferring complete construction semantics independently for every isolated mesh, requiring kit context contradicts that objective, and the objective should change. If success means scalable discovery and usable world construction, interpreting a kit once and reusing its admitted assembly rules is a coherent approach. Roles belong to the relevant assembly context; the same mesh need not acquire one universal construction noun. Reuse amortizes interpretation, but new parts and new use requirements still need their relevant checks.

For newly generated kits, preserve the request, component specification, and proposed assembly relationships from the start. These record intent and avoid unnecessary later reconstruction. The returned geometry must still be checked against them. A planner having requested a kit does not prove that the generator produced a usable one.

The immediate test should use one existing development kit with available source context. Compare isolated views, views plus names, and views plus the relevant assembly context while holding the model fixed. Record role uncertainty and author effort, then attempt a different assembly or dimension using the proposed rules. Check joints, gaps, orientation, openings, and required traversal. Successful noun prediction is insufficient; the evidence should show that context enables a usable new arrangement. This test should precede claiming that a more expensive metadata model solves modular-kit ingestion.

### Parts, aggregates, and intentional damage

For the mushroom asset, 32B identifies a cluster and records multiple visible objects. The 8B caption also describes three mushrooms, but its object-type field is singular and its multi-object flag is false. The issue is internal consistency across fields, not an inability to see mushrooms. That distinction matters when a request asks for one mushroom or a cluster and should be diagnosed separately from phrase equality.[^2]

For the broken stair asset, 32B records a component and incomplete geometry, while 8B records a complete non-component but also reports incomplete geometry in its notes. Both return questionable realization hints. The reference expects a structural component and lists no visible defect. Deliberate damage, being a partial construction element, and having a defective mesh are different properties; a ruin component can be complete for its intended design.[^2][^3]

The 32B explanation additionally asserts non-manifold geometry from the renders. Such topology should be checked from mesh data. A convincing explanation is not a substitute for measurement, and a correct `match` verdict can coexist with unsupported supporting claims.

**Recommendation:** define part-related terms narrowly before making them scored obligations. Distinguish a mesh's connected components, multiple depicted objects, an authored assembly role, and intentionally broken appearance. Reuse existing measurements for computable properties. Permit uncertainty for roles that require missing assembly context.

### Schema validity and semantic quality

The metadata schema has nineteen top-level fields, including overlapping caption, description, category, synonym, tag, environment, use-case, style, support, realization, and quality outputs. Every observation must produce a value or an abstention. The current prompt gives general guidance but does not explain the meanings of all domain-specific enum choices. Structured decoding constrains the output format; it does not supply those definitions.[^5]

Several stored validation reasons end in unfinished phrases despite being schema-valid. Some array items are explanations where short constraint identifiers would be easier to interpret. A broad constrained schema can therefore yield valid but verbose, inconsistent, or incomplete evidence. vLLM's own documentation recommends explaining the schema and how fields should be populated; JSON conformance alone addresses a different problem.[^16]

Retain the recovery improvements for truncated JSON, hashes, and checkpoints. Then test a compact factual description plus explicitly defined fields that have an actual consumer. Fields such as exact scale, topology, and texture-file presence should come from appropriate measurements; speculative use cases and environments need not be mandatory ingestion output. Multimodal hallucination is a documented evaluation problem, which is why unsupported claims should be scored separately from fluency and serialization success.[^18]

## Operating cost and execution

The recorded time comparison combines one metadata call and two validation calls per asset. Its ratio is approximately 2.00, but ingestion and query-time validation are different workloads.

| Recorded workload | 8B | 32B | 32B / 8B |
| --- | ---: | ---: | ---: |
| Metadata time for eight assets | 439.161 s | 1,434.663 s | 3.27 |
| Metadata time per asset | 54.895 s | 179.333 s | 3.27 |
| Validation time for sixteen pairs | 789.358 s | 1,019.423 s | 1.29 |
| Metadata plus two validations, per asset | 153.565 s | 306.761 s | 2.00 |
| Metadata GPU charge illustration, per asset | $0.0298 | $0.1245 | 4.18 |
| Combined GPU charge illustration, per asset | $0.0832 | $0.2129 | 2.56 |

The first four rows use retained receipt timings. The last two apply Modal's September 14, 2026 published GPU-task rates: $0.000542 per second for the declared L40S baseline and $0.000694 for the declared A100 80 GB challenger. They are calculated operating illustrations, not bills or full cost estimates.[^2][^17]

The worker's `gpuMilliseconds` is elapsed wall time around per-item preparation and generation, not a hardware utilization counter. Model initialization occurs before that timer. The successful metadata set also excludes abandoned initialization attempts and superseded failed outputs. CPU, memory, storage, deployment modifiers, and repeated initialization therefore require separate accounting before claiming an all-in cost advantage.[^5]

A linear extrapolation of these eight metadata timings gives approximately 52.5 hours for 8B and 171.4 hours for 32B across 3,441 assets on sequential execution, before startup and other stages. This is not a corpus forecast: asset difficulty, output length, batching, and worker changes can alter it substantially. It shows why an observed per-asset cost should replace an assumption that the full run will merely take a few hours.

The infrastructure corrections are reasonable. The current context bound is 8,192 tokens, the output allowance is 2,048 tokens, and all eight final challenger metadata receipts are valid. A failed initialization and a truncated generation are distinct failures; neither establishes that an eight-asset checkpoint is the wrong unit of recovery.[^1][^5]

The present Modal wrapper uses single-use containers, and the worker loads the model within each job. Separating durable checkpoint shards from a warm model executor is already named in the roadmap. That is an appropriate bounded optimization once the experiment is stable; it does not require weakening hashes, losing per-item receipts, or increasing the authorized concurrency.[^5][^22]

The model recommendation follows the workload: retain 8B as the lower-cost bulk-enrichment reference and evaluate 32B for difficult descriptions or requirement checks. A cascade is itself an experiment; it is useful only if its escalation rule catches important failures without invoking the expensive model almost everywhere. If reliable 32B enrichment saves enough review or repair work, uniform 32B can still be the better choice. The current selection result does not settle that tradeoff.

## The earlier classifier and the present direction

The retired worker confirms the problematic formulation. It normalizes image/text features, divides cosine similarities by a fixed 0.07, applies softmax within assertion-kind groups, and derives novelty from one minus the largest denotation score. The reported 146-concept label set and collapse counts belong to the earlier operational account; the source establishes the transformation, not every reported aggregate.[^1][^7]

With equal scores over 146 options, the resulting novelty would be about 99.315%. The reported median of 98.36% depends on the actual scores and is not mechanically fixed by the number of labels. Nevertheless, the transformation measures competition among supplied labels, not the probability that an asset is a new concept. Missing labels and mixing objects with spaces, boundaries, and substances make a forced decision especially unhelpful.

SigLIP was trained with a pairwise sigmoid objective, and SigLIP 2 is evaluated for both classification and image/text retrieval. That does not make arbitrary candidate lists calibrated classifiers, but it also does not mean RGB embeddings should be restricted to style matching after identity is known. The current selection results demonstrate useful object retrieval from those embeddings.[^8]

Replacing softmax with a sigmoid and keeping the same novelty interpretation would not repair the task. Likewise, replacing exact equality with fuzzy matching against all semantic leaves would recreate the global classification problem in another form. Search can retain unfamiliar descriptions and rank candidates before any new semantic commitment is necessary.

DINOv3 needs similar discipline. Basalt applies it to normalized depth images converted to RGB and averages global view vectors. The DINOv3 paper demonstrates visual features used with downstream methods for depth and geometry tasks; it does not establish that this exact normalized-depth descriptor is a calibrated shape distance or substitution test.[^5][^15]

Keep that route as a candidate for reference similarity and review proposals. Evaluate it on same-shape/different-style examples, different-shape/similar-silhouette examples, altered dimensions, and incompatible components. Geometric compatibility remains a measured claim. The current text-search experiment supplies no direct evidence that mandatory DINO processing improves text retrieval.

## A smaller division of responsibilities

Basalt needs four distinct answers about an asset. The same model should not be expected to turn all four into authoritative facts during ingestion.

| Question | Suitable evidence | Decision produced |
| --- | --- | --- |
| What does this asset visibly depict? | Renders, concise descriptions, attributed source hints | Searchable hypotheses about objects and appearance. |
| Is it a useful candidate for this request? | Lexical/visual ranking, metric filters, a focused visual check when needed | A shortlist, rejection, or unresolved candidate. |
| Can it perform this construction or gameplay role? | Measured geometry, authored interfaces and roles, relevant solver or simulation results | Requirement-specific eligibility. |
| Did the completed world satisfy the requested experience? | Realized layout, clause-level checks, visual review, creator-run engine evidence | A world-level result and specific remaining defects. |

The existing architecture already separates descriptive search from compiler authority. Preserve that separation. The proposed simplification concerns how much evidence is demanded at each point and how it is evaluated; it does not authorize search metadata to bypass catalog admission.[^22]

### Search access and enrichment scheduling

NVIDIA USD Search is the closest examined implementation pattern for discovery: generated asset descriptions, keyword search, SigLIP2 retrieval, and optional query-specific validation. Its availability supports reuse of established indexing and ranking patterns. It is not evidence that Basalt needs its full cloud stack, every metadata field, or an exhaustive asset ontology.[^9]

The current Basalt index requires complete metadata and both image/text and shape embeddings. That makes ordinary search depend on a shape route it may not use, as well as successful completion of the metadata batch. At scale, a useful asset should not become undiscoverable solely because a speculative environment label or unrelated shape descriptor is unfinished.[^4]

**Proposed bounded architecture change:** permit search over an explicitly defined available-evidence set, with optional enrichment added as it completes. Preserve exact source identity, rights, measurements, and provenance for any evidence that is present. Define each search route's actual prerequisites and represent missing evidence honestly. This is a change to the current index contract, not a claim that it already behaves this way.

Compare three routes before deciding how much metadata to generate: names plus existing measurements; SigLIP plus lexical names; and the same retrieval with compact VLM descriptions. Where descriptions materially improve results or review efficiency, generate them eagerly or cache them after first demand. Ordinary search should not require DINO unless the chosen operation uses reference-shape similarity.

This proposal should stay small. It does not require distributed scheduling, a new agent framework, or an automatic semantic-admission service. An explicit distinction between searchable evidence and accepted compiler providers is sufficient to test whether enrichment can become less expensive.

### Evaluation rubric

Exact string equality is an inadequate main score for free-form descriptions. A replacement should separately judge coarse identity, required distinctions, unsupported claims, and useful uncertainty. Human-authored reference judgments on a small fixed set can establish those meanings; deterministic aggregation then makes the scores reproducible.

| Description pair | Appropriate treatment |
| --- | --- |
| `wooden garden bridge` / `bridge` | Usually compatible at broad object identity; separately score requested material, shape, scale, or context. |
| `rock cluster` / `rock pile` | Usually compatible as an aggregate description; inspect any distinction in count or arrangement that the task requires. |
| `mushroom` / `mushroom cluster` | Broad identity can agree while multiplicity fails. Do not erase the count requirement. |
| `stair tread` / `stair segment` | Potentially different parts or levels of assembly. Inspect the geometry and define the intended task. |
| `house` / `farmhouse` | A broad type may be correct while a requested subtype or appearance remains unfulfilled. |
| `tile` / `floor tile` | Broad identity can agree; suitability as a walking surface needs separate evidence. |
| `barrel-like cylinder` / `wall module` | Appearance and intended role may differ. Attribute source intent and require suitable role evidence. |

Do not solve these examples by continually extending a universal synonym list or introducing a semantic matching model as unquestioned gold. A small set of accepted paraphrases is useful for repeatable cases, but previously unseen wording may need adjudication. If an LLM assists scoring, compare its judgments with independent authored judgments and prevent it from silently defining its own success criterion.

The benchmark should also measure claims beyond the noun when those claims affect use. Correctly naming a mushroom cluster while inventing a socket, calling intentional damage a defect, or asserting unmeasured collision behavior should remain visible failures. Conversely, an honest abstention about an unsupported function should not be punished as a failure to recognize an obvious object.

Three current metric definitions need clearer interpretation. `retrievalRecallAtFive` counts queries with at least one designated hit; it is query success at five, not recall of all relevant assets. The open-vocabulary gate counts an observed noun on an out-of-kernel example, without independently establishing that noun's correctness. The `validationPrecision` gate combines positive acceptance and a zero-false-match requirement; it is not a direct estimate of production precision.[^3]

Those distinctions affect decisions. Report rank-one success, success within the available inspection budget, relevant alternatives when needed, and false acceptance among actual returned candidates. Keep positive acceptance, negative rejection, and uncertainty as separate counts. The fraction of genuine matches among production candidates can differ sharply from the balanced positive/negative fixture.

## A bounded qualification experiment

The next experiment should resolve model and workflow choices without turning evaluation into a new product. Existing selection examples can diagnose the formulation. Once their outputs inform rubric or prompt changes, they should be described as development evidence for the revised procedure, rather than an untouched comparison.

### Evidence and rubric repair

Give models usable metric summaries and define the retained enum meanings. Reconcile the round-wall, greatsword, and stair judgments with the evidence each stage is allowed to use. Score a visible identity separately from construction-role eligibility, and include expected uncertainty for missing evidence. Retain the old result counts in the research record; do not relabel an already observed run as a fresh benchmark pass.

Before additional inference, write compact acceptance sheets for development examples: what must be recognized, what distinctions matter, which facts are measured, and which claims should remain unresolved. One independent review of disputed examples can be more informative than another increase in parameter count. Deterministic scores become useful after the expected judgments are defensible. Keep isolated-asset description and contextual kit interpretation as separate evaluation tasks: do not require a visual-only answer to reproduce an intended role available only in source context. For generalization to unfamiliar kits, split evaluation by kit rather than scattering sibling pieces across development and holdout.

### Retrieval comparison

Use a fixed candidate collection containing realistic confusers from the existing corpus. A few hundred candidates is a reasonable bounded engineering pilot, not a statistical sufficiency claim. Include several assets from the same broad object type, similar silhouettes, varied styles, whole/component alternatives, and misleading or unhelpful names. Keep designated holdout groups out of development comparisons.

Compare names-only search, SigLIP retrieval, the combination, and compact-metadata enrichment against the same collection and queries. Keep embedding outputs and ranking settings fixed while measuring the added value of the description writer. There is no need to regenerate unchanged renders or embeddings for each metadata-model comparison. The BEIR results support retaining strong lexical baselines, while their text-retrieval outcomes should not be presented as a benchmark of 3D assets.[^11]

Judge pooled high-ranking results so that an unlisted but suitable alternative is not counted as a false retrieval. Include requests with no adequate match and requirements that remain unknown. Use both literal asset descriptions and creator-like functional requests; filenames are a valid available feature, but success on name-derived queries cannot establish performance when names are absent or misleading.

### Description and validator comparison

First compare 8B and 32B descriptions with the same renders, names, dimensional summaries, field definitions, and rubric. Then compare validators against the same fixed candidate metadata and requirements. A full cross-product is unnecessary until there is an effect worth explaining; one controlled comparison at a time can isolate whether the benefit comes from the writer or the validator.

Retain simple wrong-category negatives, then add difficult cases differing in one required attribute, count, or role. A candidate's positive visual resemblance should not conceal an unmet dimension or an unknown opening. Use deterministic checks for those properties when available; do not ask a VLM to rediscover a known metric result.

Compare a representative four-view description route with the twelve-view reference on development cases. Escalate based on observed ambiguity, poor evidence coverage, field disagreement, or importance of the requested operation. Four views are a cost-saving hypothesis, not an established optimum. Preserve twelve-view evidence when additional views measurably resolve a consequential ambiguity.

Measure metadata time, validation time, failures, initialization, and actual billed resources separately. A capped output can encourage concision, but should not force loss of required facts. Keep small checkpoint shards and per-item completion; optimize warm execution only after the selected input/output contract is stable.

### Holdout and launch decision

Freeze the candidate collection, queries, rubric, model-facing evidence, model configuration, and decision rule before the final holdout. The existing eight holdout assets can provide an untouched acceptance check if their outputs have not influenced development. They cannot prove arbitrary-prompt reliability or a million-asset error rate. Adaptive reuse of held-out results can overfit even without model-weight training.[^14]

If a rubric error is discovered after the holdout result is seen, correct the research record and treat that result as consumed. Use fresh independent examples for another unbiased assessment. A development or selection score recomputed under a better rubric is still useful; it simply has a different evidential status.

Choose 32B for bulk metadata only if it improves the operations that consume metadata enough to justify the measured cost. If the advantage is limited to validation, use the more capable validator where it helps and retain the cheaper writer. If neither writer improves realistic retrieval or review enough, reduce eager enrichment. None of these outcomes requires returning to forced classification.

After a stable pilot, a full-corpus enrichment run can be a useful next step. Its purpose is searchable coverage and collection of failures. It must not convert all generated descriptions into accepted semantics or create a requirement that every source be usable. Unexpected systematic errors during that run should stop the affected route and trigger a focused evidence review.

## World-generation implications

### The outdoor baseline and structured composition

The prior outdoor result matters because it gives Basalt a demonstrated behavior to preserve. Its existence argues against treating the present catalog snapshot as proof that the project has never delivered a world. It does not resolve the next capability: producing connected built environments and maintaining their constraints during edits.[^1]

An urban scene couples road access, lot boundaries, building footprints, entrances, circulation, and component interfaces. Basalt already represents several of these concepts and has deterministic realization machinery. The next question is whether the proposal path, available providers, and solvers jointly realize an actual request. Another taxonomy expansion should follow a demonstrated representational gap, rather than precede that test.[^22]

A useful parallel milestone is the outdoor scene extended with one street, three buildings, usable entrances, and a protected natural area. Start with known geometry and a requested edit such as widening the street. Then replace the simple geometry with real assets or a small authored kit. This distinguishes a layout problem from provider availability, interface compatibility, appearance, or import loss.

The asset qualification experiment can serve this milestone directly. Alongside ordinary props, include the actual stair, door, corner, wall, or bridge components needed for the scene. First qualify one relevant modular kit with its source context and demonstrate a new assembly from it. Evaluate successful selection and verified use together. A caption benchmark should not become the sole definition of progress toward world generation.

### Starting assets and consistency at scale

The starting corpus has three useful roles: immediate reusable content, a source of difficult evidence cases, and material for construction experiments. Those roles need different quality levels. A small set of frequently used providers and complete kits deserves careful functional verification; the rest of the corpus can remain searchable with explicit limitations.

Batch review is appropriate for redundant descriptions and repeated construction patterns. Approval of a representative image does not establish that every nearby asset is interchangeable. Members used in an assembly still need the relevant measured bounds, interfaces, topology, materials, and contact evidence. DINO similarity and naming patterns can organize review without deciding substitution membership.

For millions of assets, consistency should center on stable content identity, consistent units and frames, attributed observations, and local requirement checks. Descriptions can improve without changing the geometry's identity. A new semantic commitment is warranted when it expresses a distinction that affects use or reasoning; every new adjective or noun paraphrase need not become a new reviewed leaf.

The current semantic admission rules remain authoritative. If a real scene is blocked solely by a semantic distinction that no solver or evaluator consumes, that is evidence for a narrow contract change. Until such a case is demonstrated, there is no need to redesign the kernel again.

A planner requesting a new asset provides valuable intent, but the returned object still needs verification. A request for a two-player bridge cannot establish the generated deck's usable width or connectivity. Cache the accepted artifact with the evidence relevant to its use. The number of early worlds needed to populate useful coverage cannot be inferred as a fixed cache-warmup count.

### Existing generation implementations

The earlier reuse assessment remains applicable, with a more specific adoption question at each level. Search qualification does not establish that Basalt should replace its outdoor generation pipeline. It identifies where commodity discovery can support the existing compiler.[^1]

| Required capability | Relevant implementation | Appropriate Basalt use |
| --- | --- | --- |
| Asset discovery and descriptive metadata | NVIDIA USD Search | Reuse indexing, retrieval, and inspection patterns; adapt to Basalt identities and evidence. |
| Room and interior composition | Holodeck; SceneSmith | Compare an actual room-planning or furnishing failure against released implementations. |
| Procedural constrained arrangement | Infinigen Indoors | Study or adapt relevant constraints and solving methods, accounting for its Blender-based environment. |
| Completing or jointly generating parts | HoloPart; PartCrafter | Offline workers for a specific component or editing task, followed by measurement and finishing. |
| Connected streets, lots, and gameplay routes | Current Basalt plans and solvers, plus a targeted implementation search when needed | Establish the exact missing operation before selecting or building another subsystem. |

Holodeck and SceneSmith provide indoor generation implementations. Infinigen Indoors adds a released procedural arrangement approach with a constraint language and solver. These establish useful reusable components; they do not, by themselves, establish a complete editable city planner. Basalt's restriction on whole-world Blender dependence makes the adaptation boundary relevant.[^19][^20][^22]

HoloPart completes segmented geometry, while PartCrafter generates coordinated separate meshes. They can help supply a building or landmark after a whole concept has been established. Separate meshes do not automatically supply repeatable module dimensions, mating interfaces, or a recipe for extending a bridge. Where exact structure matters, the layout and functional envelope must survive generation and be checked afterward.[^21]

Whole-world providers remain possible alternative realization routes, subject to the output operations and distribution terms documented in the earlier assessment. Neither the current metadata results nor attractive external examples establish that a wholesale provider switch is the right pivot. A concrete world task provides the comparison boundary.

## Decision criteria

The preferred direction is continued search development with a smaller, better-tested evidence pipeline. The following observations would justify changing that recommendation:

| New evidence | Justified decision |
| --- | --- |
| 32B descriptions materially improve realistic retrieval or reduce review/repair effort under fixed validation | Adopt 32B enrichment where the measured benefit exceeds its cost. |
| 32B improves verification while metadata writers perform similarly | Separate writer and validator selection; spend extra inference on the requirement checks. |
| Compact descriptions match rich metadata on the needed tasks | Remove unnecessary ingestion fields and reduce output work. |
| Fewer views preserve required recognition and uncertainty behavior | Use the cheaper view set with a measured escalation policy. |
| Shape descriptors improve reference retrieval on difficult measured pairs | Retain them for that operation; continue geometric verification of actual substitution. |
| A correct candidate is repeatedly blocked by irrelevant global semantic obligations | Narrow the admission contract around the demonstrated use. |
| A connected world blockout fails with known usable components | Focus on planning and composition; compare appropriate solvers or generators. |
| A released generator satisfies the actual world/edit task through a small adaptation | Reuse it and reduce corresponding custom generation work. |

The present results support neither complacency nor a reset. They establish that the earlier classifier formulation should remain retired, that the current retrieval path is useful on its initial examples, and that model selection and functional asset judgments need better evidence. The next investment should make a retrieved asset usable in a representative world, with each extra model, field, and contract justified by the failure it resolves.

## Sources

Public sources and local artifact state are dated September 14, 2026 unless otherwise stated. Numbered notes identify the evidence used for each claim. Local result records are private workspace artifacts; their embedded hashes identify the evaluated state even if later work replaces the operational files.

[^1]: Basalt project records. “Classification diagnosis” and “8B/32B selection results,” supplied September 14, 2026; private conversation excerpts. The latest account states that no Modal job is running and the full corpus and holdout have not launched. [Earlier world-generation assessment](/Users/mawawdi/Desktop/basalt/docs/research/world-generation-reuse.md), including the two outdoor screenshots and their historical scope. Operational assertions are attributed to the project account rather than treated as cloud telemetry.

[^2]: Basalt. [Baseline selection evidence](/Users/mawawdi/Desktop/basalt/.basalt/catalog/metadata/evaluation/baseline-selection.json), embedded hash `8bc053301a8026ee9fbe820e82dc4058984739062a1d5a82e955cd71e4689fbe`; [challenger selection evidence](/Users/mawawdi/Desktop/basalt/.basalt/catalog/metadata/evaluation/challenger-selection.json), hash `a30a44515b6ff235943ce365a37ef0a45901c8ceaa91aa746d2506977aee2612`; [baseline metadata set](/Users/mawawdi/Desktop/basalt/.basalt/catalog/metadata/sets/baseline-selection.json), hash `0443c80dcb47bcbb55fbb83744b5dd76ca252c89ddfd6288ff769970fe292554`; [challenger metadata set](/Users/mawawdi/Desktop/basalt/.basalt/catalog/metadata/sets/challenger-selection.json), hash `aa38294e2ca82730b41043c9e5343a8dabbb0a92ed3d8a13325fd4b8264ff5bd`. Model commits are recorded in the receipts. Quantitative model comparisons use the eight combined-mode selection receipts and sixteen selection validation receipts for each model.

[^3]: Basalt. [Benchmark fixture](/Users/mawawdi/Desktop/basalt/registry/catalog-search-benchmark.json), embedded hash `0491aeb05f82bec6f13bbd41b1f47005c8ed784a4cd71f61c1e06c30d1c86c47`, selection cases and aggregate split counts; [benchmark implementation](/Users/mawawdi/Desktop/basalt/packages/catalog-authoring/src/benchmark.ts), especially `objectTypeMatches`, `selectionMetrics`, `selectCatalogMetadataModel`, and `evaluateCatalogMetadata`; file SHA-256 `f55239b7c981b4677492ad2f4d625abece588b58ba6cc8854dbc41d9c203c295`. [Evaluation contract](/Users/mawawdi/Desktop/basalt/docs/EVALS.md). No holdout outcomes support this assessment.

[^4]: Basalt. [Baseline search index](/Users/mawawdi/Desktop/basalt/.basalt/catalog/search/baseline-selection/index.json), hash `51b6e49070176e06e75740feedae08808372259cec302dbb6ac374602cc615ed`; [challenger search index](/Users/mawawdi/Desktop/basalt/.basalt/catalog/search/challenger-selection/index.json), hash `70db597d60dfc009b4655bb89ae7ec0583947395ff531612fa6c4634d99f80a3`; [search implementation](/Users/mawawdi/Desktop/basalt/packages/catalog-authoring/src/search.ts), SHA-256 `4448055ec489ad4305980c98d62cf4e824e46499d16641fa3139c014a1c5fdbf`; [search policy](/Users/mawawdi/Desktop/basalt/registry/search-policy.json). Filename-only diagnostic uses each baseline document's `sourceBasename` tokens, the same Unicode tokenizer, BM25 with `k1=1.2` and `b=0.75`, recomputed document frequencies/mean length for that field, positive-score filtering, and source-hash tie breaking. Relevant ranks in query-ID order are absent, 1, 1, 1, 2, 1, 1, 1, absent, 1, absent, absent.

[^5]: Basalt. [Metadata/validation worker](/Users/mawawdi/Desktop/basalt/workers/catalog-metadata/worker.py), especially `metadata_prompt`, `validation_prompt`, `load_vllm`, `process_metadata`, `process_validation`, and `process_embeddings`; SHA-256 `6bbbe41787eed252fa61265208190bd01e2201878c44c1becb9c18dbef089b08`. [Modal wrapper](/Users/mawawdi/Desktop/basalt/workers/catalog-metadata/modal_app.py), `FUNCTION_OPTIONS` and executor functions; SHA-256 `c453651b29810e146dfe73517e0996c60e477bfb0f421e94369bbbeac3da8cfe`. [Metadata schema](/Users/mawawdi/Desktop/basalt/packages/catalog-authoring/src/metadata.ts); [validation schema](/Users/mawawdi/Desktop/basalt/packages/catalog-authoring/src/validation.ts); [metadata prompt](/Users/mawawdi/Desktop/basalt/registry/prompts/catalog-search-metadata.txt); [CLI benchmark orchestration](/Users/mawawdi/Desktop/basalt/packages/cli/src/catalog-metadata.ts).

[^6]: Basalt selection evidence. Cylinder source hash `07e1d282ebbff9bb2c30bc4078d5948de6a4024b8ccdd1ca62ffb7f9ac43e1a7`, [render](/Users/mawawdi/Desktop/basalt/.basalt/catalog/review/previews/07e1d282ebbff9bb2c30bc4078d5948de6a4024b8ccdd1ca62ffb7f9ac43e1a7/high_00-rgb.png). Stair source hash `a22b657edfaa25e32b2f9c0e7dbb671ed8d2b307776d6435904b180fa5debb8e`, [render](/Users/mawawdi/Desktop/basalt/.basalt/catalog/review/previews/a22b657edfaa25e32b2f9c0e7dbb671ed8d2b307776d6435904b180fa5debb8e/high_00-rgb.png). Sword source hash `d402bb95dda259335c2af95f704161c4157446343c5421e2891a6d666e8b1eef`, [render](/Users/mawawdi/Desktop/basalt/.basalt/catalog/review/previews/d402bb95dda259335c2af95f704161c4157446343c5421e2891a6d666e8b1eef/high_00-rgb.png). Names, gold, and validation explanations are in notes 2–3 and [source-name observations](/Users/mawawdi/Desktop/basalt/.basalt/catalog/metadata/source-name-hints.json). Numeric dimensions are decoded from the corresponding validation-job measurements as `(max - min) / 2^32`; the sword/stair measurements occur in job `0d5ea698ff38e17f55f6880901e7439cec7cee0885d77f5d6537d6c1d5ce6234`. The renders support appearance descriptions, not certification of construction role or hidden topology.

[^7]: Basalt retired inference worker, `workers/catalog-admission/pilot.py`, Git object at commit `51ee6cb81b938eea575ec6036659e6a42c2f078b`, particularly lines 183–202 and 375–410. Private repository history; the file is deleted in the current working tree. The old transformation is described as historical evidence, not proposed as a current contract.

[^8]: Xiaohua Zhai, Basil Mustafa, Alexander Kolesnikov, and Lucas Beyer. [Sigmoid Loss for Language Image Pre-Training](https://arxiv.org/abs/2303.15343), ICCV 2023. Michael Tschannen et al. [SigLIP 2: Multilingual Vision-Language Encoders with Improved Semantic Understanding, Localization, and Dense Features](https://arxiv.org/abs/2502.14786), February 2025. These support model objectives and demonstrated task families, not calibration of Basalt's label set or novelty scores.

[^9]: NVIDIA. [USD Search](https://github.com/NVIDIA-Omniverse/usd-search), official repository, Features and API descriptions. Descriptive metadata, SigLIP2 retrieval, keyword/hybrid search, and query-specific validation are relevant implementation patterns. No performance equivalence between the hosted system and Basalt is asserted.

[^10]: Christopher D. Manning, Prabhakar Raghavan, and Hinrich Schütze. [Information retrieval system evaluation](https://nlp.stanford.edu/IR-book/html/htmledition/information-retrieval-system-evaluation-1.html), *Introduction to Information Retrieval*, Cambridge University Press, 2008, Section 8.1. Collection/query/judgment design, relevance to information need, and separation of tuning from test evaluation.

[^11]: Nandan Thakur, Nils Reimers, Andreas Rücklé, Abhishek Srivastava, and Iryna Gurevych. [BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models](https://arxiv.org/abs/2104.08663), NeurIPS Datasets and Benchmarks 2021, revised October 21, 2021. Evidence for comparing lexical, dense, and reranking approaches across heterogeneous text tasks; not a direct evaluation of 3D-asset search.

[^12]: Cheng-Yu Hsieh, Jieyu Zhang, Zixian Ma, Aniruddha Kembhavi, and Ranjay Krishna. [SugarCrepe: Fixing Hackable Benchmarks for Vision-Language Compositionality](https://arxiv.org/html/2306.14610v1), June 26, 2023, especially Sections 3–4. Benchmark shortcuts and plausible object/attribute/relation distractors.

[^13]: NIST/SEMATECH. [Confidence intervals for a binomial proportion](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm), *e-Handbook of Statistical Methods*, Section 7.2.4.1. The illustrative zero-failure bound is calculated directly by solving `(1 - p)^8 = 0.05`, giving `p = 1 - 0.05^(1/8) = 0.312344`. Representative independent trials are required for a population interpretation; Basalt's selected fixtures do not establish that sampling model.

[^14]: Cynthia Dwork, Vitaly Feldman, Moritz Hardt, Toni Pitassi, Omer Reingold, and Aaron Roth. [Generalization in Adaptive Data Analysis and Holdout Reuse](https://papers.nips.cc/paper_files/paper/2015/hash/bad5f33780c42f2588878a9d07405083-Abstract.html), NeurIPS 2015. Adaptive reuse can overfit held-out data. The recommendation here is a simple frozen holdout, not implementation of the paper's privacy-based reusable-holdout mechanism.

[^15]: Meta, DINOv3 authors. [DINOv3](https://arxiv.org/html/2508.10104v1), August 2025, Sections 6.1 and 6.3 and Appendix D; [official implementation](https://github.com/facebookresearch/dinov3). Dense features, downstream depth/geometry evaluation, and released model use. The specific Basalt depth-image pooling recipe remains separately unqualified.

[^16]: vLLM contributors. [Structured Outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/), current documentation, JSON schema generation and guidance to explain field population in the prompt. Format enforcement is separate from evidence correctness.

[^17]: Modal. [Plan Pricing](https://modal.com/pricing), GPU Tasks, CPU, and Memory, accessed September 14, 2026. [Basalt model declarations](/Users/mawawdi/Desktop/basalt/registry/catalog-models.json) assign L40S to 8B and A100 80 GB to 32B. Calculated GPU-only prices use retained per-item seconds times the published base rate; they exclude initialization, failed attempts outside retained sets, non-GPU charges, and deployment-specific modifiers.

[^18]: Yifan Li et al. [Evaluating Object Hallucination in Large Vision-Language Models](https://arxiv.org/abs/2305.10355), EMNLP 2023; [official POPE implementation](https://github.com/RUCAIBox/POPE). Supports separate evaluation of unsupported visual claims; it does not establish a calibrated detector for Basalt geometry, materials, or construction roles.

[^19]: Alexander Raistrick et al. [Infinigen Indoors: Photorealistic Indoor Scenes using Procedural Generation](https://arxiv.org/abs/2406.11824), CVPR 2024; [official implementation](https://github.com/princeton-vl/infinigen). Procedural indoor generation and a constraint-based arrangement system. Reuse must account for its Blender environment and applicable dependency terms.

[^20]: Yue Yang et al. [Holodeck: Language Guided Generation of 3D Embodied AI Environments](https://arxiv.org/abs/2312.09067), CVPR 2024; [official repository](https://github.com/allenai/Holodeck). Nicholas Pfaff et al. [SceneSmith: Agentic Generation of Simulation-Ready Indoor Scenes](https://arxiv.org/abs/2602.09153), 2026; [official repository](https://github.com/nepfaff/scenesmith). Indoor scope and structured scene-generation implementations; further integration evidence is recorded in note 1's earlier assessment.

[^21]: Yunhan Yang et al. [HoloPart: Generative 3D Part Amodal Segmentation](https://arxiv.org/abs/2504.07943), April 2025; [official repository](https://github.com/VAST-AI-Research/HoloPart). Yuchen Lin et al. [PartCrafter: Structured 3D Mesh Generation via Compositional Latent Diffusion Transformers](https://arxiv.org/abs/2506.05573), NeurIPS 2025; [official repository](https://github.com/wgsxm/PartCrafter). Part completion and joint mesh generation, distinct from verified modular assembly.

[^22]: Basalt. [Architecture](/Users/mawawdi/Desktop/basalt/docs/ARCHITECTURE.md), [product thesis](/Users/mawawdi/Desktop/basalt/docs/BASALT.md), [visual and asset contracts](/Users/mawawdi/Desktop/basalt/docs/VISUALS.md), [roadmap](/Users/mawawdi/Desktop/basalt/docs/ROADMAP.md), and [engineering rules](/Users/mawawdi/Desktop/basalt/AGENTS.md). Current authority boundaries and future acceptance criteria. Recommendations in this report remain research until explicitly adopted into the relevant contracts.

[^23]: SideFX. [Labs Building Generator Utility](https://www.sidefx.com/docs/houdini/nodes/sop/labs--building_generator_utility.html), Houdini documentation, accessed September 14, 2026. Named module collections, authored module width/height, and the distinction between geometric bounds and intended module dimensions. This is a documented procedural authoring pattern, not evidence of automatic recognition of arbitrary kits.

[^24]: Basalt. [Catalog entry declarations](/Users/mawawdi/Desktop/basalt/packages/catalog-model/src/entries.ts), particularly `assemblyKitDeclaration` and the validation of providers, role schemes, interfaces, mates, and transitions. An existing representation and validation boundary does not establish that automated kit interpretation or successful real-kit generation has been demonstrated.
