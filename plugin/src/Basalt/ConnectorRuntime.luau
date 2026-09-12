--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)
local BridgeClient = require(script.Parent.BridgeClient)
local SceneData = require(script.Parent.SceneData)
local InstanceLowering = require(script.Parent.InstanceLowering)
local TerrainLowering = require(script.Parent.TerrainLowering)
local RoadLowering = require(script.Parent.RoadLowering)
local SkirtLowering = require(script.Parent.SkirtLowering)
local TerrainMarkers = require(script.Parent.TerrainMarkers)

local ConnectorRuntime = {}
local activeRecording: any = nil

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or string.match(value, "^[a-f0-9]+$") == nil or #value ~= 64 then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function requireId(value: any, label: string): string
	if typeof(value) ~= "string" or string.match(value, "^[A-Za-z][A-Za-z0-9_-]*$") == nil then
		fail(label .. " is invalid")
	end
	return value
end

local function beginRecording(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	if typeof(transaction) ~= "table" then fail("transaction must be a table") end
	requireHash(transaction.hash, "transaction.hash")
	requireHash(transaction.worldPlanHash, "transaction.worldPlanHash")
	requireHash(transaction.chunkHash, "transaction.chunkHash")
	requireId(transaction.chunkId, "transaction.chunkId")
	if typeof(transaction.instanceIds) ~= "table" then fail("transaction.instanceIds must be an array") end
	if #transaction.instanceIds > Constants.MAX_WORLD_INSTANCES_PER_CHUNK then
		fail("transaction.instanceIds exceeds its bound")
	end
	local seen = {}
	for _, instanceId in ipairs(transaction.instanceIds) do
		local id = requireId(instanceId, "transaction.instanceId")
		if seen[id] then fail("transaction.instanceIds must be unique") end
		seen[id] = true
	end
	if typeof(transaction.roadSegmentIds) ~= "table" then fail("transaction.roadSegmentIds must be an array") end
	if #transaction.roadSegmentIds > Constants.MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK then
		fail("transaction.roadSegmentIds exceeds its bound")
	end
	local seenRoads = {}
	for _, segmentId in ipairs(transaction.roadSegmentIds) do
		local id = requireId(segmentId, "transaction.roadSegmentId")
		if seenRoads[id] then fail("transaction.roadSegmentIds must be unique") end
		seenRoads[id] = true
	end
	if transaction.phase ~= "preflight" and transaction.phase ~= "apply" and transaction.phase ~= "commit" and transaction.phase ~= "rollback" then
		fail("transaction.phase is invalid")
	end
	activeRecording = { hash = transaction.hash, chunkId = transaction.chunkId }
	return activeRecording
end

local function readRevision(): string
	local value = Workspace:GetAttribute("BasaltWorldRevisionHash")
	if typeof(value) ~= "string" then return string.rep("0", 64) end
	return requireHash(value, "BasaltWorldRevisionHash")
end

-- A failed phase must never wedge the recording open: run the body
-- protected and always release before returning or rethrowing.
local function withRecording(_recording: any, body: () -> ()): ()
	local ok, failure = pcall(body)
	activeRecording = nil
	if not ok then error(failure) end
end

function ConnectorRuntime.detachedPreflight(transaction: any): any
	if transaction.phase ~= "preflight" then fail("detachedPreflight requires a preflight transaction") end
	local recording = beginRecording(transaction)
	-- Availability only: every named id resolves to a bound part, a mapped
	-- material, or a present surface. Nothing is constructed here.
	withRecording(recording, function()
		local scene = SceneData.load(recording.chunkId)
		SceneData.checkAvailability(scene, transaction)
	end)
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "preflighted",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
		observedRoadSegmentIds = transaction.roadSegmentIds,
		observedVoxelSpots = {},
		observedImportFactors = {},
	}
end

