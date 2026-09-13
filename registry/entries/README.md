# Authored catalog entries

Each JSON file in this directory is one canonical `CatalogEntryDeclaration`.
Catalog declarations reference canonical content identities and admitted evidence.
Origin archives, vendor folders, directories, and filenames must not be copied into
declarations. Authoring tools may derive basename-only, non-authoritative weak hints
from the provenance ledger for semantic hypothesis review; those hints never enter
an entry seal or runtime catalog index.
