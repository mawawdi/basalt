# Retained catalog evidence

`basalt catalog commit` copies the exact measurement, request, render-index,
source-name hint, inference, clustering, and review metadata used by the current
catalog here by content hash. These files preserve runtime inputs and admission
provenance in Git. Source-name hints are basename-only, non-authoritative weak
supervision; pack and directory identity are excluded. Source GLBs and rendered
images remain external content-addressed payloads. Unreferenced JSON evidence is
removed after a new root is published because Git supplies history.

This directory is not a binary artifact store. Bulk payloads are local-only in the
current baseline and require independent backup; see
[storage and recovery](../../docs/ARCHITECTURE.md#storage-and-recovery).
