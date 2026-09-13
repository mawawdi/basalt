--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService = game:GetService("InsertService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)
local TerrainLowering = require(script.Parent.TerrainLowering)

local WorldLowering = {}
local pendingFoundation: any = nil
local pendingMeso: any = nil
local pendingInstances: { [string]: any } = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or #value ~= 64 or string.match(value, "^[a-f0-9]+$") == nil then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function meters(value: number): number
	return value / Constants.STUD_METERS
end

local function quaternion(value: any): CFrame
	if typeof(value) ~= "table" or #value ~= 4 then fail("rotation must be a quaternion") end
	local x, y, z, w = value[1], value[2], value[3], value[4]
	if typeof(x) ~= "number" or typeof(y) ~= "number" or typeof(z) ~= "number" or typeof(w) ~= "number" then
		fail("rotation quaternion is malformed")
	end
	local length = math.sqrt(x * x + y * y + z * z + w * w)
	if math.abs(length - 1) > 0.00001 then fail("rotation quaternion is not normalized") end
	return CFrame.new(
		0, 0, 0,
		1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
		2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
		2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
	)
end

local function pathChild(parent: Instance, segment: any): Instance
	if typeof(segment) ~= "table" or typeof(segment.name) ~= "string" or typeof(segment.siblingOrdinal) ~= "number" then
		fail("material expectation has a malformed part path")
	end
	local ordinal = 0
	for _, child in ipairs(parent:GetChildren()) do
		if child.Name == segment.name then
			if ordinal == segment.siblingOrdinal then return child end
			ordinal += 1
		end
	end
	fail("material expectation path does not resolve: " .. segment.name)
end

local function resolvePart(model: Model, path: any): BasePart
	if typeof(path) ~= "table" or #path == 0 then fail("material expectation path is empty") end
	local current: Instance = model
	for _, segment in ipairs(path) do current = pathChild(current, segment) end
	if not current:IsA("BasePart") then fail("material expectation does not resolve to a BasePart") end
	return current
end

local function roundedChannel(value: number): number
	return math.floor(value * 255 + 0.5)
end

local function verifyMaterialExpectations(model: Model, expectations: any): ()
	if typeof(expectations) ~= "table" or #expectations == 0 then fail("loaded asset has no material expectations") end
	local checked = {}
	for _, expectation in ipairs(expectations) do
		local part = resolvePart(model, expectation.partPath)
		if checked[part] then fail("material expectations repeat a part") end
		checked[part] = true
		if part.ClassName ~= expectation.className or part.Material.Name ~= expectation.material then
			fail("material class or enum drifted for " .. part:GetFullName())
		end
		local color = expectation.color
		if typeof(color) ~= "table" or roundedChannel(part.Color.R) ~= color.red or roundedChannel(part.Color.G) ~= color.green or roundedChannel(part.Color.B) ~= color.blue then
			fail("material color drifted for " .. part:GetFullName())
		end
		if math.abs(part.Transparency - expectation.transparency) > 0.000001 or math.abs(part.Reflectance - expectation.reflectance) > 0.000001 then
			fail("material scalar properties drifted for " .. part:GetFullName())
		end
		local textureId = if part:IsA("MeshPart") then part.TextureID else ""
		if expectation.meshTextureId ~= nil and textureId ~= expectation.meshTextureId then
			fail("mesh texture drifted for " .. part:GetFullName())
		elseif expectation.meshTextureId == nil and textureId ~= "" then
			fail("an unexpected mesh texture appeared for " .. part:GetFullName())
		end
		local appearances = {}
		for _, child in ipairs(part:GetChildren()) do
			if child:IsA("SurfaceAppearance") then table.insert(appearances, child) end
		end
		if expectation.surfaceAppearance == nil then
			if #appearances > 0 then fail("an unexpected SurfaceAppearance appeared for " .. part:GetFullName()) end
		else
			if #appearances ~= 1 then fail("expected exactly one SurfaceAppearance for " .. part:GetFullName()) end
			local actual = appearances[1]
			local expected = expectation.surfaceAppearance
			if actual.ColorMap ~= expected.colorMap or actual.MetalnessMap ~= expected.metalnessMap or actual.NormalMap ~= expected.normalMap or actual.RoughnessMap ~= expected.roughnessMap or actual.AlphaMode.Name ~= expected.alphaMode then
				fail("SurfaceAppearance drifted for " .. part:GetFullName())
			end
		end
	end
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("BasePart") and not checked[descendant] then
			fail("material expectations do not account for " .. descendant:GetFullName())
		end
	end
end

local function stagingFolder(sessionHash: string): Folder
	local existing = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
	if existing ~= nil then
		if not existing:IsA("Folder") or existing:GetAttribute("BasaltSessionHash") ~= sessionHash then
			fail("another Basalt staging world is present")
		end
		return existing
	end
	local folder = Instance.new("Folder")
	folder.Name = Constants.STAGING_FOLDER
	folder:SetAttribute("BasaltSessionHash", sessionHash)
	folder.Parent = Workspace
	return folder
end

local function spanRoad(parent: Instance, segment: any): ()
	local vertices = segment.vertices
	if typeof(vertices) ~= "table" or #vertices ~= 4 then fail("road segment must contain four vertices") end
	local a = vertices[1].positionMeters
	local b = vertices[2].positionMeters
	local c = vertices[3].positionMeters
	local d = vertices[4].positionMeters
	local start = Vector3.new(meters((a.x + b.x) / 2), meters((a.y + b.y) / 2), meters((a.z + b.z) / 2))
	local finish = Vector3.new(meters((c.x + d.x) / 2), meters((c.y + d.y) / 2), meters((c.z + d.z) / 2))
	local left = Vector3.new(meters(a.x), meters(a.y), meters(a.z))
	local right = Vector3.new(meters(b.x), meters(b.y), meters(b.z))
	local width = (right - left).Magnitude
	local length = (finish - start).Magnitude
	if width <= 0.001 or length <= 0.001 then fail("road segment has degenerate geometry") end
	local forward = (finish - start).Unit
	local up = Vector3.new(0, 1, 0)
	local lateral = forward:Cross(up)
	if lateral.Magnitude <= 0.001 then fail("road segment direction is vertical") end
	local part = Instance.new("Part")
	part.Name = segment.segmentId
	part.Size = Vector3.new(width, 0.2, length)
	part.CFrame = CFrame.fromMatrix((start + finish) / 2 + up * 0.1, lateral.Unit, up)
	part.Anchored = true
	part.Material = Enum.Material.Asphalt
	part.Color = Color3.fromRGB(79, 82, 86)
	part.Parent = parent
end

function WorldLowering.preflight(transaction: any, session: any): ()
	requireHash(transaction.hash, "transaction.hash")
	requireHash(transaction.sessionHash, "transaction.sessionHash")
	requireHash(transaction.worldBuildHash, "transaction.worldBuildHash")
	if transaction.sessionHash ~= session.sessionHash or transaction.worldBuildHash ~= session.worldBuildHash then
		fail("transaction does not belong to the discovered world build")
	end
	if session.loweringGapCount > 0 then
		fail(tostring(session.loweringGapCount) .. " assets have no admitted Roblox binding")
	end
	local stale = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
	if stale ~= nil then stale:Destroy() end
	pendingFoundation = nil
	pendingMeso = nil
	pendingInstances = {}
	stagingFolder(transaction.sessionHash)
end

function WorldLowering.foundation(transaction: any): any
	local root = stagingFolder(transaction.sessionHash)
	local foundation = transaction.foundation
	if typeof(foundation) ~= "table" then fail("foundation transaction has no foundation payload") end
	pendingFoundation = foundation
	TerrainLowering.begin(foundation.terrainFields, foundation.worldBoundsMeters)
	local roads = Instance.new("Folder")
	roads.Name = "Routes"
	roads.Parent = root
	local observations = {}
	for _, field in ipairs(foundation.terrainFields) do
		table.insert(observations, {
			artifactKind = "terrain_field",
			artifactId = field.terrainPlanId,
			realizedHash = requireHash(field.hash, "terrain field hash"),
		})
	end
	for _, assembly in ipairs(foundation.roadAssemblies) do
		local route = Instance.new("Folder")
		route.Name = assembly.routeId
		route:SetAttribute("BasaltRoadHash", requireHash(assembly.hash, "road assembly hash"))
		route.Parent = roads
		for _, segment in ipairs(assembly.segments) do spanRoad(route, segment) end
		table.insert(observations, {
			artifactKind = "route",
			artifactId = assembly.routeId,
			realizedHash = requireHash(assembly.hash, "road assembly hash"),
		})
	end
	TerrainLowering.verify()
	return { instances = {}, artifacts = observations }
end

local function lowerInstance(parent: Instance, entry: any, realizedHash: string): any
	if typeof(entry.robloxAssetId) ~= "number" then fail("instance has no admitted Roblox asset id") end
	local ok, container = pcall(function()
		return InsertService:LoadAsset(entry.robloxAssetId)
	end)
	if not ok or container == nil or not container:IsA("Model") then
		fail("Roblox asset " .. tostring(entry.robloxAssetId) .. " could not be loaded")
	end
	local model = container :: Model
	model.Name = entry.instanceId
	local sourceBounds = entry.sourceBoundsMeters
	if typeof(sourceBounds) ~= "table" then
		model:Destroy()
		fail("instance has no measured source bounds")
	end
	local desiredSourceSize = Vector3.new(
		meters(sourceBounds.max.x - sourceBounds.min.x),
		meters(sourceBounds.max.y - sourceBounds.min.y),
		meters(sourceBounds.max.z - sourceBounds.min.z)
	) * entry.transformMeters.scale
	local _, actualSize = model:GetBoundingBox()
	local ratios = {}
	for _, dimensions in ipairs({
		{ desired = desiredSourceSize.X, actual = actualSize.X },
		{ desired = desiredSourceSize.Y, actual = actualSize.Y },
		{ desired = desiredSourceSize.Z, actual = actualSize.Z },
	}) do
		if dimensions.desired > 0.000001 then
			table.insert(ratios, dimensions.desired / math.max(dimensions.actual, 0.000001))
		end
	end
	if #ratios == 0 then
		model:Destroy()
		fail("asset source bounds are degenerate on every axis")
	end
	local ratioTotal = 0
	for _, ratio in ipairs(ratios) do ratioTotal += ratio end
	local uniform = ratioTotal / #ratios
	for _, ratio in ipairs(ratios) do
		if math.abs(ratio - uniform) / uniform > 0.02 then
			model:Destroy()
			fail("asset bounds require non-uniform scaling")
		end
	end
	model:ScaleTo(model:GetScale() * uniform)
	local position = entry.transformMeters.position
	model:PivotTo(
		CFrame.new(meters(position.x), meters(position.y), meters(position.z))
			* quaternion(entry.transformMeters.rotation)
	)
	local bounds = entry.boundsMeters
	local expectedCenter = Vector3.new(
		meters((bounds.min.x + bounds.max.x) / 2),
		meters((bounds.min.y + bounds.max.y) / 2),
		meters((bounds.min.z + bounds.max.z) / 2)
	)
	local expectedSize = Vector3.new(
		meters(bounds.max.x - bounds.min.x),
		meters(bounds.max.y - bounds.min.y),
		meters(bounds.max.z - bounds.min.z)
	)
	local settledFrame, settledSize = model:GetBoundingBox()
	if (settledFrame.Position - expectedCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (settledSize - expectedSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
		model:Destroy()
		fail("loaded asset transform or bounds do not match the sealed realization")
	end
	verifyMaterialExpectations(model, entry.materialExpectations)
	model:SetAttribute("BasaltAssetHash", requireHash(entry.assetHash, "instance.assetHash"))
	model:SetAttribute("BasaltRealizedHash", requireHash(realizedHash, "expected realization hash"))
	model.Parent = parent
	return { instanceId = entry.instanceId, realizedHash = realizedHash }
end

local function findModel(root: Instance, instanceId: string): Model
	local model = root:FindFirstChild(instanceId, true)
	if model == nil or not model:IsA("Model") then fail("missing assembly component " .. instanceId) end
	return model
end

local function firstBasePart(model: Model): BasePart
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("BasePart") then return descendant end
	end
	fail("assembly component has no geometry: " .. model.Name)
end

local function boundsCenterAndSize(bounds: any): (Vector3, Vector3)
	local center = Vector3.new(
		meters((bounds.min.x + bounds.max.x) / 2),
		meters((bounds.min.y + bounds.max.y) / 2),
		meters((bounds.min.z + bounds.max.z) / 2)
	)
	local size = Vector3.new(
		meters(bounds.max.x - bounds.min.x),
		meters(bounds.max.y - bounds.min.y),
		meters(bounds.max.z - bounds.min.z)
	)
	return center, size
end

local function artifactObservation(kind: string, id: string, hash: string): any
	return { artifactKind = kind, artifactId = id, realizedHash = requireHash(hash, kind .. " hash") }
end

local function structuralEvidenceFolder(root: Instance): Folder
	local existing = root:FindFirstChild("StructuralEvidence")
	if existing ~= nil then fail("structural evidence was already lowered") end
	local folder = Instance.new("Folder")
	folder.Name = "StructuralEvidence"
	folder.Parent = root
	return folder
end

local function lowerMeso(root: Instance, meso: any): { any }
	if typeof(meso) ~= "table" then fail("meso transaction has no structural payload") end
	pendingMeso = meso
	local evidence = structuralEvidenceFolder(root)
	local observations = {}
	for _, assembly in ipairs(meso.assemblies) do
		for _, instanceId in ipairs(assembly.componentInstanceIds) do findModel(root, instanceId) end
		for _, connection in ipairs(assembly.connections) do
			findModel(root, connection.host.instanceId)
			findModel(root, connection.child.instanceId)
		end
		local record = Instance.new("Configuration")
		record.Name = "Assembly_" .. assembly.assemblyId
		record:SetAttribute("BasaltArtifactHash", requireHash(assembly.hash, "assembly hash"))
		record.Parent = evidence
		table.insert(observations, artifactObservation("assembly", assembly.assemblyId, assembly.hash))
	end
	for _, surface in ipairs(meso.constructedSurfaces) do
		local model = findModel(root, surface.sourceComponentInstanceId)
		local desiredCenter, desiredSize = boundsCenterAndSize(surface.bounds)
		local actualFrame, actualSize = model:GetBoundingBox()
		if (actualFrame.Position - desiredCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (actualSize - desiredSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
			fail("constructed surface source bounds drifted for " .. surface.surfaceId)
		end
		local record = Instance.new("Configuration")
		record.Name = "Surface_" .. surface.surfaceId
		record:SetAttribute("BasaltArtifactHash", requireHash(surface.hash, "constructed surface hash"))
		record:SetAttribute("BasaltAssemblyHash", requireHash(surface.assemblyHash, "surface assembly hash"))
		record.Parent = model
		table.insert(observations, artifactObservation("constructed_surface", surface.surfaceId, surface.hash))
	end
	for _, portal in ipairs(meso.portals) do
		local model = findModel(root, portal.opening.instanceId)
		local parent = firstBasePart(model)
		local position = portal.openingPoseMeters.position
		local normal = portal.openingPoseMeters.normal
		local up = portal.openingPoseMeters.up
		local worldPosition = Vector3.new(meters(position.x), meters(position.y), meters(position.z))
		local worldNormal = Vector3.new(normal.x, normal.y, normal.z)
		local worldUp = Vector3.new(up.x, up.y, up.z)
		if worldNormal.Magnitude < 0.999 or worldUp.Magnitude < 0.999 or math.abs(worldNormal:Dot(worldUp)) > 0.0001 then
			fail("portal opening frame is malformed for " .. portal.portalId)
		end
		local attachment = Instance.new("Attachment")
		attachment.Name = "Portal_" .. portal.portalId
		attachment.CFrame = parent.CFrame:ToObjectSpace(CFrame.fromMatrix(worldPosition, worldNormal.Unit, worldUp.Unit, worldNormal:Cross(worldUp).Unit))
		attachment:SetAttribute("BasaltArtifactHash", requireHash(portal.hash, "portal hash"))
		attachment:SetAttribute("BasaltOpeningSocketId", portal.opening.socketId)
		attachment.Parent = parent
		if (attachment.WorldPosition - worldPosition).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
			attachment:Destroy()
			fail("portal opening pose drifted for " .. portal.portalId)
		end
		if attachment.WorldAxis:Dot(worldNormal.Unit) < 0.99999 or attachment.WorldSecondaryAxis:Dot(worldUp.Unit) < 0.99999 then
			attachment:Destroy()
			fail("portal opening axes drifted for " .. portal.portalId)
		end
		table.insert(observations, artifactObservation("portal", portal.portalId, portal.hash))
	end
	for _, room in ipairs(meso.rooms) do
		local record = Instance.new("Configuration")
		record.Name = "Room_" .. room.roomId
		record:SetAttribute("BasaltArtifactHash", requireHash(room.hash, "room hash"))
		record:SetAttribute("BasaltAssemblyHash", requireHash(room.assemblyHash, "room assembly hash"))
		record.Parent = evidence
		table.insert(observations, artifactObservation("room", room.roomId, room.hash))
	end
	local stairRoot = Instance.new("Folder")
	stairRoot.Name = "ProceduralStairs"
	stairRoot.Parent = root
	for _, stair in ipairs(meso.proceduralStairs) do
		local folder = Instance.new("Folder")
		folder.Name = stair.stairId
		folder:SetAttribute("BasaltArtifactHash", requireHash(stair.hash, "procedural stair hash"))
		folder.Parent = stairRoot
		for index, bounds in ipairs(stair.stepBoundsMeters) do
			local center, size = boundsCenterAndSize(bounds)
			if size.X <= 0 or size.Y <= 0 or size.Z <= 0 then fail("procedural stair step is degenerate") end
			local step = Instance.new("Part")
			step.Name = "Step_" .. tostring(index)
			step.Size = size
			step.CFrame = CFrame.new(center)
			step.Anchored = true
			step.Material = Enum.Material.Concrete
			step.Parent = folder
		end
		table.insert(observations, artifactObservation("procedural_stair", stair.stairId, stair.hash))
	end
	return observations
end

function WorldLowering.instances(transaction: any): any
	local root = stagingFolder(transaction.sessionHash)
	local layer = Instance.new("Folder")
	layer.Name = transaction.stage == "meso" and "Meso" or "Micro"
	layer.Parent = root
	local expected = {}
	for _, item in ipairs(transaction.expectedInstanceHashes) do expected[item.instanceId] = item.hash end
	local observations = {}
	for _, entry in ipairs(transaction.instances) do
		local hash = expected[entry.instanceId]
		if hash == nil then fail("instance has no expected realization hash") end
		table.insert(observations, lowerInstance(layer, entry, hash))
		pendingInstances[entry.instanceId] = entry
	end
	local artifacts = if transaction.stage == "meso" then lowerMeso(root, transaction.meso) else {}
	return { instances = observations, artifacts = artifacts }
end

function WorldLowering.readback(transaction: any): any
	local root = stagingFolder(transaction.sessionHash)
	TerrainLowering.verify()
	local artifacts = {}
	if pendingFoundation ~= nil then
		for _, field in ipairs(pendingFoundation.terrainFields) do
			table.insert(artifacts, artifactObservation("terrain_field", field.terrainPlanId, field.hash))
		end
		for _, assembly in ipairs(pendingFoundation.roadAssemblies) do
			local marker = root:FindFirstChild(assembly.routeId, true)
			if marker == nil or marker:GetAttribute("BasaltRoadHash") ~= assembly.hash then
				fail("route readback drifted for " .. assembly.routeId)
			end
			table.insert(artifacts, artifactObservation("route", assembly.routeId, assembly.hash))
		end
	end
	local observations = {}
	for _, expected in ipairs(transaction.expectedInstanceHashes) do
		local model = root:FindFirstChild(expected.instanceId, true)
		if model == nil or not model:IsA("Model") then fail("missing realized instance " .. expected.instanceId) end
		local declaration = pendingInstances[expected.instanceId]
		if declaration == nil then fail("missing realized instance declaration " .. expected.instanceId) end
		if model:GetAttribute("BasaltAssetHash") ~= declaration.assetHash then
			fail("realized asset identity drifted for " .. expected.instanceId)
		end
		if model:GetAttribute("BasaltRealizedHash") ~= expected.hash then
			fail("realized instance hash drifted for " .. expected.instanceId)
		end
		verifyMaterialExpectations(model, declaration.materialExpectations)
		local expectedCenter, expectedSize = boundsCenterAndSize(declaration.boundsMeters)
		local actualFrame, actualSize = model:GetBoundingBox()
		if (actualFrame.Position - expectedCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (actualSize - expectedSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
			fail("realized instance bounds drifted for " .. expected.instanceId)
		end
		local hasPart = false
		for _, descendant in ipairs(model:GetDescendants()) do
			if descendant:IsA("BasePart") then hasPart = true break end
		end
		if not hasPart then fail("realized instance has no geometry: " .. expected.instanceId) end
		table.insert(observations, { instanceId = expected.instanceId, realizedHash = expected.hash })
	end
	if pendingMeso ~= nil then
		for _, expected in ipairs(transaction.expectedArtifactHashes) do
			if expected.artifactKind == "terrain_field" or expected.artifactKind == "route" then continue end
			local namePrefix = if expected.artifactKind == "assembly" then "Assembly_" elseif expected.artifactKind == "constructed_surface" then "Surface_" elseif expected.artifactKind == "portal" then "Portal_" elseif expected.artifactKind == "room" then "Room_" else ""
			local record = if expected.artifactKind == "procedural_stair" then root:FindFirstChild(expected.artifactId, true) else root:FindFirstChild(namePrefix .. expected.artifactId, true)
			if record == nil or record:GetAttribute("BasaltArtifactHash") ~= expected.realizedHash then
				fail(expected.artifactKind .. " readback drifted for " .. expected.artifactId)
			end
			if expected.artifactKind == "portal" then
				local declaration = nil
				for _, portal in ipairs(pendingMeso.portals) do
					if portal.portalId == expected.artifactId then declaration = portal break end
				end
				if declaration == nil or not record:IsA("Attachment") then fail("portal declaration is missing") end
				local sourceModel = findModel(root, declaration.opening.instanceId)
				if not record:IsDescendantOf(sourceModel) then fail("portal is no longer bound to its source component") end
				local position = declaration.openingPoseMeters.position
				local normal = declaration.openingPoseMeters.normal
				local up = declaration.openingPoseMeters.up
				local worldPosition = Vector3.new(meters(position.x), meters(position.y), meters(position.z))
				local worldNormal = Vector3.new(normal.x, normal.y, normal.z).Unit
				local worldUp = Vector3.new(up.x, up.y, up.z).Unit
				if (record.WorldPosition - worldPosition).Magnitude > Constants.BOUND_TOLERANCE_STUDS or record.WorldAxis:Dot(worldNormal) < 0.99999 or record.WorldSecondaryAxis:Dot(worldUp) < 0.99999 then
					fail("portal pose readback drifted for " .. expected.artifactId)
				end
			elseif expected.artifactKind == "procedural_stair" then
				local declaration = nil
				for _, stair in ipairs(pendingMeso.proceduralStairs) do
					if stair.stairId == expected.artifactId then declaration = stair break end
				end
				if declaration == nil or not record:IsA("Folder") then fail("procedural stair declaration is missing") end
				local steps = record:GetChildren()
				if #steps ~= #declaration.stepBoundsMeters then fail("procedural stair step count drifted") end
				for index, bounds in ipairs(declaration.stepBoundsMeters) do
					local step = record:FindFirstChild("Step_" .. tostring(index))
					if step == nil or not step:IsA("BasePart") then fail("procedural stair step is missing") end
					local center, size = boundsCenterAndSize(bounds)
					if (step.Position - center).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (step.Size - size).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
						fail("procedural stair geometry drifted for " .. expected.artifactId)
					end
				end
			end
			table.insert(artifacts, { artifactKind = expected.artifactKind, artifactId = expected.artifactId, realizedHash = expected.realizedHash })
		end
	end
	return { instances = observations, artifacts = artifacts }
end

function WorldLowering.commit(transaction: any): ()
	local root = stagingFolder(transaction.sessionHash)
	local previous = Workspace:FindFirstChild(Constants.WORLD_FOLDER)
	if previous ~= nil then previous:Destroy() end
	root.Name = Constants.WORLD_FOLDER
	root:SetAttribute("BasaltWorldBuildHash", transaction.worldBuildHash)
	root:SetAttribute("BasaltObservedWorldStateHash", transaction.expectedObservedWorldStateHash)
	TerrainLowering.commit()
	pendingFoundation = nil
	pendingMeso = nil
	ChangeHistoryService:SetWaypoint("Import Basalt world")
end

function WorldLowering.rollback(): ()
	TerrainLowering.rollback()
	local root = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
	if root ~= nil then root:Destroy() end
	pendingFoundation = nil
	pendingMeso = nil
	pendingInstances = {}
end

return WorldLowering
