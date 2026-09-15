# Catalog qualification adjudication protocol

This fixture is an offline, bounded evaluation artifact. Its labels are hypotheses authored from
the retained source basename, measured geometry, and twelve-view render evidence. They do not admit
assets to the catalog and do not establish creator or engine authority.

For each cohort asset, inspect the twelve-view render and measurement before assigning a plain-language
object label and stratum. Use `uncertain` when the visible evidence does not support a positive or a
negative claim. Directory and pack names may locate evidence but never decide a label.

Positive retrieval judgments require a visible object match within the candidate pool. Multiple
genuinely relevant assets are retained when present. A similar basename is not sufficient. Confusers
are marked irrelevant only when the direct render evidence rules them out; otherwise they remain
uncertain.

No-match cases use concepts deliberately absent from the inspected candidate population. Evidence-
insufficient cases ask for a property that source names, measurements, and renders cannot establish,
such as load rating, edibility, internal topology, or gameplay behavior. Those cases must not be
scored as no-match.

Validator cases are authored independently of model output. Match cases pair an executable query with
a visibly conforming source; mismatch cases use a direct visual confuser; uncertain cases require a
non-visible fact. The validator receives no source filename or directory hint.

Development and model-selection results may guide configuration choice. The frozen selection rule is
the least GPU time among configurations that pass every gate; when measured cost is equal, retain the
twelve-view writer. Holdout is executed once under that frozen configuration. A failed holdout remains
failed and does not authorize corpus enrichment.
