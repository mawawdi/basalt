--!strict
local Constants = require(script.Parent.Constants)
local SceneData = require(script.Parent.SceneData)
local TerrainRepaints = require(script.Parent.TerrainRepaints)
local VoxelField = require(script.Parent.VoxelField)
local VoxelSpots = require(script.Parent.VoxelSpots)
local TerrainMarkers = require(script.Parent.TerrainMarkers)
local BridgeClient = require(script.Parent.BridgeClient)

-- Voxel terrain lowering. Each chunk writes the terrain surfaces its delta
-- names; a surface whose marker proves the sealed hash and a full region is
-- spot-checked against the live voxels and skipped when clean, which keeps
-- apply idempotent across shared surfaces. Markers carry the writer chunk
-- and the written region so rollback clears exactly what was written, and
-- any marker that cannot prove itself forces a rewrite instead of a skip.
local TerrainLowering = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function loadField(surfaceId: string, entry: any, scene: any): VoxelField.DecodedVoxelField
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
	return field
end

local function fieldRegion(field: VoxelField.DecodedVoxelField): Region3
	local nx, ny, nz = field.dimensions[1], field.dimensions[2], field.dimensions[3]
	local cell = Constants.VOXEL_CELL_STUDS
	local origin = Vector3.new(field.origin[1], field.origin[2], field.origin[3])
	return Region3.new(origin, origin + Vector3.new(nx * cell, ny * cell, nz * cell))
end

local function expectedSpots(
	surfaceId: string,
	field: VoxelField.DecodedVoxelField,
	scene: any,
	repaintPlan: TerrainRepaints.RepaintPlan
): { VoxelSpots.SpotReading }
	local nx, nz = field.dimensions[1], field.dimensions[3]
	local readings: { VoxelSpots.SpotReading } = {}
	for _, cell in ipairs(VoxelSpots.cells(nx, field.dimensions[2], nz)) do
		local flat = cell.x + nx * (cell.z + nz * cell.y) + 1
		local occupancy = field.occupancy[flat]
		-- Water-only and dry-air cells lower as Air plus liquid, so they
		-- read back Air regardless of their column material.
		local material: string
		if occupancy == 0 then
			material = "Air"
		else
			local materialId = field.materials[field.materialIndex[flat] + 1]
			local mapped = scene.materialById[materialId]
			if mapped == nil then
				fail("terrain " .. surfaceId .. " has no mapped material " .. tostring(materialId))
			end
			material = mapped
			for _, substitution in ipairs(repaintPlan.substitutions) do
				local source = scene.materialById[substitution.sourceId]
				local target = scene.materialById[substitution.targetId]
				if source == nil or target == nil then
					fail("terrain " .. surfaceId .. " repaints an unmapped material")
				end
				if material == source then material = target end
			end
		end
		table.insert(readings, {
			x = cell.x,
			y = cell.y,
			z = cell.z,
			occupancy = occupancy,
			liquid = field.liquid[flat],
			material = material,
		})
	end
	return readings
end

-- Live spot readings over a region. The region comes from the marker on the
-- skip path, so a marker lying about its region reads garbage and forces a
-- rewrite instead of a skip.
local function readSpots(
	terrain: Terrain,
	surfaceId: string,
	field: VoxelField.DecodedVoxelField,
	region: Region3
): { VoxelSpots.SpotReading }
	local channels = terrain:ReadVoxelChannels(region, Constants.VOXEL_CELL_STUDS, {
		"SolidMaterial",
		"SolidOccupancy",
		"LiquidOccupancy",
	})
	local materials = channels.SolidMaterial
	local occupancy = channels.SolidOccupancy
	local liquid = channels.LiquidOccupancy
	local readings: { VoxelSpots.SpotReading } = {}
	for _, cell in ipairs(VoxelSpots.cells(field.dimensions[1], field.dimensions[2], field.dimensions[3])) do
		local material = materials[cell.x + 1][cell.y + 1][cell.z + 1]
		table.insert(readings, {
			x = cell.x,
			y = cell.y,
			z = cell.z,
			occupancy = occupancy[cell.x + 1][cell.y + 1][cell.z + 1],
			liquid = liquid[cell.x + 1][cell.y + 1][cell.z + 1],
			material = material.Name,
		})
	end
	return readings
end

