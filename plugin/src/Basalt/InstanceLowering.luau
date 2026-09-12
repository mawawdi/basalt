--!strict
local InsertService = game:GetService("InsertService")
local Constants = require(script.Parent.Constants)
local Frames = require(script.Parent.Frames)

-- MeshPart lowering. Each sealed part resolves through the sidecar to one
-- uploaded Model; the connector verifies the measured import map per model
-- (uniform scale from bounds, pivots on the flipped recorded center,
-- identity rotations) and places every MeshPart by framing the recorded
-- center with the flip compensated. Any deviation fails closed with numbers.
-- Measured factors return to the readback observation; when the sidecar
-- already records a factor for the part, drift past tolerance fails closed
-- instead of silently compensating a changed upload.
local InstanceLowering = {}

-- Loaded model templates keyed by part hash for the current export only; a
-- new export hash invalidates every cached template.
local templateCache: { exportHash: string?, models: { [string]: Model } } =
	{ exportHash = nil, models = {} }

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function hasCollisionSuffix(nodeName: string): boolean
	return string.sub(nodeName, -string.len(Constants.COLLISION_NODE_SUFFIX)) == Constants.COLLISION_NODE_SUFFIX
end

local function partSpan(part: any): Vector3
	local minimum = part.boundsSourceUnits.minimum
	local maximum = part.boundsSourceUnits.maximum
	return Vector3.new(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z)
end

local function measureImportFactor(template: Model, part: any): number
	local partCount = 0
	for _, descendant in ipairs(template:GetDescendants()) do
		if descendant:IsA("BasePart") then partCount += 1 end
	end
	if partCount == 0 then fail("uploaded model has no parts for " .. part.contentHash) end
	local _, size = template:GetBoundingBox()
	local span = partSpan(part)
	local factor: number? = nil
	for _, axis in ipairs({ "X", "Y", "Z" }) do
		local recorded = (span :: Vector3)[axis]
		local imported = (size :: Vector3)[axis]
		if math.abs(recorded) < 1e-6 then continue end
		local candidate = imported / recorded
		if candidate <= 0 then
			fail(
				"uploaded model for "
					.. part.contentHash
					.. " has a non-positive "
					.. axis
					.. " extent (imported "
					.. tostring(imported)
					.. ", recorded "
					.. tostring(recorded)
					.. ")"
			)
		end
		if factor == nil then
			factor = candidate
		elseif math.abs(candidate - (factor :: number)) / (factor :: number) > Constants.IMPORT_SCALE_TOLERANCE then
			fail(
				"uploaded model for "
					.. part.contentHash
					.. " scales non-uniformly across axes (imported "
					.. tostring(size)
					.. ", recorded "
					.. tostring(span)
					.. "); cannot place"
			)
		end
	end
	if factor == nil then fail("recorded part " .. part.contentHash .. " has no measurable span") end
	return factor :: number
end

local function partCenter(part: any): Vector3
	local minimum = part.boundsSourceUnits.minimum
	local maximum = part.boundsSourceUnits.maximum
	return Vector3.new(
		(minimum.x + maximum.x) / 2,
		(minimum.y + maximum.y) / 2,
		(minimum.z + maximum.z) / 2
	)
end

local function rotationBasis(cframe: CFrame): string
	local components = { cframe:GetComponents() }
	return table.concat({
		string.format("%.6f", components[4]),
		string.format("%.6f", components[5]),
		string.format("%.6f", components[6]),
		string.format("%.6f", components[7]),
		string.format("%.6f", components[8]),
		string.format("%.6f", components[9]),
		string.format("%.6f", components[10]),
		string.format("%.6f", components[11]),
		string.format("%.6f", components[12]),
	}, ",")
end

-- Every imported part pivot must land on the recorded geometry center rotated
-- by the measured import flip: the importer bakes the flip into vertices and
-- centers pivots on the imported geometry. Multi-primitive nodes whose parts
-- center on sub-geometry instead of the node span fail here by design.
local function checkImportPivots(template: Model, part: any, factor: number): ()
	local center = partCenter(part)
	local recorded = Vector3.new(-center.x, center.y, -center.z)
	local tolerance = partSpan(part).Magnitude / 2 * Constants.IMPORT_PIVOT_TOLERANCE + 1e-4
	for _, descendant in ipairs(template:GetDescendants()) do
		if descendant:IsA("BasePart") then
			local imported = descendant.Position / factor
			local drift = (imported - recorded).Magnitude
			if drift > tolerance then
				fail(
					"uploaded model for "
						.. part.contentHash
						.. " drifts its pivot on "
						.. descendant:GetFullName()
						.. " (imported "
						.. tostring(imported)
						.. ", recorded "
						.. tostring(recorded)
						.. ", drift "
						.. tostring(drift)
						.. " past "
						.. tostring(tolerance)
						.. "; factor "
						.. tostring(factor)
						.. ", size "
						.. tostring(descendant.Size)
						.. ", rotbasis "
						.. rotationBasis(descendant.CFrame)
						.. "); cannot place"
				)
			end
		end
	end
end

