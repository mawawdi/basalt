--!strict
-- Lune suite for the verify-hardening pure modules. Runs under `lune run`
-- from the repository root; these modules touch no engine services, so the
-- same files ship to Studio untouched.
local VoxelSpots = require("../src/Basalt/VoxelSpots")
local TerrainMarkers = require("../src/Basalt/TerrainMarkers")
local VoxelField = require("../src/Basalt/VoxelField")
local TerrainAppearance = require("../src/Basalt/TerrainAppearance")
local TerrainRepaints = require("../src/Basalt/TerrainRepaints")

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

local function reading(
	x: number,
	y: number,
	z: number,
	occupancy: number,
	liquid: number,
	material: string
): VoxelSpots.SpotReading
	return { x = x, y = y, z = z, occupancy = occupancy, liquid = liquid, material = material }
end

check("spot drift passes clean reads back", function()
	local expected = { reading(0, 0, 0, 1, 0, "Grass"), reading(1, 0, 0, 0.925, 0, "Grass") }
	local observed = { reading(1, 0, 0, 0.925, 0, "Grass"), reading(0, 0, 0, 1, 0, "Grass") }
	assert(VoxelSpots.findDrift(expected, observed, 0.004) == nil)
end)

check("spot drift tolerates engine quantization but not content drift", function()
	local expected = { reading(0, 0, 0, 0.925, 0, "Grass") }
	assert(VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0.925 + 0.003, 0, "Grass") }, 0.004) == nil)
	local drift = VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0.5, 0, "Grass") }, 0.004)
	assert(drift ~= nil and drift.field == "occupancy", "expected an occupancy drift")
	assert(drift ~= nil and drift.expected == 0.925 and drift.observed == 0.5)
end)

check("spot drift reports liquid, material, missing, and extra cells", function()
	local expected = { reading(0, 0, 0, 0, 0.75, "Air") }
	assert(VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0, 0.75 + 0.003, "Air") }, 0.004) == nil)
	local liquid = VoxelSpots.findDrift(expected, { reading(0, 0, 0, 0, 0.5, "Air") }, 0.004)
	assert(liquid ~= nil and liquid.field == "liquid", "expected a liquid drift")
	assert(liquid ~= nil and liquid.expected == 0.75 and liquid.observed == 0.5)
	local solid = { reading(0, 0, 0, 1, 0, "Grass") }
	local material = VoxelSpots.findDrift(solid, { reading(0, 0, 0, 1, 0, "Sand") }, 0.004)
	assert(material ~= nil and material.field == "material", "expected a material drift")
	local missing = VoxelSpots.findDrift(solid, {}, 0.004)
	assert(missing ~= nil and missing.field == "missing", "expected a missing drift")
	local extra = VoxelSpots.findDrift({}, solid, 0.004)
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

local function tinyBvx2(occupancyBytes: { number }, liquidBytes: { number }): string
	local parts: { string } = { "BVX2" }
	table.insert(parts, string.char(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0))
	table.insert(parts, string.char(0, 0, 0, 0, 0, 0, 0, 0))
	table.insert(parts, string.char(0, 0, 0, 0, 0, 0, 0, 0))
	table.insert(parts, string.char(0, 0, 0, 0, 0, 0, 0, 0))
	table.insert(parts, string.char(0, 0, 0, 0, 0, 0, 16, 64))
	table.insert(parts, string.char(1, 0, 0, 0))
	table.insert(parts, string.char(5, 0) .. "mat_a")
	table.insert(parts, string.char(table.unpack(occupancyBytes)))
	table.insert(parts, string.char(table.unpack(liquidBytes)))
	table.insert(parts, string.char(0, 0))
	return table.concat(parts)
end

check("voxel field decodes BVX2 solid and liquid channels", function()
	-- occupancy 0.5 (3F000000), liquid 0.25 (3E800000), material 0.
	local field = VoxelField.decode(tinyBvx2({ 0, 0, 0, 63 }, { 0, 0, 128, 62 }))
	assert(field.dimensions[1] == 1 and field.dimensions[2] == 1 and field.dimensions[3] == 1)
	assert(field.cellSize == 4)
	assert(field.materials[1] == "mat_a")
	assert(field.occupancy[1] == 0.5, "occupancy decodes")
	assert(field.liquid[1] == 0.25, "liquid decodes")
	assert(field.materialIndex[1] == 0)
end)

