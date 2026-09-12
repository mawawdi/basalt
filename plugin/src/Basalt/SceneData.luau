--!strict
local BridgeClient = require(script.Parent.BridgeClient)
local Constants = require(script.Parent.Constants)

-- One fetched view over the queued chunk: emission delta plus the scene
-- export and both adapter-owned docs, indexed for lowering. The bridge
-- verified every hash at enqueue time over loopback; the connector
-- validates kinds, ABIs, conventions, and bindings, then fails closed.
local SceneData = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or string.match(value, "^[a-f0-9]+$") == nil or #value ~= 64 then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function requireNumber(value: any, label: string): number
	if typeof(value) ~= "number" then fail(label .. " must be a number") end
	return value
end

local function requireVector(value: any, label: string): { x: number, y: number, z: number }
	if typeof(value) ~= "table" then fail(label .. " must be a vector") end
	return {
		x = requireNumber(value.x, label .. ".x"),
		y = requireNumber(value.y, label .. ".y"),
		z = requireNumber(value.z, label .. ".z"),
	}
end

local function checkExportConvention(mod: any): any
	if typeof(mod) ~= "table" then fail("scene export must be a table") end
	if mod.kind ~= "BasaltSceneExport" then fail("scene export has an unexpected kind") end
	if mod.abi ~= Constants.SCENE_EXPORT_ABI then fail("scene export ABI is unsupported") end
	requireHash(mod.hash, "scene export hash")
	if mod.studMeters ~= Constants.STUD_METERS then fail("scene export stud length is unsupported") end
	local convention = mod.placementConvention
	if typeof(convention) ~= "table" then fail("scene export lacks its placement convention") end
	if convention.lengthUnit ~= "meter" then fail("scene export length unit is unsupported") end
	if convention.upAxis ~= "+Y" then fail("scene export up axis is unsupported") end
	if convention.handedness ~= "right-handed" then fail("scene export handedness is unsupported") end
	if convention.instanceComposition ~= Constants.SCENE_EXPORT_COMPOSITION then
		fail("scene export instance composition is unsupported")
	end
	for _, key in ipairs({ "instances", "assets", "parts", "terrain", "roads", "payloads" }) do
		if typeof(mod[key]) ~= "table" then fail("scene export lacks " .. key) end
	end
	return mod
end

local function indexBy(list: any, key: string, label: string): { [string]: any }
	local indexed: { [string]: any } = {}
	for _, entry in ipairs(list) do
		local id = entry[key]
		if typeof(id) ~= "string" or #id == 0 then fail(label .. " entry lacks " .. key) end
		if indexed[id] ~= nil then fail(label .. " repeats " .. key .. " " .. id) end
		indexed[id] = entry
	end
	return indexed
end

local function checkInstance(entry: any): ()
	requireVector(entry.positionMeters, "instance " .. tostring(entry.id) .. " positionMeters")
	if typeof(entry.rotation) ~= "table" or #entry.rotation ~= 4 then
		fail("instance " .. tostring(entry.id) .. " lacks a rotation quaternion")
	end
	for index, component in ipairs(entry.rotation) do
		requireNumber(component, "instance " .. tostring(entry.id) .. " rotation")
	end
	if typeof(entry.scale) ~= "number" or entry.scale <= 0 then
		fail("instance " .. tostring(entry.id) .. " lacks a positive scale")
	end
end

local function checkAsset(entry: any): ()
	requireVector(entry.pivotOffsetMeters, "asset " .. tostring(entry.assetId) .. " pivotOffsetMeters")
	if typeof(entry.unitsToMeters) ~= "number" or entry.unitsToMeters <= 0 then
		fail("asset " .. tostring(entry.assetId) .. " lacks unitsToMeters")
	end
	if typeof(entry.partHashes) ~= "table" or #entry.partHashes == 0 then
		fail("asset " .. tostring(entry.assetId) .. " lacks partHashes")
	end
end

