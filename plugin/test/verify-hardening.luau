--!strict
-- Lune suite for the verify-hardening pure modules. Runs under `lune run`
-- from the repository root; these modules touch no engine services, so the
-- same files ship to Studio untouched.
local VoxelSpots = require("../src/Basalt/VoxelSpots")
local TerrainMarkers = require("../src/Basalt/TerrainMarkers")

local failures = 0

local function check(name: string, body: () -> ()): ()
	local ok, message = pcall(body)
	if ok then
		print("ok - " .. name)
	else
		failures += 1
		print("FAIL - " .. name .. ": " .. tostring(message))
	end
end

local function sameCells(left: { VoxelSpots.SpotCell }, right: { VoxelSpots.SpotCell }): boolean
	if #left ~= #right then return false end
	for index, cell in ipairs(left) do
		local other = right[index]
		if cell.x ~= other.x or cell.y ~= other.y or cell.z ~= other.z then return false end
	end
	return true
end

local function expectError(body: () -> (), pattern: string): ()
	local ok, message = pcall(body)
	assert(not ok, "expected an error matching " .. pattern)
	assert(string.find(tostring(message), pattern) ~= nil, "wrong error: " .. tostring(message))
end

check("spot cells cover a point field with its single cell", function()
	assert(sameCells(VoxelSpots.cells(1, 1, 1), { { x = 0, y = 0, z = 0 } }))
end)

check("spot cells cover a flat quad with its four cells", function()
	assert(sameCells(VoxelSpots.cells(2, 1, 2), {
		{ x = 0, y = 0, z = 0 },
		{ x = 0, y = 0, z = 1 },
		{ x = 1, y = 0, z = 0 },
		{ x = 1, y = 0, z = 1 },
	}))
end)

check("spot cells match the host rule byte for byte", function()
	local cells = VoxelSpots.cells(16, 2, 16)
	local pinned = {
		{ x = 0, y = 0, z = 0 },
		{ x = 0, y = 0, z = 11 },
		{ x = 0, y = 0, z = 15 },
		{ x = 0, y = 1, z = 0 },
		{ x = 0, y = 1, z = 6 },
		{ x = 0, y = 1, z = 15 },
		{ x = 2, y = 0, z = 4 },
		{ x = 2, y = 0, z = 15 },
		{ x = 2, y = 1, z = 10 },
		{ x = 4, y = 0, z = 8 },
		{ x = 4, y = 1, z = 3 },
		{ x = 4, y = 1, z = 14 },
		{ x = 6, y = 0, z = 1 },
		{ x = 6, y = 0, z = 12 },
		{ x = 6, y = 1, z = 7 },
		{ x = 8, y = 0, z = 5 },
		{ x = 8, y = 1, z = 0 },
		{ x = 8, y = 1, z = 8 },
		{ x = 8, y = 1, z = 11 },
		{ x = 10, y = 0, z = 9 },
		{ x = 10, y = 1, z = 4 },
		{ x = 12, y = 0, z = 2 },
		{ x = 12, y = 0, z = 13 },
		{ x = 12, y = 1, z = 8 },
		{ x = 14, y = 0, z = 6 },
		{ x = 14, y = 1, z = 1 },
		{ x = 14, y = 1, z = 12 },
		{ x = 15, y = 0, z = 0 },
		{ x = 15, y = 0, z = 15 },
		{ x = 15, y = 1, z = 0 },
		{ x = 15, y = 1, z = 15 },
	}
	assert(#cells == 31, "expected 31 cells, got " .. #cells)
	assert(sameCells(cells, pinned), "spot cells diverge from the host rule")
end)

check("spot cells reject degenerate dimensions", function()
	expectError(function()
		VoxelSpots.cells(0, 1, 1)
	end, "positive integer dimensions")
end)

local function reading(x: number, y: number, z: number, occupancy: number, material: string): VoxelSpots.SpotReading
	return { x = x, y = y, z = z, occupancy = occupancy, material = material }
end

check("spot drift passes clean reads back", function()
	local expected = { reading(0, 0, 0, 1, "Grass"), reading(1, 0, 0, 0.925, "Grass") }
	local observed = { reading(1, 0, 0, 0.925, "Grass"), reading(0, 0, 0, 1, "Grass") }
	assert(VoxelSpots.findDrift(expected, observed, 0.004) == nil)
end)

check("spot drift tolerates engine quantization but not content drift", function()
	local expected = { reading(0, 0, 0, 0.925, "Grass") }
	assert(VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0.925 + 0.003, "Grass") }, 0.004) == nil)
	local drift = VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0.5, "Grass") }, 0.004)
	assert(drift ~= nil and drift.field == "occupancy", "expected an occupancy drift")
	assert(drift ~= nil and drift.expected == 0.925 and drift.observed == 0.5)
