# Scene export conformance fixture

Byte-locked output of `emitSceneExport` over the fixed-timestamp fixture world (see `test/scene-export.test.ts`). Future engine adapters (Unity, Unreal, native renderer) validate their manifest parser and payload handling against these files: parse `scene-manifest.json`, verify every payload hash, and confirm the placement composition reproduces the sealed instance transforms.

Regenerate only by editing the sealed export contract itself; the fixture test fails on any drift.