-- Observed ids mean constructed geometry, not echoed ids: every observed
-- instance has a lowered model with parts, every observed road segment a
-- ribbon folder, every chunk surface a voxel marker.
local function verifyConstruction(folder: Instance, transaction: any, scene: any): ()
	local instances = folder:FindFirstChild("instances")
	if instances == nil and #transaction.instanceIds > 0 then
		fail("chunk lowered no instances")
	end
	for _, instanceId in ipairs(transaction.instanceIds) do
		local model = (instances :: Instance):FindFirstChild(instanceId)
		if model == nil then fail("chunk lowered no geometry for instance " .. instanceId) end
		local placed = false
		for _, descendant in ipairs(model:GetDescendants()) do
			if descendant:IsA("BasePart") then placed = true end
		end
		if not placed then fail("instance " .. instanceId .. " lowered no parts") end
	end
	local roads = folder:FindFirstChild("roads")
	if roads == nil and #transaction.roadSegmentIds > 0 then fail("chunk lowered no roads") end
	for _, segmentId in ipairs(transaction.roadSegmentIds) do
		local segmentFolder = (roads :: Instance):FindFirstChild(segmentId)
		if segmentFolder == nil then fail("chunk lowered no geometry for road " .. segmentId) end
		if #segmentFolder:GetChildren() == 0 then
			fail("road segment " .. segmentId .. " lowered no ribbon")
		end
	end
	local skirts = folder:FindFirstChild("skirts")
	for _, instanceId in ipairs(transaction.instanceIds) do
		if scene.skirtsByInstanceId[instanceId] ~= nil then
			local skirtFolder = if skirts ~= nil then skirts:FindFirstChild(instanceId) else nil
			if skirtFolder == nil then fail("chunk lowered no skirt for instance " .. instanceId) end
			if #skirtFolder:GetChildren() == 0 then
				fail("skirt " .. instanceId .. " lowered no curtain")
			end
		end
	end
	local terrainFolder = folder:FindFirstChild("terrain")
	for _, surfaceId in ipairs(scene.chunkDelta.surfaceIds) do
		local entry = scene.terrainById[surfaceId]
		local marker = if terrainFolder ~= nil then terrainFolder:FindFirstChild(surfaceId) else nil
		if marker == nil or marker:GetAttribute("BasaltVoxelHash") ~= entry.voxelHash then
			fail("chunk wrote no voxels for surface " .. surfaceId)
		end
	end
end

function ConnectorRuntime.applyChunk(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "apply" then fail("applyChunk requires an apply transaction") end
	local chunkId = requireId(transaction.chunkId, "transaction.chunkId")
	if chunkId ~= recording.chunkId then fail("transaction does not match its recording") end
	local folder = Workspace:FindFirstChild(chunkId)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = chunkId
		folder.Parent = Workspace
	end
	folder:SetAttribute("BasaltChunkHash", requireHash(transaction.chunkHash, "transaction.chunkHash"))
	folder:SetAttribute("BasaltWorldPlanHash", requireHash(transaction.worldPlanHash, "transaction.worldPlanHash"))
	local observedSpots: { any } = {}
	local observedFactors: { any } = {}
	withRecording(recording, function()
		local scene = SceneData.load(chunkId)
		local factors = InstanceLowering.lowerInstances(folder, transaction, scene)
		local surfaces = TerrainLowering.lowerTerrain(folder, scene)
		RoadLowering.lowerRoads(folder, transaction, scene)
		SkirtLowering.lowerSkirts(folder, transaction, scene)
		verifyConstruction(folder, transaction, scene)
		for _, surface in ipairs(surfaces) do
			for _, reading in ipairs(surface.readings) do
				table.insert(observedSpots, {
					surfaceId = surface.surfaceId,
					x = reading.x,
					y = reading.y,
					z = reading.z,
					occupancy = reading.occupancy,
					material = reading.material,
				})
			end
		end
		for partHash, factor in pairs(factors) do
			table.insert(observedFactors, { contentHash = partHash, factor = factor })
		end
		table.sort(observedSpots, function(left: any, right: any): boolean
			if left.surfaceId ~= right.surfaceId then return left.surfaceId < right.surfaceId end
			if left.x ~= right.x then return left.x < right.x end
			if left.y ~= right.y then return left.y < right.y end
			return left.z < right.z
		end)
		table.sort(observedFactors, function(left: any, right: any): boolean
			return left.contentHash < right.contentHash
		end)
	end)
	ChangeHistoryService:SetWaypoint("Basalt apply " .. chunkId)
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "applied",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
		observedRoadSegmentIds = transaction.roadSegmentIds,
		observedVoxelSpots = observedSpots,
		observedImportFactors = observedFactors,
	}