check("voxel field refuses legacy magic and channel escapes", function()
	local legacy = tinyBvx2({ 0, 0, 0, 63 }, { 0, 0, 128, 62 }):gsub("^BVX2", "BVX1")
	expectError(function()
		VoxelField.decode(legacy)
	end, "unknown magic")
	-- occupancy 2.0 (40000000).
	expectError(function()
		VoxelField.decode(tinyBvx2({ 0, 0, 0, 64 }, { 0, 0, 128, 62 }))
	end, "occupancy escapes")
	-- liquid 2.0 (40000000).
	expectError(function()
		VoxelField.decode(tinyBvx2({ 0, 0, 0, 63 }, { 0, 0, 0, 64 }))
	end, "liquid escapes")
end)

check("appearance plans water, grass, and tints in engine units", function()
	local plan = TerrainAppearance.planAppearance({
		water = {
			colorRgb = { r = 0.1, g = 0.5, b = 0.55 },
			transparency = 0.35,
			reflectance = 0.6,
			waveSizeMeters = 0.28,
			waveSpeedMeters = 0.84,
		},
		grass = { enabled = true, lengthMeters = 0.168 },
		materialTints = { { materialId = "bayMeadow", colorRgb = { r = 0.42, g = 0.66, b = 0.28 } } },
	}, 0.28)
	assert(plan.water ~= nil and plan.water.waveSizeStuds == 1, "wave size converts to studs")
	assert(math.abs((plan.water and plan.water.waveSpeedPerMinute or 0) - 3) < 1e-9, "wave speed converts")
	assert(plan.water ~= nil and plan.water.color.g == 0.5, "water color passes through")
	assert(plan.water ~= nil and plan.water.transparency == 0.35, "water transparency passes through")
	assert(plan.grass ~= nil and plan.grass.enabled == true, "grass enablement passes through")
	assert(math.abs((plan.grass and plan.grass.lengthStuds or 0) - 0.6) < 1e-9, "grass length converts")
	assert(#plan.tints == 1 and plan.tints[1].materialId == "bayMeadow", "tints keep neutral ids")
	assert(#plan.clamped == 0, "in-bounds values clamp nothing")
end)

check("appearance clamps engine-narrow waves and fails closed elsewhere", function()
	local plan = TerrainAppearance.planAppearance({
		water = {
			colorRgb = { r = 0, g = 0, b = 0 },
			transparency = 0,
			reflectance = 0,
			waveSizeMeters = 0.42,
			waveSpeedMeters = 28.56,
		},
		materialTints = {},
	}, 0.28)
	assert(plan.water ~= nil and plan.water.waveSizeStuds == 1, "wave size clamps to 1 stud")
	assert(plan.water ~= nil and plan.water.waveSpeedPerMinute == 100, "wave speed clamps to 100/min")
	assert(#plan.clamped == 2, "both clamps are reported")
	expectError(function()
		TerrainAppearance.planAppearance({ grass = { enabled = true, lengthMeters = 0.5 }, materialTints = {} }, 0.28)
	end, "0.1%-1 stud")
	expectError(function()
		TerrainAppearance.planAppearance({
			water = {
				colorRgb = { r = 2, g = 0, b = 0 },
				transparency = 0,
				reflectance = 0,
				waveSizeMeters = 0.28,
				waveSpeedMeters = 0.28,
			},
			materialTints = {},
		}, 0.28)
	end, "colorRgb")
	expectError(function()
		TerrainAppearance.planAppearance({ materialTints = { {} } }, 0.28)
	end, "materialId")
end)

check("repaints plan one surface with a stable gate", function()
	local repaints = {
		{ surfaceId = "other", sourceMaterialId = "x", targetMaterialId = "y" },
		{ surfaceId = "s", sourceMaterialId = "meadow", targetMaterialId = "dune" },
		{ surfaceId = "s", sourceMaterialId = "cliff", targetMaterialId = "rock" },
	}
	local plan = TerrainRepaints.planRepaints(repaints, "s")
	assert(#plan.substitutions == 2, "only the surface repaints apply")
	assert(plan.substitutions[1].sourceId == "cliff", "substitutions sort by source")
	assert(plan.gate == "cliff>rock;meadow>dune;", "gate seals the ordered substitutions")
	local swapped = TerrainRepaints.planRepaints({ repaints[3], repaints[1], repaints[2] }, "s")
	assert(swapped.gate == plan.gate, "gate ignores declaration order")
	local empty = TerrainRepaints.planRepaints(nil, "s")
	assert(empty.gate == "" and #empty.substitutions == 0, "missing repaints plan empty")
	expectError(function()
		TerrainRepaints.planRepaints({ { surfaceId = "s", sourceMaterialId = "a", targetMaterialId = "a" } }, "s")
	end, "must differ")
	expectError(function()
		TerrainRepaints.planRepaints({ { surfaceId = "s", sourceMaterialId = "a" } }, "s")
	end, "targetMaterialId")
end)

if failures > 0 then error(failures .. " Lune checks failed") end
print("Lune verify checks passed")
