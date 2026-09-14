# Retained catalog evidence

`basalt catalog commit` retains only the exact measured-asset set and canonical
render index required to reproduce catalog authority. Learned metadata,
embeddings, search results, and validator verdicts stay outside the authority
root.

After the search benchmark passes, `basalt catalog metadata commit` writes compact
metadata shards below `catalog-search-metadata/`; those shards remain explicitly
non-authoritative. GLBs, rendered images, and embedding matrices remain in the
local content-addressed store. Unreferenced hashed JSON evidence is removed when
the replaceable catalog root is published because Git supplies history.
