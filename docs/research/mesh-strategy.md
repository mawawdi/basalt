# Mesh strategy

How compiled-world geometry reaches engines. The compiler is engine-agnostic:
it emits content-hashed GLB payloads plus a sealed scene manifest, and each
engine lowers them through its own adapter. This record compares the Roblox
ingestion options, states the limits that gate uploads, and defines the
adapter-owned sidecar that binds content hashes to engine handles.

All engine claims below trace to the inspected sources at the end. Claims
without a source are Basalt design decisions, not engine facts.

## Options compared

### A. Open Cloud upload (primary)

Each sealed mesh part uploads once through the Open Cloud Assets API as
`Model` type. The API accepts `.glb` directly and imports server-side to a
`Model` container holding one or more `MeshPart` objects. Basalt's corpus
format therefore uploads as-is with no conversion step.

- One asset per call, file size up to 20 MB per call.
- Uploaded `Model` assets carry version control, metadata, and rollback
  through the same API.
- The creator owns the API key, creator identity, and uploads; Basalt
  tooling never stores credentials.

### B. Manual import (creator fallback)

The same `.glb` parts import through Studio's Importer (3D preview,
error-checking, import settings) or bulk through Asset Manager (no
rigging/skinning/animation support). Produces the identical sidecar shape
as option A. No API key required.

### C. Runtime EditableMesh construction (fallback only)

A blank `EditableMesh` is created via `AssetService:CreateEditableMesh()`,
filled procedurally, and displayed by linking to a `MeshPart` through
`AssetService:CreateMeshPartAsync()`. Rejected as the primary path:

- Hard caps: 60,000 vertices and 20,000 triangles per mesh.
- Strict client-side memory budgets (server, Studio, and plugins are
  exempt, so creator-run sync is unaffected — but published play is not).
- Published games require 13+/ID-verified ownership plus a Creator
  Dashboard toggle to use mesh APIs at all.
- Bypasses the native PBR import path (textures, LOD, collision fidelity
  assigned at import).

Kept as fallback for procedural or otherwise unuploadable geometry only.

## Limits (inspected)

| Surface                         | Limit                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MeshPart source mesh            | ≤ 20,000 triangles; watertight; no N-gons; nonzero volume                                                                                                                             |
| Open Cloud `Model` upload       | `.fbx`, `.gltf`, `.glb`, `.rbxm`, `.rbxmx`; ≤ 20 MB per call                                                                                                                          |
| Open Cloud `Mesh` upload        | Re-upload of Asset-delivery content only; not a general ingest path                                                                                                                   |
| EditableMesh                    | ≤ 60,000 vertices, ≤ 20,000 triangles; client memory budgets                                                                                                                          |
| EditableMesh in published games | 13+/ID verification + Dashboard toggle required                                                                                                                                       |
| Terrain                         | 4×4×4-stud cells, per-cell occupancy 0–1 plus material; scripted writes via `Terrain:WriteVoxels(region, resolution, materials, occupancy)`; editable extents ±128,000 studs per axis |
| Mesh PBR                        | Up to 4 maps via `SurfaceAppearance` child or `MaterialVariant`                                                                                                                       |

Upload moderation, throttling, and rate behavior are not documented in the
inspected sources; the upload script treats them as operational unknowns
with the manual-import fallback (option B) always available.

The Studio Importer defaults its Scale Unit setting to Studs ("what units
the file was modeled in"); the Open Cloud Assets API states no import scale
at all. The connector therefore never assumes an import scale: it measures
the import factor per loaded model from model bounds against the recorded
part span and fails closed past 1% axis disagreement.

Studio-observed server import map (measured, verified per part, compensated
in the connector — this differs from the Studio UI's "Use Imported Pivot"
default, which the server path does not follow): the importer bakes R_y(180°)
composed with the node transform into mesh vertices, centers each part pivot
on the imported geometry (pivot lands on the flipped recorded center to f32
precision), leaves part rotations identity, and scales 1:1. Placement frames
the recorded center and unflips orientation; pivots, rotations, and extents
are re-verified on every loaded model and any deviation fails closed with
numbers. Each part record still carries its node origin (`pivotSourceUnits`)
as truthful sealed evidence for other adapters.
Server-side PBR handling (whether the Model import synthesizes
`SurfaceAppearance` children) is likewise undocumented and stays a capture
checkpoint, not a connector synthesis.

## Sidecar manifest shape

Adapter-owned, never sealed into compiler records:

```json
{
  "kind": "BasaltEngineSidecar",
  "abi": "basalt-engine-sidecar@1",
  "engine": "roblox",
  "exportHash": "<sha256 of the bound scene export>",
  "bindings": [
    {
      "contentHash": "<sha256 of sealed mesh-part bytes>",
      "assetId": "<engine handle, e.g. rbxassetid>",
      "uploadedAt": "<iso8601>",
      "budgets": { "triangles": 0, "bytes": 0, "watertight": true }
    }
  ]
}
```

Bindings resolve by exact content hash. A missing binding fails closed at
lowering time naming the unbound part; re-uploading identical bytes must
reproduce the identical hash and reuse the binding.

## Fallback rules

1. A part within all budgets uploads through option A (or B when the
   creator has no API key). Both write the same sidecar shape.
2. A part exceeding mesh budgets (triangles, bytes, watertight/volume)
   fails closed naming the procedural/split route; it never silently
   degrades.
3. Procedural geometry (terrain voxels, road ribbons, parametric parts)
   lowers natively per engine and never enters the sidecar.
4. EditableMesh construction applies only to geometry that cannot be
   uploaded and cannot lower natively, and only within its caps.

## Units and bounds

Placements in the scene export are meters, Y-up, right-handed. Mesh-part
bounding boxes are NOT pre-converted: raw glTF accessor min/max are
unitless, so each part's `boundsSourceUnits` keeps the recorded span in
the source file's native units, and the sibling asset entry's
`unitsToMeters` is the recorded converter to meters. Each lowering
adapter multiplies span by `unitsToMeters`, converts to its native frame,
and rejects when the recorded converter contradicts inspection lineage.
This keeps a unit mismatch a loud failure instead of a silent scale
error.

## Engine-neutral rationale

Sealed records carry content hashes and placements only — never
`rbxassetid` or any other engine handle. Unity consumes the same GLB
payloads through its glTF package story (runtime and editor import);
Unreal through its documented glTF support; a native renderer through
any glTF 2.0 loader. Each engine owns its adapter and its sidecar;
the compiler never learns engine identities.

## Sources

- https://create.roblox.com/docs/en-us/reference/engine/classes/EditableMesh.md
- https://create.roblox.com/docs/en-us/reference/engine/classes/Terrain.md
- https://create.roblox.com/docs/en-us/parts/meshes.md
- https://create.roblox.com/docs/en-us/art/modeling/specifications.md
- https://create.roblox.com/docs/en-us/parts/models.md
- https://create.roblox.com/docs/en-us/cloud/guides/usage-assets.md
- https://create.roblox.com/docs/en-us/studio/importer.md
- https://raw.githubusercontent.com/atteneder/glTFast/main/README.md
- https://docs.blender.org/manual/en/4.2/addons/import_export/scene_gltf2.html