-- Imported part rotations must be identity: the measured map bakes every
-- node transform into vertices. A preserved node rotation would need a
-- different placement compensation, so it fails closed with its basis.
local function checkImportRotations(template: Model, _part: any): ()
	for _, descendant in ipairs(template:GetDescendants()) do
		if descendant:IsA("BasePart") then
			local elements = { descendant.CFrame:GetComponents() }
			local off = math.abs(elements[4] - 1)
				+ math.abs(elements[8] - 1)
				+ math.abs(elements[12] - 1)
				+ math.abs(elements[5])
				+ math.abs(elements[6])
				+ math.abs(elements[7])
				+ math.abs(elements[9])
				+ math.abs(elements[10])
				+ math.abs(elements[11])
			if off > Constants.IMPORT_ROTATION_TOLERANCE then
				fail(
					"uploaded model for "
						.. part.contentHash
						.. " preserves rotation on "
						.. descendant:GetFullName()
						.. " (rotbasis "
						.. rotationBasis(descendant.CFrame)
						.. "); cannot place"
				)
			end
		end
	end
end

local function checkRecordedFactor(scene: any, partHash: string, factor: number): ()
	local recorded = scene.importFactorByPartHash[partHash]
	if recorded == nil then return end
	if math.abs(factor - recorded) / recorded > Constants.IMPORT_SCALE_TOLERANCE then
		fail(
			"uploaded model for "
				.. partHash
				.. " drifts its import factor (measured "
				.. tostring(factor)
				.. ", recorded "
				.. tostring(recorded)
				.. "); re-record the sidecar after re-uploading"
		)
	end
end

local function loadTemplate(scene: any, partHash: string): (Model, number)
	if templateCache.exportHash ~= scene.exportHash then
		templateCache = { exportHash = scene.exportHash, models = {} }
	end
	local cached = templateCache.models[partHash]
	if cached ~= nil then
		local part = scene.partsByHash[partHash]
		local factor = measureImportFactor(cached, part)
		checkImportPivots(cached, part, factor)
		checkImportRotations(cached, part)
		checkRecordedFactor(scene, partHash, factor)
		return cached, factor
	end
	local part = scene.partsByHash[partHash]
	local assetId = scene.assetByPartHash[partHash]
	if assetId == nil then
		fail(
			"part " .. partHash .. " has no upload binding; upload it, rebuild the sidecar, restart the bridge"
		)
	end
	local ok, model = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not ok or model == nil then
		fail("InsertService:LoadAsset(" .. tostring(assetId) .. ") failed for part " .. partHash)
	end
	model.Parent = nil
	local factor = measureImportFactor(model, part)
	checkImportPivots(model, part, factor)
	checkImportRotations(model, part)
	checkRecordedFactor(scene, partHash, factor)
	templateCache.models[partHash] = model
	return model, factor
end

local function placePart(
	part: BasePart,
	frame: Frames.InstanceFrame,
	importFactor: number,
	anchor: Vector3,
	collide: boolean,
	render: boolean
): ()
	-- The pivot corresponds to the recorded center: the flip maps center to
	-- pivot, so framing the center and unflipping the orientation restores
	-- the sealed placement exactly.
	local importedRotation = part.CFrame - part.CFrame.Position
	part.CFrame = CFrame.new(Frames.worldPosition(frame, anchor))
		* frame.rotation
		* Constants.IMPORT_FLIP
		* importedRotation
	part.Size = part.Size * ((frame.sourceToStuds * frame.scale) / importFactor)
	part.Anchored = true
	part.CanCollide = collide
	part.CanQuery = true
	part.CanTouch = false
	if not render then
		part.Transparency = 1
		part.CastShadow = false
	end
end

function InstanceLowering.lowerInstances(
	parent: Instance,
	transaction: any,
	scene: any
): { [string]: number }
	local stale = parent:FindFirstChild("instances")
	if stale ~= nil then stale:Destroy() end
	local folder = Instance.new("Folder")
	folder.Name = "instances"
	folder.Parent = parent
	local factors: { [string]: number } = {}
	for _, instanceId in ipairs(transaction.instanceIds) do
		local instance = scene.instancesById[instanceId]
		local asset = scene.assetsById[instance.assetId]
		local frame = Frames.instanceFrame(instance, asset)
		local useProxies = false
		for _, partHash in ipairs(asset.partHashes) do
			local part = scene.partsByHash[partHash]
			if hasCollisionSuffix(part.nodeName) then useProxies = true end
		end
		local model = Instance.new("Model")
		model.Name = instanceId
		for _, partHash in ipairs(asset.partHashes) do
			local part = scene.partsByHash[partHash]
			local template, importFactor = loadTemplate(scene, partHash)
			factors[partHash] = importFactor
			local clone: Model = template:Clone()
			local render = not hasCollisionSuffix(part.nodeName)
			local partIndex = 0
			for _, child in ipairs(clone:GetChildren()) do
				child.Parent = model
			end
			clone:Destroy()
			for _, descendant in ipairs(model:GetDescendants()) do
				if descendant:IsA("BasePart") and descendant:GetAttribute("BasaltPlaced") == nil then
					partIndex += 1
					local collide = if useProxies then not render else render
					placePart(descendant, frame, importFactor, partCenter(part), collide, render)
					descendant.Name = part.nodeName .. "__" .. tostring(partIndex)
					descendant:SetAttribute("BasaltPlaced", true)
					descendant:SetAttribute("BasaltInstanceId", instanceId)
					descendant:SetAttribute("BasaltPartHash", partHash)
				end
			end
		end
		local placed = 0
		for _, descendant in ipairs(model:GetDescendants()) do
			if descendant:IsA("BasePart") then placed += 1 end
		end
		if placed == 0 then fail("instance " .. instanceId .. " lowered no parts") end
		model.Parent = folder
	end
	return factors
end

return InstanceLowering