local function markerView(marker: Instance, surfaceId: string): TerrainMarkers.MarkerView
	local hash = marker:GetAttribute("BasaltVoxelHash")
	local writer = marker:GetAttribute("BasaltChunkId")
	local originAttribute = marker:GetAttribute("BasaltOrigin")
	local dimensionsAttribute = marker:GetAttribute("BasaltDims")
	return {
		name = surfaceId,
		voxelHash = if typeof(hash) == "string" then hash else nil,
		chunkId = if typeof(writer) == "string" then writer else nil,
		origin = if typeof(originAttribute) == "Vector3"
			then { originAttribute.X, originAttribute.Y, originAttribute.Z }
			else nil,
		dimensions = if typeof(dimensionsAttribute) == "Vector3"
			then { dimensionsAttribute.X, dimensionsAttribute.Y, dimensionsAttribute.Z }
			else nil,
	}
end

local function markerRegion(view: TerrainMarkers.MarkerView): Region3
	local origin = view.origin :: { number }
	local dimensions = view.dimensions :: { number }
	local cell = Constants.VOXEL_CELL_STUDS
	local corner = Vector3.new(origin[1], origin[2], origin[3])
	return Region3.new(corner, corner + Vector3.new(dimensions[1] * cell, dimensions[2] * cell, dimensions[3] * cell))
end

