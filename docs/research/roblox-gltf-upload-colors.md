# Roblox glTF Upload Color Adaptation

This note records rationale and experimental evidence. The implemented contracts and creator-run
Studio observations remain authoritative.

## Observed failure

The first 24 admitted outdoor models were successfully published, but creator screenshots showed
red/burgundy foliage and near-black crowns with magenta trunks. Rock and log controls retained
plausible beige and brown colors. Those publications were never bound, so they cannot enter a
world import.

Inspection of the exact source GLBs found the same separator:

- the failed fern and tree primitives have `COLOR_0` and `COLOR_1`;
- `COLOR_0` is uniformly white, while `COLOR_1` contains saturated red/black-like values;
- the correct rock and log controls have no vertex-color attributes;
- all four retain the same embedded palette texture used by the reviewed renders.

The correspondence between those values and the Studio output makes secondary-color selection the
best current root-cause inference. Studio confirmation of replacement uploads remains the decisive
test.

## Proven baseline and Basalt remainder

The [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
defines `COLOR_0` as the vertex color used in core base-color evaluation, requires custom vertex
attributes to begin with an underscore, and asks clients to support at least one color set. It does
not give `COLOR_1+` a core material role. Roblox's
[3D importer documentation](https://create.roblox.com/docs/studio/importer) exposes an **Ignore
Vertex Colors** setting, confirming that imported vertex colors can alter Roblox appearance.

The commodity rule is therefore small: retain `COLOR_0`, omit `COLOR_1+` from the Roblox payload,
and leave the source artifact untouched. Basalt's remainder is evidence and gating: deterministic
derivation, immutable payload storage, hashes for the source/payload/policy/request chain, and an
independent creator-observed material binding before execution.

## Bounded pilot

Adaptation policy hash:
`6049c5774eac587fea2f2c7ab6e9bf63cac99c4ca5ca23e6b6444d41aacb0459`.

| Case                   | Source hash | Upload hash | Source/upload bytes | Removed |
| ---------------------- | ----------- | ----------- | ------------------: | ------: |
| affected fern          | `99f17578…` | `68849702…` |       21,412/21,400 |       1 |
| unchanged rock control | `3887b64f…` | `3887b64f…` |       13,020/13,020 |       0 |
| affected tree          | `f020fe05…` | `1233e1f4…` |       51,840/51,828 |       1 |
| unchanged log control  | `535d6f66…` | `535d6f66…` |       28,684/28,684 |       0 |

All four adapted payloads pass the existing bounded GLB inspector. Its geometry, bounds, material,
and embedded-image projections are unchanged. Across all 24 admitted outdoor sources, 14 payloads
change, 18 primitive attributes are removed, all 24 still pass inspection, and the same projections
show zero drift.

The stop condition was creator inspection of the four replacement models: the fern and tree had to
recover their reviewed palette, and the rock and log had to remain unchanged. On 2026-09-15, the
creator reported “Yes they're fixed now” after that inspection. This authorizes rollout of the fixed
adaptation policy; it is qualitative pilot evidence, not a substitute for the exact per-part material
observations required by a Roblox binding.

The subsequent rollout reused the four pilot receipts and published the other 20 admitted assets.
All 24 operations are moderation-approved with zero failures. Upload ledger hash:
`5ef479e412f5522642773559de87c9aefe8b642bb5a7896764dfe1308a642727`.
