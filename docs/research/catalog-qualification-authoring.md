# Catalog qualification authoring baseline

Status: rationale only. Runtime contracts and sealed artifacts remain authoritative.

## Closest maintained baselines

[Label Studio](https://github.com/HumanSignal/label-studio) is the closest maintained open-source
baseline for the review surface: present media and structured fields together, persist per-item
annotation state, allow explicit revision or skipping, and make dense review navigable. Basalt
reuses that small interaction pattern in a static local evidence desk rather than building a
general annotation service.

The [NIST TREC relevance-judgment collections](https://trec.nist.gov/data/reljudge_eng.html) and
the [TREC 2024 overview](https://trec.nist.gov/pubs/trec33/papers/overview_33.pdf) are the closest
production evaluation baseline for retrieval pooling: collect candidates from the systems under
comparison, form a pool, and judge query–document relationships. The important consequence for
Basalt is that unjudged results are not negative answers, and a mixed pool cannot restrict credit
to the hand-selected cohort.

[BEIR](https://arxiv.org/abs/2104.08663) is the closest broad retrieval-benchmark baseline for
testing heterogeneous information needs rather than one repeated wording pattern. Basalt reuses
the principle of varied realistic requests and separate retrieval metrics, not BEIR's datasets or
task-specific labels.

## Reused commodity capability

- A single local review workspace presents all pilot items with enlargement, multiple views,
  measurements, and resumable state. Its required human action is deliberately narrow: accept or
  edit the visible description, report uncertainty, or flag defective images. Internal cohort tags
  and contextual-purpose hypotheses are not silently approved.
- Retrieval systems contribute candidates to a canonical union pool; they do not author their own
  answer key.
- Standalone search excludes sources measured entirely as collision proxies and records each exact
  exclusion in the sealed index; missing appearance evidence cannot turn them into candidates.
- Query–candidate relevance and validator verdicts are distinct judgment tasks.
- Development iteration precedes model selection and untouched holdout evaluation.

## Basalt-owned remainder

- Every proposal and decision is content-addressed and bound to exact source, render, measurement,
  split, query, candidate, and evidence identities.
- Filename observations are segregated as non-authoritative hints; they cannot decide descriptions,
  relevance, or confusers.
- Explicit `_Collision` companions are measured as geometry-only collision proxies and excluded
  from appearance review and near-duplicate image descriptors. The first full audit found 61 such
  companions; an incorrectly rendered, corruptly textured collision shell exposed the former
  render-role defect. Exact geometry, containment, and material-payload leakage evidence still
  covers these sources.
- Description proposals are unscored and cannot authorize execution. Query authoring starts only
  after the 24-asset development pilot is independently reviewed and found useful.
- Reviewed unknowns remain unknown. Status or provenance edits cannot substitute for loading,
  hashing, and comparing the creator decision contents with the final answer key.

## Bounded pilot stop conditions

Do not expand from 24 to 192 assets if generic descriptions survive, evidence defects appear as
ordinary uncertainty, collision-only sources enter appearance review or standalone retrieval,
filename hints decide a label, or the review page makes complete inspection impractical. Do not
construct a qualification fixture until distinct requests, union pools, relevance judgments, and
validator cases are all independently adjudicated.
