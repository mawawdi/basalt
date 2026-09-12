--!strict
return {
	BRIDGE_URL = "http://127.0.0.1:8787",
	MAX_MESSAGE_BYTES = 1024 * 1024,
	MAX_WORLD_CHUNKS = 4096,
	MAX_WORLD_INSTANCES_PER_CHUNK = 65536,
	MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK = 16384,
	WORLD_TRANSACTION_ABI = "basalt-world-transaction@1",
	WORLD_READBACK_ABI = "basalt-world-readback@1",
	-- Lowering adapter facts. The scene export stays engine-neutral; unit and
	-- frame conversion happens here, in the Roblox adapter only.
	STUD_METERS = 0.28,
	SCENE_EXPORT_ABI = "basalt-scene-export@1",
	SCENE_EXPORT_COMPOSITION = "T(positionMeters).R(rotationQuaternion).S(uniformScale).T(-pivotOffsetMeters).S(unitsToMeters)",
	ENGINE_SIDECAR_ABI = "basalt-engine-sidecar@1",
	MATERIAL_MAP_ABI = "basalt-material-map@1",
	VOXEL_CELL_STUDS = 4,
	-- A sealed part whose node name carries this suffix lowers as an invisible
	-- collision proxy; it never renders. Family membership never comes from
	-- names -- this suffix only marks the non-renderable companion.
	COLLISION_NODE_SUFFIX = "_Collision",
	-- Imported-model placement checks. The connector never assumes the
	-- server-side import scale: it measures the import factor from the loaded
	-- model bounds against the recorded part span and fails closed past these.
	IMPORT_SCALE_TOLERANCE = 0.01,
	IMPORT_PIVOT_TOLERANCE = 0.02,
	IMPORT_ROTATION_TOLERANCE = 0.001,
	-- Measured server-side import map (Studio-observed, verified per part):
	-- the importer bakes R_y(180) composed with the node transform into mesh
	-- vertices, centers each part pivot on the imported geometry, and leaves
	-- part rotations identity at 1:1 scale. Placement compensates with the
	-- inverse rotation; any part deviating from this map fails closed.
	IMPORT_FLIP = CFrame.new(0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, -1),
	-- Road ribbons are sealed surfaces; the adapter gives them a thin solid
	-- body lifted half a thickness plus epsilon so they read over terrain.
	ROAD_THICKNESS_STUDS = 0.4,
	ROAD_LIFT_STUDS = 0.25,
}