local function writeSurface(
	terrain: Terrain,
	surfaceId: string,
	entry: any,
	scene: any,
	field: VoxelField.DecodedVoxelField
): ()
	local nx, ny, nz = field.dimensions[1], field.dimensions[2], field.dimensions[3]
	local engineMaterials: { Enum.Material } = table.create(#field.materials)
	for index, materialId in ipairs(field.materials) do
		engineMaterials[index] = SceneData.resolveEngineMaterial(scene, materialId, "terrain " .. surfaceId)
	end
	local air = Enum.Material.Air
	local materials: { { { Enum.Material } } } = table.create(nx)
	local occupancy: { { { number } } } = table.create(nx)
	local liquid: { { { number } } } = table.create(nx)
	for ix = 1, nx do
		local materialPlane: { { Enum.Material } } = table.create(ny)
		local occupancyPlane: { { number } } = table.create(ny)
		local liquidPlane: { { number } } = table.create(ny)
		materials[ix] = materialPlane
		occupancy[ix] = occupancyPlane
		liquid[ix] = liquidPlane
		for iy = 1, ny do
			local materialRow: { Enum.Material } = table.create(nz)
			local occupancyRow: { number } = table.create(nz)
			local liquidRow: { number } = table.create(nz)
			materialPlane[iy] = materialRow
			occupancyPlane[iy] = occupancyRow
			liquidPlane[iy] = liquidRow
			for iz = 1, nz do
				local flat = (ix - 1) + nx * ((iz - 1) + nz * (iy - 1)) + 1
				local solid = field.occupancy[flat]
				-- The engine no longer accepts a Water solid material: a
				-- voxel holding only water lowers as Air plus liquid.
				materialRow[iz] = if solid == 0 then air else engineMaterials[field.materialIndex[flat] + 1]
				occupancyRow[iz] = solid
				liquidRow[iz] = field.liquid[flat]
			end
		end
	end
	local region = fieldRegion(field)
	local ok, writeError = pcall(function()
		terrain:WriteVoxelChannels(region, Constants.VOXEL_CELL_STUDS, {
			SolidMaterial = materials,
			SolidOccupancy = occupancy,
			LiquidOccupancy = liquid,
		})
	end)
	if not ok then fail("Terrain:WriteVoxelChannels failed for " .. surfaceId .. ": " .. tostring(writeError)) end
end

function TerrainLowering.clearRegion(terrain: Terrain, origin: { number }, dimensions: { number }): ()
	local cell = Constants.VOXEL_CELL_STUDS
	local corner = Vector3.new(origin[1], origin[2], origin[3])
	local region =
		Region3.new(corner, corner + Vector3.new(dimensions[1] * cell, dimensions[2] * cell, dimensions[3] * cell))
	local nx, ny, nz = dimensions[1], dimensions[2], dimensions[3]
	local materials: { { { Enum.Material } } } = table.create(nx)
	local occupancy: { { { number } } } = table.create(nx)
	local liquid: { { { number } } } = table.create(nx)
	for ix = 1, nx do
		local materialPlane: { { Enum.Material } } = table.create(ny)
		local occupancyPlane: { { number } } = table.create(ny)
		local liquidPlane: { { number } } = table.create(ny)
		materials[ix] = materialPlane
		occupancy[ix] = occupancyPlane
		liquid[ix] = liquidPlane
		for iy = 1, ny do
			local materialRow: { Enum.Material } = table.create(nz)
			local occupancyRow: { number } = table.create(nz)
			local liquidRow: { number } = table.create(nz)
			materialPlane[iy] = materialRow
			occupancyPlane[iy] = occupancyRow
			liquidPlane[iy] = liquidRow
			for iz = 1, nz do
				materialRow[iz] = Enum.Material.Air
				occupancyRow[iz] = 0
				liquidRow[iz] = 0
			end
		end
	end
	local ok, writeError = pcall(function()
		terrain:WriteVoxelChannels(region, Constants.VOXEL_CELL_STUDS, {
			SolidMaterial = materials,
			SolidOccupancy = occupancy,
			LiquidOccupancy = liquid,
		})
	end)
	if not ok then fail("Terrain:WriteVoxelChannels failed to clear: " .. tostring(writeError)) end
end

function TerrainLowering.markerView(marker: Instance, surfaceId: string): TerrainMarkers.MarkerView
	return markerView(marker, surfaceId)
end

-- Lower every chunk surface and return the live spot readings per surface.
-- Proven markers skip their write after a clean spot check; suspect markers
-- and drifted voxels force a rewrite, and fresh writes read back their own
-- spots so the observation always describes live voxels.
local function applyRepaints(
	terrain: Terrain,
	surfaceId: string,
	scene: any,
	field: VoxelField.DecodedVoxelField,
	plan: TerrainRepaints.RepaintPlan
): ()
	if #plan.substitutions == 0 then return end
	local region = fieldRegion(field)
	for _, substitution in ipairs(plan.substitutions) do
		local source =
			SceneData.resolveEngineMaterial(scene, substitution.sourceId, "repaint " .. surfaceId)
		local target =
			SceneData.resolveEngineMaterial(scene, substitution.targetId, "repaint " .. surfaceId)
		local ok, repaintError = pcall(function()
			terrain:ReplaceMaterial(region, Constants.VOXEL_CELL_STUDS, source, target)
		end)
		if not ok then
			fail("Terrain:ReplaceMaterial failed for " .. surfaceId .. ": " .. tostring(repaintError))
		end
	end
end

function TerrainLowering.lowerTerrain(
	parent: Instance,
	scene: any
): { { surfaceId: string, readings: { VoxelSpots.SpotReading } } }
	local terrain = workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain to write") end
	local folder = parent:FindFirstChild("terrain")
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = "terrain"
		folder.Parent = parent
	end
	local chunkId = scene.chunkDelta.chunkId
	local observed: { { surfaceId: string, readings: { VoxelSpots.SpotReading } } } = {}
	for _, surfaceId in ipairs(scene.chunkDelta.surfaceIds) do
		local entry = scene.terrainById[surfaceId]
		if entry == nil then fail("scene export has no terrain " .. surfaceId) end
		local repaintPlan = TerrainRepaints.planRepaints(scene.terrainRepaints, surfaceId)
		local marker = folder:FindFirstChild(surfaceId)
		if marker ~= nil then
			local view = markerView(marker, surfaceId)
			local suspect = TerrainMarkers.isSuspect(view, entry.voxelHash)
			local painted = marker:GetAttribute("BasaltRepaints")
			if (if typeof(painted) == "string" then painted else "") ~= repaintPlan.gate then
				suspect = true
			end
			if not suspect then
				local field = loadField(surfaceId, entry, scene)
				local live = readSpots(terrain, surfaceId, field, markerRegion(view))
				local drift = VoxelSpots.findDrift(
					expectedSpots(surfaceId, field, scene, repaintPlan),
					live,
					Constants.VOXEL_SPOT_TOLERANCE
				)
				if drift == nil then
					table.insert(observed, { surfaceId = surfaceId, readings = live })
					continue
				end
			end
			marker:Destroy()
		end
		local field = loadField(surfaceId, entry, scene)
		writeSurface(terrain, surfaceId, entry, scene, field)
		applyRepaints(terrain, surfaceId, scene, field, repaintPlan)
		local fresh = Instance.new("Folder")
		fresh.Name = surfaceId
		fresh:SetAttribute("BasaltSurfaceId", surfaceId)
		fresh:SetAttribute("BasaltVoxelHash", entry.voxelHash)
		fresh:SetAttribute("BasaltChunkId", chunkId)
		fresh:SetAttribute("BasaltRepaints", repaintPlan.gate)
		fresh:SetAttribute(
			"BasaltOrigin",
			Vector3.new(field.origin[1], field.origin[2], field.origin[3])
		)
		fresh:SetAttribute(
			"BasaltDims",
			Vector3.new(field.dimensions[1], field.dimensions[2], field.dimensions[3])
		)
		fresh.Parent = folder
		local live = readSpots(terrain, surfaceId, field, fieldRegion(field))
		table.insert(observed, { surfaceId = surfaceId, readings = live })
	end
	return observed
end

return TerrainLowering