function SceneData.load(chunkId: string): any
	local manifest = BridgeClient.getJson("/manifest")
	if manifest == nil then fail("bridge has no queued emission manifest") end
	if typeof(manifest.chunks) ~= "table" then fail("emission manifest lacks chunks") end
	local chunkDelta = nil
	for _, chunk in ipairs(manifest.chunks) do
		if chunk.chunkId == chunkId then chunkDelta = chunk end
	end
	if chunkDelta == nil then fail("emission manifest has no chunk " .. chunkId) end
	if typeof(chunkDelta.surfaceIds) ~= "table" then fail("chunk delta lacks surfaceIds") end

	local rawExport = BridgeClient.getJson("/export")
	if rawExport == nil then fail("bridge has no scene export; restart it with --export-dir") end
	local mod = checkExportConvention(rawExport)
	local instancesById = indexBy(mod.instances, "id", "scene export instances")
	local assetsById = indexBy(mod.assets, "assetId", "scene export assets")
	local partsByHash: { [string]: any } = {}
	for _, part in ipairs(mod.parts) do
		requireHash(part.contentHash, "scene part contentHash")
		if partsByHash[part.contentHash] ~= nil then
			fail("scene export repeats part " .. part.contentHash)
		end
		requireVector(part.boundsSourceUnits.minimum, "part " .. part.contentHash .. " minimum")
		requireVector(part.boundsSourceUnits.maximum, "part " .. part.contentHash .. " maximum")
		requireVector(part.pivotSourceUnits, "part " .. part.contentHash .. " pivotSourceUnits")
		partsByHash[part.contentHash] = part
	end
	local terrainById = indexBy(mod.terrain, "surfaceId", "scene export terrain")
	local payloadsByHash: { [string]: any } = {}
	for _, entry in ipairs(mod.payloads) do
		requireHash(entry.contentHash, "scene payload contentHash")
		payloadsByHash[entry.contentHash] = entry
	end
	local roadSegmentsById: { [string]: any } = {}
	for _, road in ipairs(mod.roads) do
		for _, segment in ipairs(road.segments) do
			if roadSegmentsById[segment.id] ~= nil then
				fail("scene export repeats road segment " .. segment.id)
			end
			roadSegmentsById[segment.id] = { segment = segment, routeId = road.routeId }
		end
	end

	local sidecar = BridgeClient.getJson("/sidecar")
	if sidecar == nil then fail("bridge has no engine sidecar; restart it with --sidecar") end
	if sidecar.kind ~= "BasaltEngineSidecar" then fail("engine sidecar has an unexpected kind") end
	if sidecar.abi ~= Constants.ENGINE_SIDECAR_ABI then fail("engine sidecar ABI is unsupported") end
	if sidecar.engine ~= "roblox" then fail("engine sidecar targets another engine") end
	if sidecar.exportHash ~= mod.hash then fail("engine sidecar binds a different scene export") end
	if typeof(sidecar.bindings) ~= "table" then fail("engine sidecar lacks bindings") end
	local assetByPartHash: { [string]: number } = {}
	for _, binding in ipairs(sidecar.bindings) do
		requireHash(binding.contentHash, "sidecar binding contentHash")
		local assetId = tonumber(binding.assetId)
		if assetId == nil then fail("sidecar binding is not a bare asset id") end
		assetByPartHash[binding.contentHash] = assetId
	end

	local materialMap = BridgeClient.getJson("/material-map")
	if materialMap == nil then fail("bridge has no material map; restart it with --material-map") end
	if materialMap.kind ~= "BasaltMaterialMap" then fail("material map has an unexpected kind") end
	if materialMap.abi ~= Constants.MATERIAL_MAP_ABI then fail("material map ABI is unsupported") end
	if materialMap.engine ~= "roblox" then fail("material map targets another engine") end
	if materialMap.exportHash ~= mod.hash then fail("material map binds a different scene export") end
	if typeof(materialMap.bindings) ~= "table" then fail("material map lacks bindings") end
	local materialById: { [string]: string } = {}
	for _, binding in ipairs(materialMap.bindings) do
		if typeof(binding.materialId) ~= "string" or #binding.materialId == 0 then
			fail("material map binding lacks materialId")
		end
		if typeof(binding.robloxMaterial) ~= "string" or #binding.robloxMaterial == 0 then
			fail("material map binding lacks robloxMaterial")
		end
		materialById[binding.materialId] = binding.robloxMaterial
	end

	return {
		exportHash = mod.hash,
		chunkDelta = chunkDelta,
		instancesById = instancesById,
		assetsById = assetsById,
		partsByHash = partsByHash,
		terrainById = terrainById,
		payloadsByHash = payloadsByHash,
		roadSegmentsById = roadSegmentsById,
		assetByPartHash = assetByPartHash,
		materialById = materialById,
	}
end

-- Availability preflight: every id the transaction names must resolve to a
-- bound part, a mapped material, or a present surface before apply starts.
function SceneData.checkAvailability(scene: any, transaction: any): ()
	for _, instanceId in ipairs(transaction.instanceIds) do
		local instance = scene.instancesById[instanceId]
		if instance == nil then fail("scene export has no instance " .. instanceId) end
		if instance.chunkId ~= transaction.chunkId then
			fail("instance " .. instanceId .. " belongs to another chunk")
		end
		checkInstance(instance)
		local asset = scene.assetsById[instance.assetId]
		if asset == nil then fail("scene export has no asset " .. tostring(instance.assetId)) end
		checkAsset(asset)
		for _, partHash in ipairs(asset.partHashes) do
			if scene.partsByHash[partHash] == nil then
				fail("scene export has no part " .. partHash)
			end
			if scene.assetByPartHash[partHash] == nil then
				fail("part " .. partHash .. " has no upload binding; upload it, rebuild the sidecar, restart the bridge")
			end
		end
	end
	for _, segmentId in ipairs(transaction.roadSegmentIds) do
		local resolved = scene.roadSegmentsById[segmentId]
		if resolved == nil then fail("scene export has no road segment " .. segmentId) end
		if resolved.segment.chunkId ~= transaction.chunkId then
			fail("road segment " .. segmentId .. " belongs to another chunk")
		end
		if scene.materialById[resolved.segment.materialId] == nil then
			fail("road segment " .. segmentId .. " has no mapped material")
		end
	end
	for _, surfaceId in ipairs(scene.chunkDelta.surfaceIds) do
		local entry = scene.terrainById[surfaceId]
		if entry == nil then fail("scene export has no terrain " .. surfaceId) end
		if scene.payloadsByHash[entry.voxelHash] == nil then
			fail("scene export has no voxel payload " .. tostring(entry.voxelHash))
		end
		for _, materialId in ipairs(entry.materials) do
			if scene.materialById[materialId] == nil then
				fail("terrain " .. surfaceId .. " has no mapped material " .. tostring(materialId))
			end
		end
	end
end

local engineMaterials: { [string]: Enum.Material }? = nil

function SceneData.resolveEngineMaterial(scene: any, materialId: string, context: string): Enum.Material
	local name = scene.materialById[materialId]
	if name == nil then fail(context .. " has no mapped material " .. materialId) end
	if engineMaterials == nil then
		local byName: { [string]: Enum.Material } = {}
		for _, item in ipairs(Enum.Material:GetEnumItems()) do
			byName[item.Name] = item
		end
		engineMaterials = byName
	end
	local material = (engineMaterials :: { [string]: Enum.Material })[name]
	if material == nil then fail(context .. " names an unknown engine material " .. name) end
	return material
end

return SceneData
