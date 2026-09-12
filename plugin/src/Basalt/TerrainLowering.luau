--!strict
local Constants = require(script.Parent.Constants)
local SceneData = require(script.Parent.SceneData)
local VoxelField = require(script.Parent.VoxelField)
local BridgeClient = require(script.Parent.BridgeClient)

-- Voxel terrain lowering. Each chunk writes the terrain surfaces its delta
-- names; a surface whose marker already carries the sealed voxel hash is
-- skipped, which makes apply idempotent across shared surfaces. Terrain
-- voxels are global to the place: rollback removes constructed parts but
-- never rewrites terrain, and markers persist to reflect that reality.
local TerrainLowering = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function writeSurface(terrain: Terrain, surfaceId: string, entry: any, scene: any): ()
	local payloadEntry = scene.payloadsByHash[entry.voxelHash]
	if payloadEntry == nil then fail("scene export has no voxel payload for " .. surfaceId) end
	local bytes = BridgeClient.getBytes("/payload/" .. entry.voxelHash)
	if #bytes ~= payloadEntry.byteLength then
		fail("voxel payload length disagrees with manifest for " .. surfaceId)
	end
	local field = VoxelField.decode(bytes)
	local dimensions = entry.dimensions
	if field.dimensions[1] ~= dimensions[1] or field.dimensions[2] ~= dimensions[2] or field.dimensions[3] ~= dimensions[3] then
		fail("voxel payload dimensions disagree with manifest for " .. surfaceId)
	end
	if #field.materials ~= #entry.materials then
		fail("voxel payload materials disagree with manifest for " .. surfaceId)
	end
	for index, name in ipairs(field.materials) do
		if name ~= entry.materials[index] then
			fail("voxel payload materials disagree with manifest for " .. surfaceId)
		end
	end
	if field.cellSize ~= Constants.VOXEL_CELL_STUDS then
		fail("terrain lowering requires " .. tostring(Constants.VOXEL_CELL_STUDS) .. "-stud voxels")
	end
	for _, axis in ipairs(field.origin) do
		if axis % Constants.VOXEL_CELL_STUDS ~= 0 then
			fail("voxel origin is not cell-aligned for " .. surfaceId)
		end
	end
	local nx, ny, nz = field.dimensions[1], field.dimensions[2], field.dimensions[3]
	local engineMaterials: { Enum.Material } = table.create(#field.materials)
	for index, materialId in ipairs(field.materials) do
		engineMaterials[index] = SceneData.resolveEngineMaterial(scene, materialId, "terrain " .. surfaceId)
	end
	local materials: { { { Enum.Material } } } = table.create(nx)
	local occupancy: { { { number } } } = table.create(nx)
	for ix = 1, nx do
		local materialPlane: { { Enum.Material } } = table.create(ny)
		local occupancyPlane: { { number } } = table.create(ny)
		materials[ix] = materialPlane
		occupancy[ix] = occupancyPlane
		for iy = 1, ny do
			local materialRow: { Enum.Material } = table.create(nz)
			local occupancyRow: { number } = table.create(nz)
			materialPlane[iy] = materialRow
			occupancyPlane[iy] = occupancyRow
			for iz = 1, nz do
				local flat = (ix - 1) + nx * ((iz - 1) + nz * (iy - 1)) + 1
				materialRow[iz] = engineMaterials[field.materialIndex[flat] + 1]
				occupancyRow[iz] = field.occupancy[flat]
			end
		end
	end
	local cell = Constants.VOXEL_CELL_STUDS
	local origin = Vector3.new(field.origin[1], field.origin[2], field.origin[3])
	local region = Region3.new(origin, origin + Vector3.new(nx * cell, ny * cell, nz * cell))
	local ok, writeError = pcall(function()
		terrain:WriteVoxels(region, Constants.VOXEL_CELL_STUDS, materials, occupancy)
	end)
	if not ok then fail("Terrain:WriteVoxels failed for " .. surfaceId .. ": " .. tostring(writeError)) end
end

function TerrainLowering.lowerTerrain(parent: Instance, scene: any): ()
	local terrain = workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain to write") end
	local folder = parent:FindFirstChild("terrain")
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = "terrain"
		folder.Parent = parent
	end
	for _, surfaceId in ipairs(scene.chunkDelta.surfaceIds) do
		local entry = scene.terrainById[surfaceId]
		if entry == nil then fail("scene export has no terrain " .. surfaceId) end
		local marker = folder:FindFirstChild(surfaceId)
		if marker ~= nil and marker:GetAttribute("BasaltVoxelHash") == entry.voxelHash then
			continue
		end
		if marker ~= nil then marker:Destroy() end
		writeSurface(terrain, surfaceId, entry, scene)
		local fresh = Instance.new("Folder")
		fresh.Name = surfaceId
		fresh:SetAttribute("BasaltSurfaceId", surfaceId)
		fresh:SetAttribute("BasaltVoxelHash", entry.voxelHash)
		fresh.Parent = folder
	end
end

return TerrainLowering