end

function ConnectorRuntime.commit(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "commit" then fail("commit requires a commit transaction") end
	withRecording(recording, function()
		ChangeHistoryService:SetWaypoint("Basalt commit " .. recording.chunkId)
	end)
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "committed",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
		observedRoadSegmentIds = transaction.roadSegmentIds,
		observedVoxelSpots = {},
		observedImportFactors = {},
	}
end

function ConnectorRuntime.rollback(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "rollback" then fail("rollback requires a rollback transaction") end
	-- Constructed parts roll back, and terrain voxels this chunk wrote clear
	-- to air from the marker-carried region: no scene load, so rollback
	-- clears exactly what was written even across export changes. Markers
	-- this chunk did not write stay untouched, and legacy markers without a
	-- writer drop so the next apply rewrites them.
	withRecording(recording, function()
		local folder = Workspace:FindFirstChild(recording.chunkId)
		if folder ~= nil then
			local instances = folder:FindFirstChild("instances")
			if instances ~= nil then instances:Destroy() end
			local roads = folder:FindFirstChild("roads")
			if roads ~= nil then roads:Destroy() end
			local skirts = folder:FindFirstChild("skirts")
			if skirts ~= nil then skirts:Destroy() end
			local terrainFolder = folder:FindFirstChild("terrain")
			if terrainFolder ~= nil then
				local markers: { TerrainMarkers.MarkerView } = {}
				for _, child in ipairs(terrainFolder:GetChildren()) do
					table.insert(markers, TerrainLowering.markerView(child, child.Name))
				end
				local plan =
					TerrainMarkers.planClear(markers, recording.chunkId, Constants.VOXEL_CELL_STUDS)
				if #plan.clear > 0 then
					local terrain = Workspace:FindFirstChildOfClass("Terrain")
					if terrain == nil then fail("place has no Terrain to clear") end
					for _, clear in ipairs(plan.clear) do
						TerrainLowering.clearRegion(terrain, clear.origin, clear.dimensions)
						local marker = terrainFolder:FindFirstChild(clear.name)
						if marker ~= nil then marker:Destroy() end
					end
				end
				for _, name in ipairs(plan.drop) do
					local marker = terrainFolder:FindFirstChild(name)
					if marker ~= nil then marker:Destroy() end
				end
			end
		end
		ChangeHistoryService:SetWaypoint("Basalt rollback " .. recording.chunkId)
	end)
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "rolled_back",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
		observedRoadSegmentIds = transaction.roadSegmentIds,
		observedVoxelSpots = {},
		observedImportFactors = {},
	}
end

-- Apply one bounded transaction phase and let the host seal the observation.
function ConnectorRuntime.syncOnce(): any
	local transaction = BridgeClient.getJson("/poll")
	if transaction == nil then
		print("Basalt world connector: no pending chunk transaction")
		return nil
	end
	local observation
	if transaction.phase == "preflight" then
		observation = ConnectorRuntime.detachedPreflight(transaction)
	elseif transaction.phase == "apply" then
		observation = ConnectorRuntime.applyChunk(transaction)
	elseif transaction.phase == "commit" then
		observation = ConnectorRuntime.commit(transaction)
	elseif transaction.phase == "rollback" then
		observation = ConnectorRuntime.rollback(transaction)
	else
		fail("bridge returned an unsupported transaction phase")
	end
	local status = BridgeClient.postJson("/settle", { transaction = transaction, readback = observation })
	print("Basalt world connector settled " .. transaction.chunkId .. " (" .. transaction.phase .. ")")
	return status
end

function ConnectorRuntime.start(pluginInstance: Plugin)
	local toolbar = pluginInstance:CreateToolbar("Basalt")
	local button = toolbar:CreateButton("BasaltWorld", "Sync one Basalt world transaction", "")
	button.Click:Connect(function()
		local ok, errorMessage = pcall(ConnectorRuntime.syncOnce)
		if not ok then warn("Basalt world connector: " .. tostring(errorMessage)) end
	end)
end

return ConnectorRuntime