end)

check("spot drift reports material, missing, and extra cells", function()
	local expected = { reading(0, 0, 0, 1, "Grass") }
	local material = VoxelSpots.findDrift(expected, { reading(0, 0, 0, 1, "Sand") }, 0.004)
	assert(material ~= nil and material.field == "material", "expected a material drift")
	local missing = VoxelSpots.findDrift(expected, {}, 0.004)
	assert(missing ~= nil and missing.field == "missing", "expected a missing drift")
	local extra = VoxelSpots.findDrift({}, expected, 0.004)
	assert(extra ~= nil and extra.field == "extra", "expected an extra drift")
end)

check("markers prove their hash, writer, and region or read suspect", function()
	local sealed = string.rep("a", 64)
	local full: TerrainMarkers.MarkerView =
		{ name = "s", voxelHash = sealed, chunkId = "chunk_a", origin = { 0, 0, 0 }, dimensions = { 16, 2, 16 } }
	local suspect, reason = TerrainMarkers.isSuspect(full, sealed)
	assert(suspect == false and reason == nil, "a proven marker must not read suspect")
	local cases = {
		{ { name = "s", voxelHash = nil, chunkId = "chunk_a", origin = { 0, 0, 0 }, dimensions = { 16, 2, 16 } }, "voxel hash" },
		{ { name = "s", voxelHash = string.rep("b", 64), chunkId = "chunk_a", origin = { 0, 0, 0 }, dimensions = { 16, 2, 16 } }, "another voxel hash" },
		{ { name = "s", voxelHash = sealed, chunkId = nil, origin = { 0, 0, 0 }, dimensions = { 16, 2, 16 } }, "writer chunk" },
		{ { name = "s", voxelHash = sealed, chunkId = "chunk_a", origin = nil, dimensions = { 16, 2, 16 } }, "written region" },
		{ { name = "s", voxelHash = sealed, chunkId = "chunk_a", origin = { 0, 0, 0 }, dimensions = { 16, 0, 16 } }, "written region" },
	}
	for _, case in ipairs(cases) do
		local isSuspect, why = TerrainMarkers.isSuspect(case[1], sealed)
		assert(isSuspect, "expected a suspect marker")
		assert(string.find(why :: string, case[2]) ~= nil, "wrong reason: " .. tostring(why))
	end
end)

check("rollback clears own regions, drops legacy markers, and fails closed", function()
	local plan = TerrainMarkers.planClear({
		{ name = "own", voxelHash = "h", chunkId = "chunk_a", origin = { -32, -8, -32 }, dimensions = { 16, 2, 16 } },
		{ name = "legacy", voxelHash = "h", chunkId = nil, origin = nil, dimensions = nil },
	}, "chunk_a", 4)
	assert(#plan.clear == 1 and plan.clear[1].name == "own", "expected one clear")
	assert(plan.clear[1].origin[1] == -32 and plan.clear[1].dimensions[2] == 2)
	assert(#plan.drop == 1 and plan.drop[1] == "legacy", "expected one drop")
	expectError(function()
		TerrainMarkers.planClear({
			{ name = "foreign", voxelHash = "h", chunkId = "chunk_b", origin = { 0, 0, 0 }, dimensions = { 4, 4, 4 } },
		}, "chunk_a", 4)
	end, "holds a marker for chunk chunk_b")
	expectError(function()
		TerrainMarkers.planClear({
			{ name = "blind", voxelHash = "h", chunkId = "chunk_a", origin = nil, dimensions = nil },
		}, "chunk_a", 4)
	end, "lacks its written region")
	expectError(function()
		TerrainMarkers.planClear({
			{ name = "skewed", voxelHash = "h", chunkId = "chunk_a", origin = { -30, 0, 0 }, dimensions = { 4, 4, 4 } },
		}, "chunk_a", 4)
	end, "not cell%-aligned")
end)

if failures > 0 then error(failures .. " Lune checks failed") end
print("Lune verify checks passed")
