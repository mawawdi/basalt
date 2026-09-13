--!strict
-- Roblox-specific lowering for the engine-neutral height fields. The generic
-- compiler speaks meters; this adapter resamples onto Roblox's fixed four-stud
-- (1.12 meter) voxel grid. Original channels are retained until commit so any
-- failed or cancelled import restores the creator's terrain exactly.
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)

local TerrainLowering = {}
local CELL_STUDS = 4
local CELL_METERS = CELL_STUDS * Constants.STUD_METERS
local CHANNELS = { "SolidMaterial", "SolidOccupancy", "LiquidOccupancy" }
local OCCUPANCY_TOLERANCE = 1 / 255 + 0.000001
local pending: { any } = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function finite(value: any, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		fail(label .. " must be finite")
	end
	return value
end

local function material(name: any): Enum.Material
	if typeof(name) ~= "string" or #name == 0 then fail("terrain sample lacks a material id") end
	local ok, resolved = pcall(function() return (Enum.Material :: any)[name] end)
	if not ok or resolved == nil then fail("terrain material has no exact Roblox binding: " .. tostring(name)) end
	return resolved
end

local function coordinateKey(x: number, z: number): string
	return string.format("%.17g:%.17g", x, z)
end

local function uniqueCoordinates(samples: { any }, field: string): { number }
	local seen: { [string]: boolean } = {}
	local result: { number } = {}
	for _, sample in ipairs(samples) do
		local value = finite(sample[field], "terrain sample " .. field)
		local key = string.format("%.17g", value)
		if not seen[key] then
			seen[key] = true
			table.insert(result, value)
		end
	end
	table.sort(result)
	return result
end

local function nearestIndex(values: { number }, target: number): number
	local best = 1
	local distance = math.huge
	for index, value in ipairs(values) do
		local candidate = math.abs(value - target)
		if candidate < distance then
			best = index
			distance = candidate
		end
	end
	return best
end

local function grid(field: any, worldBounds: any): any
	if typeof(field.samples) ~= "table" or #field.samples < 4 then fail("terrain field is empty") end
	local xs = uniqueCoordinates(field.samples, "xMeters")
	local zs = uniqueCoordinates(field.samples, "zMeters")
	if #xs * #zs ~= #field.samples then fail("terrain field must be a complete rectangular grid") end
	local samples: { [string]: any } = {}
	local maximumElevation = -math.huge
	for _, sample in ipairs(field.samples) do
		local key = coordinateKey(sample.xMeters, sample.zMeters)
		if samples[key] ~= nil then fail("terrain field repeats a sample coordinate") end
		samples[key] = sample
		maximumElevation = math.max(maximumElevation, finite(sample.elevationMeters, "terrain elevation"))
	end
	local minimumX = math.floor(xs[1] / CELL_METERS) * CELL_METERS
	local maximumX = math.ceil(xs[#xs] / CELL_METERS) * CELL_METERS
	local minimumZ = math.floor(zs[1] / CELL_METERS) * CELL_METERS
	local maximumZ = math.ceil(zs[#zs] / CELL_METERS) * CELL_METERS
	local minimumY = math.floor(finite(worldBounds.min.y, "world minimum y") / CELL_METERS) * CELL_METERS
	local maximumY = math.ceil(maximumElevation / CELL_METERS) * CELL_METERS
	if maximumX <= minimumX then maximumX = minimumX + CELL_METERS end
	if maximumZ <= minimumZ then maximumZ = minimumZ + CELL_METERS end
	if maximumY <= minimumY then maximumY = minimumY + CELL_METERS end
	local nx = math.round((maximumX - minimumX) / CELL_METERS)
	local ny = math.round((maximumY - minimumY) / CELL_METERS)
	local nz = math.round((maximumZ - minimumZ) / CELL_METERS)
	if nx * ny * nz > Constants.MAX_TERRAIN_VOXELS then fail("terrain field exceeds the Roblox voxel budget") end
	local materials: { { { Enum.Material } } } = table.create(nx)
	local occupancy: { { { number } } } = table.create(nx)
	local liquid: { { { number } } } = table.create(nx)
	for ix = 1, nx do
		materials[ix] = table.create(ny)
		occupancy[ix] = table.create(ny)
		liquid[ix] = table.create(ny)
		local x = minimumX + (ix - 0.5) * CELL_METERS
		local sourceX = xs[nearestIndex(xs, x)]
		for iy = 1, ny do
			materials[ix][iy] = table.create(nz)
			occupancy[ix][iy] = table.create(nz)
			liquid[ix][iy] = table.create(nz)
			local cellBottom = minimumY + (iy - 1) * CELL_METERS
			for iz = 1, nz do
				local z = minimumZ + (iz - 0.5) * CELL_METERS
				local sourceZ = zs[nearestIndex(zs, z)]
				local sample = samples[coordinateKey(sourceX, sourceZ)]
				if sample == nil then fail("terrain grid lookup failed") end
				local fill = math.clamp((sample.elevationMeters - cellBottom) / CELL_METERS, 0, 1)
				materials[ix][iy][iz] = if fill > 0 then material(sample.materialId) else Enum.Material.Air
				occupancy[ix][iy][iz] = fill
				liquid[ix][iy][iz] = 0
			end
		end
	end
	local originStuds = Vector3.new(minimumX / Constants.STUD_METERS, minimumY / Constants.STUD_METERS, minimumZ / Constants.STUD_METERS)
	local region = Region3.new(originStuds, originStuds + Vector3.new(nx * CELL_STUDS, ny * CELL_STUDS, nz * CELL_STUDS))
	return {
		fieldHash = field.hash,
		region = region,
		materials = materials,
		occupancy = occupancy,
		liquid = liquid,
		dimensions = { nx, ny, nz },
	}
end

local function writeChannels(terrain: Terrain, region: Region3, channels: any): ()
	local ok, problem = pcall(function()
		terrain:WriteVoxelChannels(region, CELL_STUDS, {
			SolidMaterial = channels.materials,
			SolidOccupancy = channels.occupancy,
			LiquidOccupancy = channels.liquid,
		})
	end)
	if not ok then fail("Terrain:WriteVoxelChannels failed: " .. tostring(problem)) end
end

function TerrainLowering.begin(fields: { any }, worldBounds: any): ()
	if #pending > 0 then fail("terrain transaction is already active") end
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain") end
	for _, field in ipairs(fields) do
		local expected = grid(field, worldBounds)
		local original = terrain:ReadVoxelChannels(expected.region, CELL_STUDS, CHANNELS)
		local record = {
			fieldHash = expected.fieldHash,
			region = expected.region,
			dimensions = expected.dimensions,
			expected = expected,
			original = {
				materials = original.SolidMaterial,
				occupancy = original.SolidOccupancy,
				liquid = original.LiquidOccupancy,
			},
		}
		table.insert(pending, record)
		writeChannels(terrain, expected.region, expected)
	end
end

function TerrainLowering.verify(): ()
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain") end
	for _, record in ipairs(pending) do
		local live = terrain:ReadVoxelChannels(record.region, CELL_STUDS, CHANNELS)
		local nx, ny, nz = record.dimensions[1], record.dimensions[2], record.dimensions[3]
		for ix = 1, nx do for iy = 1, ny do for iz = 1, nz do
			if live.SolidMaterial[ix][iy][iz] ~= record.expected.materials[ix][iy][iz] then
				fail("terrain material readback drifted for " .. record.fieldHash)
			end
			if math.abs(live.SolidOccupancy[ix][iy][iz] - record.expected.occupancy[ix][iy][iz]) > OCCUPANCY_TOLERANCE then
				fail("terrain occupancy readback drifted for " .. record.fieldHash)
			end
			if math.abs(live.LiquidOccupancy[ix][iy][iz] - record.expected.liquid[ix][iy][iz]) > OCCUPANCY_TOLERANCE then
				fail("terrain liquid readback drifted for " .. record.fieldHash)
			end
		end end end
	end
end

function TerrainLowering.commit(): ()
	pending = {}
end

function TerrainLowering.rollback(): ()
	if #pending == 0 then return end
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then
		pending = {}
		return
	end
	for index = #pending, 1, -1 do
		local record = pending[index]
		writeChannels(terrain, record.region, record.original)
	end
	pending = {}
end

return TerrainLowering
