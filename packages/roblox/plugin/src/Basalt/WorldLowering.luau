--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService = game:GetService("InsertService")
local Workspace = game:GetService("Workspace")
local BoundedQuery = require(script.Parent.BoundedQuery)
local Constants = require(script.Parent.Constants)
local LoadedAsset = require(script.Parent.LoadedAsset)
local ModelBounds = require(script.Parent.ModelBounds)
local RouteCoordination = require(script.Parent.RouteCoordination)
local RouteGeometry = require(script.Parent.RouteGeometry)
local RouteGrounding = require(script.Parent.RouteGrounding)
local TerrainLowering = require(script.Parent.TerrainLowering)

local WorldLowering = {}
local pendingFoundation: any = nil
local pendingMeso: any = nil
local pendingInstances: { [string]: any } = {}
local pendingRouteFrames: { [string]: any } = {}
local pendingRouteStationAdjustments: { [string]: { number } } = {}
local pendingJunctionResolutions: { [string]: any } = {}
local pendingTraceEvents: { any } = {}
local pendingDroppedTraceEvents = 0
local pendingCommit: any = nil
local pendingStage = "idle"

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or #value ~= 64 or string.match(value, "^[a-f0-9]+$") == nil then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function artifactObservation(kind: string, id: string, hash: string): any
	return { artifactKind = kind, artifactId = id, realizedHash = requireHash(hash, kind .. " hash") }
end

local function isOwnedFolder(instance: Instance, attributeName: string): boolean
	local value = instance:GetAttribute(attributeName)
	return instance:IsA("Folder")
		and typeof(value) == "string"
		and #value == 64
		and string.match(value, "^[a-f0-9]+$") ~= nil
end

local function clearPendingState(): ()
	pendingFoundation = nil
	pendingMeso = nil
	pendingInstances = {}
	pendingRouteFrames = {}
	pendingRouteStationAdjustments = {}
	pendingJunctionResolutions = {}
	pendingTraceEvents = {}
	pendingDroppedTraceEvents = 0
	pendingCommit = nil
	pendingStage = "idle"
end

local function recordTraceEvent(event: any): ()
	if #pendingTraceEvents >= Constants.MAX_DIAGNOSTIC_TRACE_EVENTS - 1 then
		pendingDroppedTraceEvents += 1
		return
	end
	table.insert(pendingTraceEvents, event)
end

local function pointMeters(value: Vector3): any
	return {
		x = value.X * Constants.STUD_METERS,
		y = value.Y * Constants.STUD_METERS,
		z = value.Z * Constants.STUD_METERS,
	}
end

local function requireStage(expected: string, operation: string): ()
	if pendingStage ~= expected then
		fail(operation .. " requires local stage " .. expected .. ", observed " .. pendingStage)
	end
end

local function finite(value: any, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		fail(label .. " must be finite")
	end
	return value
end

local function meters(value: number): number
	return value / Constants.STUD_METERS
end

local function studsToMicrometers(value: number): number
	local scaled = value * Constants.STUD_METERS * 1000000
	return if scaled >= 0 then math.floor(scaled + 0.5) else math.ceil(scaled - 0.5)
end

local function vectorMicrometers(value: Vector3): any
	return {
		x = studsToMicrometers(value.X),
		y = studsToMicrometers(value.Y),
		z = studsToMicrometers(value.Z),
	}
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

local function requireStagingFolder(sessionHash: string): Folder
	local existing = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
	if existing == nil then fail("Basalt preflight has not created a staging world") end
	if not existing:IsA("Folder") or existing:GetAttribute("BasaltSessionHash") ~= sessionHash then
		fail("another Basalt staging world is present")
	end
	return existing
end

local function createStagingFolder(sessionHash: string): Folder
	if Workspace:FindFirstChild(Constants.STAGING_FOLDER) ~= nil then
		fail("a Basalt staging world already exists")
	end
	local folder = Instance.new("Folder")
	folder.Name = Constants.STAGING_FOLDER
	folder:SetAttribute("BasaltSessionHash", sessionHash)
	folder.Parent = Workspace
	return folder
end

local function routeMaterial(name: any): Enum.Material
	if typeof(name) ~= "string" then fail("route material must be a string") end
	local ok, value = pcall(function() return (Enum.Material :: any)[name] end)
	if not ok or value == nil or typeof(value) ~= "EnumItem" then fail("unsupported route material " .. name) end
	return value
end

local function routeColor(appearance: any): Color3
	local color = appearance.baseColorSrgb
	if typeof(color) ~= "table" then fail("route appearance has no base color") end
	return Color3.fromRGB(
		finite(color.red, "route red channel"),
		finite(color.green, "route green channel"),
		finite(color.blue, "route blue channel")
	)
end

local function routeColorMatches(part: BasePart, appearance: any): boolean
	local color = appearance.baseColorSrgb
	if typeof(color) ~= "table" then fail("route appearance has no base color") end
	return roundedChannel(part.Color.R) == finite(color.red, "route red channel")
		and roundedChannel(part.Color.G) == finite(color.green, "route green channel")
		and roundedChannel(part.Color.B) == finite(color.blue, "route blue channel")
end

local function formatVectorMeters(value: Vector3): string
	return string.format(
		"(%.6f, %.6f, %.6f)m",
		value.X * Constants.STUD_METERS,
		value.Y * Constants.STUD_METERS,
		value.Z * Constants.STUD_METERS
	)
end

local function routeFrame(segment: any, thicknessMeters: any, startDeltaY: number?, finishDeltaY: number?): any
	local vertices = segment.vertices
	if typeof(vertices) ~= "table" or #vertices ~= 4 then fail("route segment must contain four vertices") end
	local a = vertices[1].positionMeters
	local b = vertices[2].positionMeters
	local c = vertices[3].positionMeters
	local d = vertices[4].positionMeters
	local startAdjustment = startDeltaY or 0
	local finishAdjustment = finishDeltaY or 0
	local startLeft = Vector3.new(meters(a.x), meters(a.y) + startAdjustment, meters(a.z))
	local startRight = Vector3.new(meters(b.x), meters(b.y) + startAdjustment, meters(b.z))
	local finishLeft = Vector3.new(meters(c.x), meters(c.y) + finishAdjustment, meters(c.z))
	local finishRight = Vector3.new(meters(d.x), meters(d.y) + finishAdjustment, meters(d.z))
	local start = (startLeft + startRight) / 2
	local finish = (finishLeft + finishRight) / 2
	local width = ((startRight - startLeft).Magnitude + (finishRight - finishLeft).Magnitude) / 2
	local length = (finish - start).Magnitude
	local bounds = segment.boundsMeters
	if typeof(bounds) ~= "table" or typeof(bounds.min) ~= "table" or typeof(bounds.max) ~= "table" then
		fail("route segment has no sealed bounds")
	end
	local thickness = meters(finite(thicknessMeters, "route thickness"))
	if width <= 0.001 or length <= 0.001 or thickness <= 0.001 then fail("route segment has degenerate geometry") end
	local travel = (finish - start).Unit
	local lateralCandidate = (startRight - startLeft) + (finishRight - finishLeft)
	if lateralCandidate.Magnitude <= 0.001 then fail("route segment lateral frame is degenerate") end
	-- Curved, graded, or cross-fallen compiler quads can have an averaged
	-- cross-section that is not perpendicular to their centerline chord. A
	-- CFrame cannot represent that skew. Passing the raw vectors to
	-- CFrame.fromMatrix lets Roblox orthogonalize the value when it is stored in
	-- a Part, so immediate readback no longer matches the frame we retained.
	-- Project first and retain one canonical orthonormal lowering frame.
	local rawLateral = lateralCandidate.Unit
	local lateralProjection = rawLateral - travel * rawLateral:Dot(travel)
	if lateralProjection.Magnitude <= 0.001 then fail("route segment lateral frame is parallel to travel") end
	local lateral = lateralProjection.Unit
	local up = lateral:Cross(travel)
	if up.Magnitude <= 0.001 then fail("route segment frame is degenerate") end
	up = up.Unit
	if up.Y < 0 then
		up = -up
		lateral = -lateral
	end
	if math.abs(lateral:Dot(travel)) > 0.000001
		or math.abs(lateral:Dot(up)) > 0.000001
		or math.abs(up:Dot(travel)) > 0.000001 then
		fail("route segment frame did not orthogonalize")
	end
	local center = (start + finish) / 2 - up * (thickness / 2)
	return {
		size = Vector3.new(width, thickness, length),
		-- Omitting the back vector makes it the exact cross product of the two
		-- sealed axes instead of supplying a third independently rounded vector.
		frame = CFrame.fromMatrix(center, lateral, up),
	}
end

local function routeFrameKey(routeId: string, segmentId: string): string
	return routeId .. ":" .. segmentId
end

local function createRouteBlock(parent: Instance, name: string, size: Vector3, frame: CFrame, appearance: any): Part
	local part = Instance.new("Part")
	part.Name = name
	part.Shape = Enum.PartType.Block
	part.Size = size
	part.CFrame = frame
	part.Anchored = true
	part.CanCollide = true
	part.Material = routeMaterial(appearance.materialId)
	part.Color = routeColor(appearance)
	part.Parent = parent
	return part
end

local function groundingGeometry(resolved: any): (Vector3?, CFrame?)
	local depth = resolved.groundingDepthStuds or 0
	if depth <= 0.001 then return nil, nil end
	return Vector3.new(resolved.size.X, depth, resolved.size.Z),
		resolved.frame * CFrame.new(0, -(resolved.size.Y + depth) / 2, 0)
end

local function spanRoute(surfaceParent: Instance, groundingParent: Instance, segment: any, resolved: any, appearance: any): ()
	createRouteBlock(surfaceParent, segment.segmentId, resolved.size, resolved.frame, appearance)
	local groundingSize, groundingFrame = groundingGeometry(resolved)
	if groundingSize ~= nil and groundingFrame ~= nil then
		local grounding = createRouteBlock(
			groundingParent,
			segment.segmentId,
			groundingSize,
			groundingFrame,
			appearance
		)
		grounding:SetAttribute("BasaltRouteGrounding", true)
	end
end

local function routeUsesTerrain(route: any): boolean
	if pendingFoundation == nil then return false end
	for _, field in ipairs(pendingFoundation.terrainFields) do
		if field.surfaceId == route.surfaceId then return true end
	end
	return false
end

local function terrainRaycastContext(): any
	if pendingFoundation == nil then fail("terrain raycast requires a pending foundation") end
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain") end
	local bounds = pendingFoundation.worldBoundsMeters
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Include
	params.FilterDescendantsInstances = { terrain }
	params.IgnoreWater = false
	params.RespectCanCollide = false
	return {
		params = params,
		maximumY = meters(finite(bounds.max.y, "world maximum y") + 1),
		minimumY = meters(finite(bounds.min.y, "world minimum y") - 1),
	}
end

local function terrainHeight(context: any, x: number, z: number, label: string): number
	-- WriteVoxelChannels updates readable voxel state before Roblox rebuilds the
	-- terrain collision representation used by Workspace:Raycast. Automatic
	-- sequential import reaches this boundary in the same scheduler frame, so
	-- retry only a missing collision query for a small, explicit frame budget.
	-- A persistent miss is a real observation failure and remains fail-closed.
	local hit = BoundedQuery.awaitResult(
		function(): any
			return Workspace:Raycast(
			Vector3.new(x, context.maximumY, z),
			Vector3.new(0, context.minimumY - context.maximumY, 0),
			context.params
			)
		end,
		function(): () task.wait() end,
		Constants.MAX_TERRAIN_QUERY_WAIT_FRAMES
	)
	if hit == nil then fail(string.format(
		"terrain contact cannot be observed for %s after %d collision-update frames",
		label,
		Constants.MAX_TERRAIN_QUERY_WAIT_FRAMES
	)) end
	return hit.Position.Y
end

local function observeFramePlane(frame: CFrame, size: Vector3, localY: number, context: any, label: string): any
	local minimum = math.huge
	local maximum = -math.huge
	local minimumPoint: Vector3? = nil
	local maximumPoint: Vector3? = nil
	local minimumTerrainY = 0
	local maximumTerrainY = 0
	for longitudinal = -2, 2 do
		for lateral = -2, 2 do
			local point = frame:PointToWorldSpace(Vector3.new(
				size.X * lateral / 4,
				localY,
				size.Z * longitudinal / 4
			))
			local terrainY = terrainHeight(context, point.X, point.Z, label)
			local clearance = point.Y - terrainY
			if clearance < minimum then
				minimum = clearance
				minimumPoint = point
				minimumTerrainY = terrainY
			end
			if clearance > maximum then
				maximum = clearance
				maximumPoint = point
				maximumTerrainY = terrainY
			end
		end
	end
	if minimumPoint == nil or maximumPoint == nil then fail("route terrain observation produced no samples") end
	return {
		minimumStuds = minimum,
		maximumStuds = maximum,
		minimumPoint = minimumPoint,
		maximumPoint = maximumPoint,
		minimumTerrainY = minimumTerrainY,
		maximumTerrainY = maximumTerrainY,
	}
end

local function resolveGroundingDepth(resolved: any, bodyBottom: any, context: any, label: string): (number, any)
	if bodyBottom.maximumStuds <= 0 then return 0, bodyBottom end
	local verticalPerLocalStud = resolved.frame.UpVector.Y
	if verticalPerLocalStud <= 0.001 then fail("grounded route has no usable vertical thickness axis: " .. label) end
	local depth = RouteGrounding.initialDepthStuds(
		bodyBottom.maximumStuds,
		verticalPerLocalStud,
		Constants.TERRAIN_GROUNDING_OVERLAP_STUDS
	)
	local groundingBottom = bodyBottom
	for _ = 1, Constants.MAX_TERRAIN_CONFORMANCE_ITERATIONS do
		local groundingSize = Vector3.new(resolved.size.X, depth, resolved.size.Z)
		local groundingFrame = resolved.frame * CFrame.new(0, -(resolved.size.Y + depth) / 2, 0)
		groundingBottom = observeFramePlane(
			groundingFrame,
			groundingSize,
			-depth / 2,
			context,
			label
		)
		local missing = groundingBottom.maximumStuds + Constants.TERRAIN_GROUNDING_OVERLAP_STUDS
		if missing <= 0.00001 then return depth, groundingBottom end
		depth += missing / verticalPerLocalStud
	end
	fail(string.format(
		"route grounding did not converge for %s: bottom clearance %.6fm after %d iterations; see .basalt/roblox/import-report.json",
		label,
		groundingBottom.maximumStuds * Constants.STUD_METERS,
		Constants.MAX_TERRAIN_CONFORMANCE_ITERATIONS
	))
end

local function groundingPolicy(terrainTreatment: any, label: string): any
	local authoredMaximumGapStuds = meters(finite(
		terrainTreatment.groundingToleranceMeters,
		label .. " authored grounding tolerance"
	))
	local terrainQuantizationAllowanceStuds = Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS
	local observationToleranceStuds = Constants.TERRAIN_CONTACT_TOLERANCE_STUDS
	return {
		authoredMaximumGapStuds = authoredMaximumGapStuds,
		terrainQuantizationAllowanceStuds = terrainQuantizationAllowanceStuds,
		observationToleranceStuds = observationToleranceStuds,
		maximumPermittedGapStuds = RouteGrounding.maximumPermittedGapStuds(
			authoredMaximumGapStuds,
			terrainQuantizationAllowanceStuds,
			observationToleranceStuds
		),
	}
end

local function groundingTracePolicy(terrainTreatment: any, label: string): any
	local policy = groundingPolicy(terrainTreatment, label)
	return {
		authoredGroundingToleranceMeters = policy.authoredMaximumGapStuds * Constants.STUD_METERS,
		terrainQuantizationAllowanceMeters = policy.terrainQuantizationAllowanceStuds * Constants.STUD_METERS,
		observationToleranceMeters = policy.observationToleranceStuds * Constants.STUD_METERS,
		maximumPermittedBodyGapMeters = policy.maximumPermittedGapStuds * Constants.STUD_METERS,
	}
end

local function traceRouteTerrain(
	phase: "foundation" | "readback",
	route: any,
	segment: any,
	resolved: any,
	top: any,
	bodyBottom: any,
	groundingBottom: any
): ()
	local policy = groundingTracePolicy(route.terrainTreatment, "route")
	recordTraceEvent({
		kind = "route_terrain",
		phase = phase,
		routeId = route.routeId,
		segmentId = segment.segmentId,
		requiredSurfaceRevealMeters = route.terrainTreatment.surfaceRevealMeters,
		authoredGroundingToleranceMeters = policy.authoredGroundingToleranceMeters,
		terrainQuantizationAllowanceMeters = policy.terrainQuantizationAllowanceMeters,
		observationToleranceMeters = policy.observationToleranceMeters,
		maximumPermittedBodyGapMeters = policy.maximumPermittedBodyGapMeters,
		minimumSurfaceClearanceMeters = top.minimumStuds * Constants.STUD_METERS,
		maximumSurfaceClearanceMeters = top.maximumStuds * Constants.STUD_METERS,
		maximumBodyGapMeters = math.max(0, bodyBottom.maximumStuds * Constants.STUD_METERS),
		maximumGroundingBottomClearanceMeters = groundingBottom.maximumStuds * Constants.STUD_METERS,
		groundingDepthMeters = (resolved.groundingDepthStuds or 0) * Constants.STUD_METERS,
		startAdjustmentMeters = (resolved.startAdjustmentStuds or 0) * Constants.STUD_METERS,
		finishAdjustmentMeters = (resolved.finishAdjustmentStuds or 0) * Constants.STUD_METERS,
		minimumAtMeters = pointMeters(top.minimumPoint),
		maximumAtMeters = pointMeters(top.maximumPoint),
		maximumBodyGapAtMeters = pointMeters(bodyBottom.maximumPoint),
	})
end

local function crossSection(segment: any, firstIndex: number, secondIndex: number): (Vector3, Vector3)
	local left = segment.vertices[firstIndex].positionMeters
	local right = segment.vertices[secondIndex].positionMeters
	return Vector3.new(meters(left.x), meters(left.y), meters(left.z)), Vector3.new(meters(right.x), meters(right.y), meters(right.z))
end

local function logicalCrossSectionCenter(
	segment: any,
	firstIndex: number,
	secondIndex: number,
	planMiterMeters: any,
	profileMiterMeters: any,
	directionSign: number
): Vector3
	local left, right = crossSection(segment, firstIndex, secondIndex)
	local center = (left + right) / 2
	local startLeft, startRight = crossSection(segment, 1, 2)
	local finishLeft, finishRight = crossSection(segment, 3, 4)
	local startCenter = (startLeft + startRight) / 2
	local finishCenter = (finishLeft + finishRight) / 2
	local horizontal = Vector3.new(finishCenter.X - startCenter.X, 0, finishCenter.Z - startCenter.Z)
	if horizontal.Magnitude <= 0.001 then fail("route segment has no horizontal miter axis") end
	local gradeRatio = finite(segment.gradeRatio, "route grade ratio")
	local profileExtension = finite(profileMiterMeters, "route profile miter extension")
	local profileHorizontalMeters, profileVerticalMeters = RouteGeometry.profileMiterOffset(
		profileExtension,
		gradeRatio
	)
	local horizontalExtension = finite(planMiterMeters, "route plan miter extension")
		+ profileHorizontalMeters
	return center
		+ horizontal.Unit * meters(horizontalExtension) * directionSign
		+ Vector3.new(0, meters(profileVerticalMeters) * directionSign, 0)
end

-- The generic compiler already constructs the route and final terrain together.
-- Roblox may only correct the small residual introduced by its voxel surface;
-- it must reject a discrepancy large enough to change the authored profile.
local function resolveRouteFrames(route: any, endpointOverrides: any, recordTerrainTrace: boolean): any
	local result: { [string]: any } = {}
	if route.terrainTreatment.kind ~= "grade" or not routeUsesTerrain(route) then
		local stationAdjustments: { number } = table.create(#route.travelSegments + 1, 0)
		if endpointOverrides ~= nil then
			stationAdjustments[1] = math.max(0, endpointOverrides.start or 0)
			stationAdjustments[#stationAdjustments] = math.max(0, endpointOverrides.finish or 0)
		end
		for index, segment in ipairs(route.travelSegments) do
			local resolved = routeFrame(
				segment,
				route.thicknessMeters,
				stationAdjustments[index],
				stationAdjustments[index + 1]
			)
			resolved.startAdjustmentStuds = stationAdjustments[index]
			resolved.finishAdjustmentStuds = stationAdjustments[index + 1]
			resolved.groundingDepthStuds = 0
			result[segment.segmentId] = resolved
		end
		return { frames = result, stationAdjustments = stationAdjustments }
	end
	local context = terrainRaycastContext()
	local required = meters(finite(route.terrainTreatment.surfaceRevealMeters, "route surface reveal"))
	local targetClearance = required + Constants.TERRAIN_CONFORMANCE_MARGIN_STUDS
	local previousLogicalFinish: Vector3? = nil
	local stationAdjustments: { number } = table.create(#route.travelSegments + 1)
	for index, segment in ipairs(route.travelSegments) do
		local startLeft, startRight = crossSection(segment, 1, 2)
		local finishLeft, finishRight = crossSection(segment, 3, 4)
		local logicalStart = logicalCrossSectionCenter(
			segment,
			1,
			2,
			segment.startPlanMiterMeters,
			segment.startProfileMiterMeters,
			1
		)
		local logicalFinish = logicalCrossSectionCenter(
			segment,
			3,
			4,
			segment.endPlanMiterMeters,
			segment.endProfileMiterMeters,
			-1
		)
		if previousLogicalFinish ~= nil and segment.kind ~= "step_tread" then
			if (previousLogicalFinish - logicalStart).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
				fail("route segments are not spatially continuous at " .. segment.segmentId)
			end
		end
		previousLogicalFinish = logicalFinish
		for _, station in ipairs({ { startLeft, startRight, index }, { finishLeft, finishRight, index + 1 } }) do
			local correction = -math.huge
			for lateral = 0, 4 do
				local top = station[1]:Lerp(station[2], lateral / 4)
				local terrain = terrainHeight(context, top.X, top.Z, segment.segmentId)
				correction = math.max(correction, terrain + targetClearance - top.Y)
			end
			stationAdjustments[station[3]] = math.max(stationAdjustments[station[3]] or -math.huge, correction)
		end
	end
	for index = 1, #stationAdjustments do
		stationAdjustments[index] = math.max(0, stationAdjustments[index] or 0)
		if stationAdjustments[index] > Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS then
			fail(string.format(
				"route %s requires %.4fm of Roblox residual correction, exceeding %.4fm",
				route.routeId,
				stationAdjustments[index] * Constants.STUD_METERS,
				Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS * Constants.STUD_METERS
			))
		end
	end
	if endpointOverrides ~= nil then
		stationAdjustments[1] = math.max(stationAdjustments[1], endpointOverrides.start or 0)
		stationAdjustments[#stationAdjustments] = math.max(stationAdjustments[#stationAdjustments], endpointOverrides.finish or 0)
	end
	local converged = false
	for iteration = 1, Constants.MAX_TERRAIN_CONFORMANCE_ITERATIONS do
		local changed = false
		for index, segment in ipairs(route.travelSegments) do
			local resolved = routeFrame(
				segment,
				route.thicknessMeters,
				stationAdjustments[index],
				stationAdjustments[index + 1]
			)
			local top = observeFramePlane(
				resolved.frame,
				resolved.size,
				resolved.size.Y / 2,
				context,
				segment.segmentId
			)
			local deficit = targetClearance - top.minimumStuds
			if deficit > 0.00001 then
				stationAdjustments[index] += deficit
				stationAdjustments[index + 1] += deficit
				if stationAdjustments[index] > Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS
					or stationAdjustments[index + 1] > Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS then
					fail("route " .. route.routeId .. " cannot conform to Roblox terrain within the bounded residual")
				end
				changed = true
			end
		end
		if not changed then
			converged = true
			break
		end
		if iteration == Constants.MAX_TERRAIN_CONFORMANCE_ITERATIONS then break end
	end
	if not converged then fail("route " .. route.routeId .. " residual conformance did not converge") end
	local policy = groundingPolicy(route.terrainTreatment, "route")
	for index, segment in ipairs(route.travelSegments) do
		local resolved = routeFrame(
			segment,
			route.thicknessMeters,
			stationAdjustments[index],
			stationAdjustments[index + 1]
		)
		resolved.startAdjustmentStuds = stationAdjustments[index]
		resolved.finishAdjustmentStuds = stationAdjustments[index + 1]
		local top = observeFramePlane(
			resolved.frame,
			resolved.size,
			resolved.size.Y / 2,
			context,
			segment.segmentId
		)
		local bodyBottom = observeFramePlane(
			resolved.frame,
			resolved.size,
			-resolved.size.Y / 2,
			context,
			segment.segmentId
		)
		if not RouteGrounding.withinTolerance(
			bodyBottom.maximumStuds,
			policy.authoredMaximumGapStuds,
			policy.terrainQuantizationAllowanceStuds,
			policy.observationToleranceStuds
		) then
			resolved.groundingDepthStuds = 0
			traceRouteTerrain("foundation", route, segment, resolved, top, bodyBottom, bodyBottom)
			fail(string.format(
				"route %s needs %.4fm of grounding beneath its authored body, exceeding the bounded Roblox maximum %.4fm (authored %.4fm + voxel %.4fm + observation %.4fm) at (%.3fm, %.3fm); see .basalt/roblox/import-report.json",
				segment.segmentId,
				bodyBottom.maximumStuds * Constants.STUD_METERS,
				policy.maximumPermittedGapStuds * Constants.STUD_METERS,
				route.terrainTreatment.groundingToleranceMeters,
				policy.terrainQuantizationAllowanceStuds * Constants.STUD_METERS,
				policy.observationToleranceStuds * Constants.STUD_METERS,
				bodyBottom.maximumPoint.X * Constants.STUD_METERS,
				bodyBottom.maximumPoint.Z * Constants.STUD_METERS
			))
		end
		local groundingDepth, groundingBottom = resolveGroundingDepth(
			resolved,
			bodyBottom,
			context,
			segment.segmentId
		)
		resolved.groundingDepthStuds = groundingDepth
		if recordTerrainTrace then
			traceRouteTerrain("foundation", route, segment, resolved, top, bodyBottom, groundingBottom)
		end
		result[segment.segmentId] = resolved
	end
	return { frames = result, stationAdjustments = stationAdjustments }
end

local function junctionTerrainCorrection(junction: any): number
	if junction.terrainTreatment.kind ~= "grade" then return 0 end
	local context = terrainRaycastContext()
	local required = meters(finite(junction.terrainTreatment.surfaceRevealMeters, "junction surface reveal"))
	local targetClearance = required + Constants.TERRAIN_CONFORMANCE_MARGIN_STUDS
	local center = Vector3.new(
		meters(finite(junction.centerTopMeters.x, "junction x")),
		meters(finite(junction.centerTopMeters.y, "junction top")),
		meters(finite(junction.centerTopMeters.z, "junction z"))
	)
	local radius = meters(finite(junction.radiusMeters, "junction radius"))
	local correction = 0
	for ring = 0, 2 do
		local sampleRadius = radius * ring / 2
		local samples = if ring == 0 then 1 else 8
		for index = 1, samples do
			local angle = 2 * math.pi * (index - 1) / samples
			local x = center.X + math.cos(angle) * sampleRadius
			local z = center.Z + math.sin(angle) * sampleRadius
			correction = math.max(
				correction,
				terrainHeight(context, x, z, junction.junctionId) + targetClearance - center.Y
			)
		end
	end
	if correction > Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS then
		fail(string.format(
			"route junction %s requires %.4fm of Roblox residual correction, exceeding %.4fm",
			junction.junctionId,
			correction * Constants.STUD_METERS,
			Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS * Constants.STUD_METERS
		))
	end
	return correction
end

local function observeJunctionPlane(junction: any, y: number, context: any): any
	local center = Vector3.new(
		meters(finite(junction.centerTopMeters.x, "junction x")),
		y,
		meters(finite(junction.centerTopMeters.z, "junction z"))
	)
	local radius = meters(finite(junction.radiusMeters, "junction radius"))
	local minimum = math.huge
	local maximum = -math.huge
	local minimumPoint: Vector3? = nil
	local maximumPoint: Vector3? = nil
	for ring = 0, 2 do
		local sampleRadius = radius * ring / 2
		local samples = if ring == 0 then 1 else 8
		for index = 1, samples do
			local angle = 2 * math.pi * (index - 1) / samples
			local point = center + Vector3.new(
				math.cos(angle) * sampleRadius,
				0,
				math.sin(angle) * sampleRadius
			)
			local clearance = point.Y - terrainHeight(context, point.X, point.Z, junction.junctionId)
			if clearance < minimum then
				minimum = clearance
				minimumPoint = point
			end
			if clearance > maximum then
				maximum = clearance
				maximumPoint = point
			end
		end
	end
	if minimumPoint == nil or maximumPoint == nil then fail("route junction observation produced no samples") end
	return {
		minimumStuds = minimum,
		maximumStuds = maximum,
		minimumPoint = minimumPoint,
		maximumPoint = maximumPoint,
	}
end

local function resolveJunctionGeometry(junction: any, adjustmentStuds: number): any
	if junction.terrainTreatment.kind ~= "grade" then
		return { adjustmentStuds = adjustmentStuds, groundingDepthStuds = 0 }
	end
	local context = terrainRaycastContext()
	local topY = meters(finite(junction.centerTopMeters.y, "junction top")) + adjustmentStuds
	local thickness = meters(finite(junction.thicknessMeters, "junction thickness"))
	local top = observeJunctionPlane(junction, topY, context)
	local bodyBottom = observeJunctionPlane(junction, topY - thickness, context)
	local policy = groundingPolicy(junction.terrainTreatment, "junction")
	local tracePolicy = groundingTracePolicy(junction.terrainTreatment, "junction")
	local resolution = {
		adjustmentStuds = adjustmentStuds,
		groundingDepthStuds = 0,
	}
	local function trace(groundingBottom: any): ()
		recordTraceEvent({
			kind = "route_junction_terrain",
			phase = "foundation",
			junctionId = junction.junctionId,
			requiredSurfaceRevealMeters = junction.terrainTreatment.surfaceRevealMeters,
			authoredGroundingToleranceMeters = tracePolicy.authoredGroundingToleranceMeters,
			terrainQuantizationAllowanceMeters = tracePolicy.terrainQuantizationAllowanceMeters,
			observationToleranceMeters = tracePolicy.observationToleranceMeters,
			maximumPermittedBodyGapMeters = tracePolicy.maximumPermittedBodyGapMeters,
			minimumSurfaceClearanceMeters = top.minimumStuds * Constants.STUD_METERS,
			maximumSurfaceClearanceMeters = top.maximumStuds * Constants.STUD_METERS,
			maximumBodyGapMeters = math.max(0, bodyBottom.maximumStuds * Constants.STUD_METERS),
			maximumGroundingBottomClearanceMeters = groundingBottom.maximumStuds * Constants.STUD_METERS,
			groundingDepthMeters = resolution.groundingDepthStuds * Constants.STUD_METERS,
			adjustmentMeters = adjustmentStuds * Constants.STUD_METERS,
			minimumAtMeters = pointMeters(top.minimumPoint),
			maximumAtMeters = pointMeters(top.maximumPoint),
			maximumBodyGapAtMeters = pointMeters(bodyBottom.maximumPoint),
		})
	end
	if not RouteGrounding.withinTolerance(
		bodyBottom.maximumStuds,
		policy.authoredMaximumGapStuds,
		policy.terrainQuantizationAllowanceStuds,
		policy.observationToleranceStuds
	) then
		trace(bodyBottom)
		fail(string.format(
			"route junction %s needs %.4fm of grounding beneath its authored body, exceeding the bounded Roblox maximum %.4fm (authored %.4fm + voxel %.4fm + observation %.4fm); see .basalt/roblox/import-report.json",
			junction.junctionId,
			bodyBottom.maximumStuds * Constants.STUD_METERS,
			policy.maximumPermittedGapStuds * Constants.STUD_METERS,
			junction.terrainTreatment.groundingToleranceMeters,
			policy.terrainQuantizationAllowanceStuds * Constants.STUD_METERS,
			policy.observationToleranceStuds * Constants.STUD_METERS
		))
	end
	local groundingDepth = RouteGrounding.initialDepthStuds(
		bodyBottom.maximumStuds,
		1,
		Constants.TERRAIN_GROUNDING_OVERLAP_STUDS
	)
	resolution.groundingDepthStuds = groundingDepth
	local groundingBottom = if groundingDepth > 0
		then observeJunctionPlane(junction, topY - thickness - groundingDepth, context)
		else bodyBottom
	trace(groundingBottom)
	return resolution
end

local function resolveFoundationRouteGeometry(foundation: any): (any, any)
	local junctionAdjustments: { [string]: number } = {}
	for _, junction in ipairs(foundation.routeJunctions) do
		junctionAdjustments[junction.junctionId] = junctionTerrainCorrection(junction)
	end
	local coordination = RouteCoordination.resolve(
		foundation.routeConstructions,
		foundation.routeJunctions,
		junctionAdjustments,
		function(route: any, endpointOverrides: any): any
			if route.status ~= "eligible" then fail("route construction is not eligible: " .. route.routeId) end
			return resolveRouteFrames(route, endpointOverrides, false)
		end,
		Constants.MAX_ROUTE_JUNCTION_COORDINATION_ITERATIONS,
		Constants.ROUTE_JUNCTION_COORDINATION_QUANTUM_STUDS
	)
	-- Tentative fixed-point passes must not consume the durable trace budget.
	-- Re-resolve the accepted state once so diagnostics describe only geometry
	-- that can actually be committed to the world.
	local finalRouteResolutions = {}
	for _, route in ipairs(foundation.routeConstructions) do
		finalRouteResolutions[route.routeId] = resolveRouteFrames(
			route,
			coordination.routeOverrides[route.routeId],
			true
		)
	end
	local junctionResolutions = {}
	for _, junction in ipairs(foundation.routeJunctions) do
		junctionResolutions[junction.junctionId] = resolveJunctionGeometry(
			junction,
			coordination.junctionAdjustments[junction.junctionId] or 0
		)
	end
	return finalRouteResolutions, junctionResolutions
end

local function verifyJunctionTerrainContact(
	part: BasePart,
	groundingPart: BasePart?,
	junction: any,
	resolution: any
): ()
	if junction.terrainTreatment.kind ~= "grade" then return end
	local context = terrainRaycastContext()
	local required = meters(finite(junction.terrainTreatment.surfaceRevealMeters, "junction surface reveal"))
	local policy = groundingPolicy(junction.terrainTreatment, "junction")
	local tracePolicy = groundingTracePolicy(junction.terrainTreatment, "junction")
	local topY = part.Position.Y + part.Size.X / 2
	local top = observeJunctionPlane(junction, topY, context)
	local bodyBottom = observeJunctionPlane(junction, topY - part.Size.X, context)
	local groundingBottom = bodyBottom
	if groundingPart ~= nil then
		groundingBottom = observeJunctionPlane(
			junction,
			groundingPart.Position.Y - groundingPart.Size.X / 2,
			context
		)
	end
	recordTraceEvent({
		kind = "route_junction_terrain",
		phase = "readback",
		junctionId = junction.junctionId,
		requiredSurfaceRevealMeters = junction.terrainTreatment.surfaceRevealMeters,
		authoredGroundingToleranceMeters = tracePolicy.authoredGroundingToleranceMeters,
		terrainQuantizationAllowanceMeters = tracePolicy.terrainQuantizationAllowanceMeters,
		observationToleranceMeters = tracePolicy.observationToleranceMeters,
		maximumPermittedBodyGapMeters = tracePolicy.maximumPermittedBodyGapMeters,
		minimumSurfaceClearanceMeters = top.minimumStuds * Constants.STUD_METERS,
		maximumSurfaceClearanceMeters = top.maximumStuds * Constants.STUD_METERS,
		maximumBodyGapMeters = math.max(0, bodyBottom.maximumStuds * Constants.STUD_METERS),
		maximumGroundingBottomClearanceMeters = groundingBottom.maximumStuds * Constants.STUD_METERS,
		groundingDepthMeters = (resolution.groundingDepthStuds or 0) * Constants.STUD_METERS,
		adjustmentMeters = (resolution.adjustmentStuds or 0) * Constants.STUD_METERS,
		minimumAtMeters = pointMeters(top.minimumPoint),
		maximumAtMeters = pointMeters(top.maximumPoint),
		maximumBodyGapAtMeters = pointMeters(bodyBottom.maximumPoint),
	})
	if top.minimumStuds + Constants.TERRAIN_CONTACT_TOLERANCE_STUDS < required then
		fail(string.format(
			"route junction %s is buried at %s: clearance %.4fm, required %.4fm; see .basalt/roblox/import-report.json",
			junction.junctionId,
			formatVectorMeters(top.minimumPoint),
			top.minimumStuds * Constants.STUD_METERS,
			junction.terrainTreatment.surfaceRevealMeters
		))
	end
	if not RouteGrounding.withinTolerance(
		bodyBottom.maximumStuds,
		policy.authoredMaximumGapStuds,
		policy.terrainQuantizationAllowanceStuds,
		policy.observationToleranceStuds
	) then
		fail(string.format(
			"route junction %s has %.4fm of unfilled space beneath its body at %s, exceeding the bounded Roblox maximum %.4fm; see .basalt/roblox/import-report.json",
			junction.junctionId,
			bodyBottom.maximumStuds * Constants.STUD_METERS,
			formatVectorMeters(bodyBottom.maximumPoint),
			policy.maximumPermittedGapStuds * Constants.STUD_METERS
		))
	end
	if groundingPart ~= nil
		and groundingBottom.maximumStuds > Constants.TERRAIN_CONTACT_TOLERANCE_STUDS then
		fail(string.format(
			"route junction %s grounding remains %.4fm above terrain at %s; see .basalt/roblox/import-report.json",
			junction.junctionId,
			groundingBottom.maximumStuds * Constants.STUD_METERS,
			formatVectorMeters(groundingBottom.maximumPoint)
		))
	end
end

local function verifyRouteTerrainContact(
	part: BasePart,
	groundingPart: BasePart?,
	route: any,
	segment: any,
	resolved: any
): ()
	if route.terrainTreatment.kind ~= "grade" or not routeUsesTerrain(route) then return end
	local context = terrainRaycastContext()
	local required = meters(finite(route.terrainTreatment.surfaceRevealMeters, "route surface reveal"))
	local policy = groundingPolicy(route.terrainTreatment, "route")
	local top = observeFramePlane(part.CFrame, part.Size, part.Size.Y / 2, context, segment.segmentId)
	local bodyBottom = observeFramePlane(
		part.CFrame,
		part.Size,
		-part.Size.Y / 2,
		context,
		segment.segmentId
	)
	local groundingBottom = bodyBottom
	if groundingPart ~= nil then
		groundingBottom = observeFramePlane(
			groundingPart.CFrame,
			groundingPart.Size,
			-groundingPart.Size.Y / 2,
			context,
			segment.segmentId
		)
	end
	traceRouteTerrain("readback", route, segment, resolved, top, bodyBottom, groundingBottom)
	if top.minimumStuds + Constants.TERRAIN_CONTACT_TOLERANCE_STUDS < required then
		fail(string.format(
			"route %s is buried at %s: clearance %.4fm, required %.4fm; see .basalt/roblox/import-report.json",
			segment.segmentId,
			formatVectorMeters(top.minimumPoint),
			top.minimumStuds * Constants.STUD_METERS,
			route.terrainTreatment.surfaceRevealMeters
		))
	end
	if not RouteGrounding.withinTolerance(
		bodyBottom.maximumStuds,
		policy.authoredMaximumGapStuds,
		policy.terrainQuantizationAllowanceStuds,
		policy.observationToleranceStuds
	) then
		fail(string.format(
			"route %s has %.4fm of unfilled space beneath its body at %s, exceeding the bounded Roblox maximum %.4fm; see .basalt/roblox/import-report.json",
			segment.segmentId,
			bodyBottom.maximumStuds * Constants.STUD_METERS,
			formatVectorMeters(bodyBottom.maximumPoint),
			policy.maximumPermittedGapStuds * Constants.STUD_METERS
		))
	end
	if groundingPart ~= nil
		and groundingBottom.maximumStuds > Constants.TERRAIN_CONTACT_TOLERANCE_STUDS then
		fail(string.format(
			"route %s grounding remains %.4fm above terrain at %s; see .basalt/roblox/import-report.json",
			segment.segmentId,
			groundingBottom.maximumStuds * Constants.STUD_METERS,
			formatVectorMeters(groundingBottom.maximumPoint)
		))
	end
end

local function verifyRouteBlock(
	part: Instance?,
	expectedSize: Vector3,
	expectedFrame: CFrame,
	appearance: any,
	label: string
): BasePart
	if part == nil or not part:IsA("Part") or part.Shape ~= Enum.PartType.Block then
		fail(label .. " is missing or has the wrong primitive")
	end
	local positionDelta = (part.Position - expectedFrame.Position).Magnitude
	if positionDelta > Constants.BOUND_TOLERANCE_STUDS then
		fail(string.format(
			"%s position drifted by %.6fm: observed %s, expected %s",
			label,
			positionDelta * Constants.STUD_METERS,
			formatVectorMeters(part.Position),
			formatVectorMeters(expectedFrame.Position)
		))
	end
	local sizeDelta = (part.Size - expectedSize).Magnitude
	if sizeDelta > Constants.BOUND_TOLERANCE_STUDS then
		fail(string.format(
			"%s size drifted by %.6fm: observed %s, expected %s",
			label,
			sizeDelta * Constants.STUD_METERS,
			formatVectorMeters(part.Size),
			formatVectorMeters(expectedSize)
		))
	end
	local rightDot = part.CFrame.RightVector:Dot(expectedFrame.RightVector)
	local upDot = part.CFrame.UpVector:Dot(expectedFrame.UpVector)
	local lookDot = part.CFrame.LookVector:Dot(expectedFrame.LookVector)
	if rightDot < Constants.FRAME_DIRECTION_DOT_MINIMUM
		or upDot < Constants.FRAME_DIRECTION_DOT_MINIMUM
		or lookDot < Constants.FRAME_DIRECTION_DOT_MINIMUM then
		fail(string.format(
			"%s orientation drifted: right %.8f, up %.8f, look %.8f",
			label,
			rightDot,
			upDot,
			lookDot
		))
	end
	if not part.Anchored then fail(label .. " is no longer anchored") end
	if not part.CanCollide then fail(label .. " no longer collides") end
	local expectedMaterial = routeMaterial(appearance.materialId)
	if part.Material ~= expectedMaterial then
		fail(string.format(
			"%s material drifted: observed %s, expected %s",
			label,
			part.Material.Name,
			expectedMaterial.Name
		))
	end
	if not routeColorMatches(part, appearance) then
		local color = appearance.baseColorSrgb
		fail(string.format(
			"%s color drifted: observed (%d, %d, %d), expected (%d, %d, %d)",
			label,
			roundedChannel(part.Color.R),
			roundedChannel(part.Color.G),
			roundedChannel(part.Color.B),
			color.red,
			color.green,
			color.blue
		))
	end
	return part
end

local function verifyRouteConstruction(root: Instance, routeConstruction: any): ()
	local routes = root:FindFirstChild("Routes")
	if routes == nil or not routes:IsA("Folder") then fail("route root is missing") end
	local route = routes:FindFirstChild(routeConstruction.routeId)
	if route == nil or not route:IsA("Folder") then fail("route geometry is missing for " .. routeConstruction.routeId) end
	if route:GetAttribute("BasaltRouteConstructionHash") ~= routeConstruction.hash then fail("route readback drifted for " .. routeConstruction.routeId) end
	local surfaces = route:FindFirstChild("TravelSurfaces")
	if surfaces == nil or not surfaces:IsA("Folder") or #surfaces:GetChildren() ~= #routeConstruction.travelSegments then
		fail("route segment count drifted for " .. routeConstruction.routeId)
	end
	local groundings = route:FindFirstChild("Grounding")
	if groundings == nil or not groundings:IsA("Folder") then
		fail("route grounding root is missing for " .. routeConstruction.routeId)
	end
	local expectedGroundingCount = 0
	for _, segment in ipairs(routeConstruction.travelSegments) do
		local expected = pendingRouteFrames[routeFrameKey(routeConstruction.routeId, segment.segmentId)]
		if expected ~= nil and (expected.groundingDepthStuds or 0) > 0.001 then
			expectedGroundingCount += 1
		end
	end
	if #groundings:GetChildren() ~= expectedGroundingCount then
		fail("route grounding count drifted for " .. routeConstruction.routeId)
	end
	for _, segment in ipairs(routeConstruction.travelSegments) do
		local expected = pendingRouteFrames[routeFrameKey(routeConstruction.routeId, segment.segmentId)]
		if expected == nil then fail("route lowering evidence is missing for " .. segment.segmentId) end
		local part = verifyRouteBlock(
			surfaces:FindFirstChild(segment.segmentId),
			expected.size,
			expected.frame,
			routeConstruction.appearance,
			"route segment " .. segment.segmentId
		)
		local groundingPart: BasePart? = nil
		local groundingSize, groundingFrame = groundingGeometry(expected)
		if groundingSize ~= nil and groundingFrame ~= nil then
			groundingPart = verifyRouteBlock(
				groundings:FindFirstChild(segment.segmentId),
				groundingSize,
				groundingFrame,
				routeConstruction.appearance,
				"route grounding " .. segment.segmentId
			)
			if groundingPart:GetAttribute("BasaltRouteGrounding") ~= true then
				fail("route grounding identity drifted for " .. segment.segmentId)
			end
		elseif groundings:FindFirstChild(segment.segmentId) ~= nil then
			fail("route segment has unexpected grounding: " .. segment.segmentId)
		end
		verifyRouteTerrainContact(part, groundingPart, routeConstruction, segment, expected)
	end
end

local function verticalCylinderGeometry(centerMeters: any, radiusMeters: any, heightMeters: any): (Vector3, Vector3, CFrame)
	local radius = meters(finite(radiusMeters, "route cylinder radius"))
	local height = meters(finite(heightMeters, "route cylinder height"))
	local center = Vector3.new(
		meters(finite(centerMeters.x, "route cylinder x")),
		meters(finite(centerMeters.y, "route cylinder y")),
		meters(finite(centerMeters.z, "route cylinder z"))
	)
	local size = Vector3.new(height, radius * 2, radius * 2)
	return center, size, CFrame.new(center) * CFrame.Angles(0, 0, math.pi / 2)
end

local function lowerVerticalCylinder(parent: Instance, name: string, centerMeters: any, radiusMeters: any, heightMeters: any, appearance: any, artifactHash: string): Part
	local _, size, frame = verticalCylinderGeometry(centerMeters, radiusMeters, heightMeters)
	local part = Instance.new("Part")
	part.Name = name
	part.Shape = Enum.PartType.Cylinder
	part.Size = size
	part.CFrame = frame
	part.Anchored = true
	part.CanCollide = true
	part.Material = routeMaterial(appearance.materialId)
	part.Color = routeColor(appearance)
	part:SetAttribute("BasaltArtifactHash", requireHash(artifactHash, "route cylinder hash"))
	part.Parent = parent
	return part
end

local function verifyVerticalCylinder(parent: Instance, name: string, centerMeters: any, radiusMeters: any, heightMeters: any, appearance: any, artifactHash: string): ()
	local part = parent:FindFirstChild(name)
	if part == nil or not part:IsA("Part") then fail("route cylinder is missing: " .. name) end
	local center, size, frame = verticalCylinderGeometry(centerMeters, radiusMeters, heightMeters)
	if part.Shape ~= Enum.PartType.Cylinder then fail("route cylinder primitive drifted for " .. name) end
	if (part.Position - center).Magnitude > Constants.BOUND_TOLERANCE_STUDS then fail("route cylinder position drifted for " .. name) end
	if (part.Size - size).Magnitude > Constants.BOUND_TOLERANCE_STUDS then fail("route cylinder size drifted for " .. name) end
	if part.CFrame.RightVector:Dot(frame.RightVector) < Constants.FRAME_DIRECTION_DOT_MINIMUM
		or part.CFrame.UpVector:Dot(frame.UpVector) < Constants.FRAME_DIRECTION_DOT_MINIMUM
		or part.CFrame.LookVector:Dot(frame.LookVector) < Constants.FRAME_DIRECTION_DOT_MINIMUM then
		fail("route cylinder orientation drifted for " .. name)
	end
	if part.Material ~= routeMaterial(appearance.materialId) then fail("route cylinder material drifted for " .. name) end
	if not routeColorMatches(part, appearance) then fail("route cylinder color drifted for " .. name) end
	if not part.Anchored then fail("route cylinder is no longer anchored: " .. name) end
	if not part.CanCollide then fail("route cylinder no longer collides: " .. name) end
	if part:GetAttribute("BasaltArtifactHash") ~= artifactHash then fail("route cylinder identity drifted for " .. name) end
end

local function routeAdjustmentAtStation(
	routeConstruction: any,
	stationAdjustments: { number },
	stationMeters: number
): number
	for index, segment in ipairs(routeConstruction.travelSegments) do
		local startMeters = finite(segment.startStationMeters, "route ancillary start station")
		local finishMeters = finite(segment.endStationMeters, "route ancillary finish station")
		if stationMeters <= finishMeters + 0.000000001 then
			local fraction = math.clamp((stationMeters - startMeters) / (finishMeters - startMeters), 0, 1)
			local startAdjustment = stationAdjustments[index]
			local finishAdjustment = stationAdjustments[index + 1]
			if startAdjustment == nil or finishAdjustment == nil then
				fail("route ancillary station adjustment is incomplete for " .. routeConstruction.routeId)
			end
			return startAdjustment + (finishAdjustment - startAdjustment) * fraction
		end
	end
	fail("route ancillary station lies outside the sealed route profile for " .. routeConstruction.routeId)
end

local function adjustedVerticalCylinder(
	item: any,
	adjustmentStuds: number,
	extendToGround: boolean
): (any, number)
	local adjustmentMeters = adjustmentStuds * Constants.STUD_METERS
	return {
		x = item.centerMeters.x,
		y = item.centerMeters.y + (if extendToGround then adjustmentMeters / 2 else adjustmentMeters),
		z = item.centerMeters.z,
	}, item.heightMeters + (if extendToGround then adjustmentMeters else 0)
end

local function lowerRouteAncillaries(
	routeFolder: Folder,
	routeConstruction: any,
	stationAdjustments: { number }
): ()
	local supports = Instance.new("Folder")
	supports.Name = "Supports"
	supports.Parent = routeFolder
	for _, support in ipairs(routeConstruction.supports) do
		local adjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(support.stationMeters, "route support station")
		)
		local centerMeters, heightMeters = adjustedVerticalCylinder(support, adjustment, true)
		lowerVerticalCylinder(supports, support.supportId, centerMeters, support.radiusMeters, heightMeters, support.appearance, support.hash)
	end
	local edgeRails = Instance.new("Folder")
	edgeRails.Name = "EdgeRails"
	edgeRails.Parent = routeFolder
	for _, rail in ipairs(routeConstruction.edgeRails) do
		local startAdjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(rail.startStationMeters, "route edge-rail start station")
		)
		local finishAdjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(rail.endStationMeters, "route edge-rail finish station")
		)
		local resolved = routeFrame(rail, rail.thicknessMeters, startAdjustment, finishAdjustment)
		local part = createRouteBlock(edgeRails, rail.railId, resolved.size, resolved.frame, rail.appearance)
		part:SetAttribute("BasaltArtifactHash", requireHash(rail.hash, "route edge-rail hash"))
	end
	local edgePosts = Instance.new("Folder")
	edgePosts.Name = "EdgePosts"
	edgePosts.Parent = routeFolder
	for _, post in ipairs(routeConstruction.edgePosts) do
		local adjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(post.stationMeters, "route edge-post station")
		)
		local centerMeters, heightMeters = adjustedVerticalCylinder(post, adjustment, false)
		lowerVerticalCylinder(edgePosts, post.postId, centerMeters, post.radiusMeters, heightMeters, post.appearance, post.hash)
	end
end

local function verifyRouteAncillaries(
	routeFolder: Folder,
	routeConstruction: any,
	stationAdjustments: { number }
): ()
	local supports = routeFolder:FindFirstChild("Supports")
	if supports == nil or not supports:IsA("Folder") or #supports:GetChildren() ~= #routeConstruction.supports then
		fail("route support count drifted for " .. routeConstruction.routeId)
	end
	for _, support in ipairs(routeConstruction.supports) do
		local adjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(support.stationMeters, "route support station")
		)
		local centerMeters, heightMeters = adjustedVerticalCylinder(support, adjustment, true)
		verifyVerticalCylinder(supports, support.supportId, centerMeters, support.radiusMeters, heightMeters, support.appearance, support.hash)
	end
	local edgeRails = routeFolder:FindFirstChild("EdgeRails")
	if edgeRails == nil or not edgeRails:IsA("Folder") or #edgeRails:GetChildren() ~= #routeConstruction.edgeRails then
		fail("route edge-rail count drifted for " .. routeConstruction.routeId)
	end
	for _, rail in ipairs(routeConstruction.edgeRails) do
		local startAdjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(rail.startStationMeters, "route edge-rail start station")
		)
		local finishAdjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(rail.endStationMeters, "route edge-rail finish station")
		)
		local resolved = routeFrame(rail, rail.thicknessMeters, startAdjustment, finishAdjustment)
		local part = verifyRouteBlock(
			edgeRails:FindFirstChild(rail.railId),
			resolved.size,
			resolved.frame,
			rail.appearance,
			"route edge rail " .. rail.railId
		)
		if part:GetAttribute("BasaltArtifactHash") ~= rail.hash then
			fail("route edge-rail identity drifted for " .. rail.railId)
		end
	end
	local edgePosts = routeFolder:FindFirstChild("EdgePosts")
	if edgePosts == nil or not edgePosts:IsA("Folder") or #edgePosts:GetChildren() ~= #routeConstruction.edgePosts then
		fail("route edge-post count drifted for " .. routeConstruction.routeId)
	end
	for _, post in ipairs(routeConstruction.edgePosts) do
		local adjustment = routeAdjustmentAtStation(
			routeConstruction,
			stationAdjustments,
			finite(post.stationMeters, "route edge-post station")
		)
		local centerMeters, heightMeters = adjustedVerticalCylinder(post, adjustment, false)
		verifyVerticalCylinder(edgePosts, post.postId, centerMeters, post.radiusMeters, heightMeters, post.appearance, post.hash)
	end
end

function WorldLowering.preflight(transaction: any, session: any): ()
	requireHash(transaction.hash, "transaction.hash")
	requireHash(transaction.sessionHash, "transaction.sessionHash")
	requireHash(transaction.worldBuildHash, "transaction.worldBuildHash")
	if transaction.sessionHash ~= session.sessionHash or transaction.worldBuildHash ~= session.worldBuildHash then
		fail("transaction does not belong to the discovered world build")
	end
	if session.loweringGapCount > 0 then
		fail(tostring(session.loweringGapCount) .. " import requirements have no admitted Roblox lowering")
	end
	if pendingCommit ~= nil then fail("an unfinished in-memory Basalt commit is present") end
	local orphanedBackup = Workspace:FindFirstChild(Constants.BACKUP_FOLDER)
	if orphanedBackup ~= nil then
		local current = Workspace:FindFirstChild(Constants.WORLD_FOLDER)
		if not isOwnedFolder(orphanedBackup, "BasaltWorldBuildHash")
			or current == nil
			or not isOwnedFolder(current, "BasaltWorldBuildHash")
			or typeof(current:GetAttribute("BasaltObservedWorldStateHash")) ~= "string" then
			fail("an invalid unfinished Basalt commit backup is present")
		end
		-- prepareCommit only swaps a fully read-back staging world. If Studio
		-- reloaded before acknowledgement, that verified world is the coherent
		-- baseline for the next clean import; the superseded owned backup can go.
		orphanedBackup:Destroy()
	end
	local stale = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
	if stale ~= nil then
		if not isOwnedFolder(stale, "BasaltSessionHash") then
			fail("Workspace." .. Constants.STAGING_FOLDER .. " is not owned by Basalt")
		end
		stale:Destroy()
	end
	clearPendingState()
	createStagingFolder(transaction.sessionHash)
	pendingStage = "preflight"
end

function WorldLowering.foundation(transaction: any): any
	requireStage("preflight", "foundation")
	local root = requireStagingFolder(transaction.sessionHash)
	local foundation = transaction.foundation
	if typeof(foundation) ~= "table" then fail("foundation transaction has no foundation payload") end
	pendingFoundation = foundation
	TerrainLowering.begin(
		foundation.baseTerrainFields,
		foundation.terrainFields,
		foundation.routeConstructions,
		foundation.routeJunctions,
		foundation.worldBoundsMeters
	)
	local routes = Instance.new("Folder")
	routes.Name = "Routes"
	routes.Parent = root
	local junctions = Instance.new("Folder")
	junctions.Name = "RouteJunctions"
	junctions.Parent = root
	local junctionGroundings = Instance.new("Folder")
	junctionGroundings.Name = "RouteJunctionGrounding"
	junctionGroundings.Parent = root
	local observations = {}
	local routeResolutions, junctionResolutions = resolveFoundationRouteGeometry(foundation)
	pendingJunctionResolutions = junctionResolutions
	for _, field in ipairs(foundation.terrainFields) do
		table.insert(observations, {
			artifactKind = "terrain_field",
			artifactId = field.terrainPlanId,
			realizedHash = requireHash(field.hash, "terrain field hash"),
		})
	end
	for _, routeConstruction in ipairs(foundation.routeConstructions) do
		local route = Instance.new("Folder")
		route.Name = routeConstruction.routeId
		route:SetAttribute("BasaltRouteConstructionHash", requireHash(routeConstruction.hash, "route construction hash"))
		route.Parent = routes
		local surfaces = Instance.new("Folder")
		surfaces.Name = "TravelSurfaces"
		surfaces.Parent = route
		local groundings = Instance.new("Folder")
		groundings.Name = "Grounding"
		groundings.Parent = route
		local resolution = routeResolutions[routeConstruction.routeId]
		if resolution == nil then fail("route resolution is missing for " .. routeConstruction.routeId) end
		local frames = resolution.frames
		for _, segment in ipairs(routeConstruction.travelSegments) do
			local resolved = frames[segment.segmentId]
			if resolved == nil then fail("route frame resolution is incomplete for " .. segment.segmentId) end
			pendingRouteFrames[routeFrameKey(routeConstruction.routeId, segment.segmentId)] = resolved
			spanRoute(surfaces, groundings, segment, resolved, routeConstruction.appearance)
		end
		pendingRouteStationAdjustments[routeConstruction.routeId] = resolution.stationAdjustments
		lowerRouteAncillaries(route, routeConstruction, resolution.stationAdjustments)
		table.insert(observations, {
			artifactKind = "route_construction",
			artifactId = routeConstruction.routeId,
			realizedHash = requireHash(routeConstruction.hash, "route construction hash"),
		})
	end
	for _, junction in ipairs(foundation.routeJunctions) do
		local resolution = junctionResolutions[junction.junctionId]
		if resolution == nil then fail("route junction resolution is missing for " .. junction.junctionId) end
		local adjustmentMeters = resolution.adjustmentStuds * Constants.STUD_METERS
		local surfaceTopMeters = junction.centerTopMeters.y + adjustmentMeters
		lowerVerticalCylinder(
			junctions,
			junction.junctionId,
			{ x = junction.centerTopMeters.x, y = surfaceTopMeters - junction.thicknessMeters / 2, z = junction.centerTopMeters.z },
			junction.radiusMeters,
			junction.thicknessMeters,
			junction.appearance,
			junction.hash
		)
		local groundingDepthMeters = resolution.groundingDepthStuds * Constants.STUD_METERS
		if resolution.groundingDepthStuds > 0.001 then
			local grounding = lowerVerticalCylinder(
				junctionGroundings,
				junction.junctionId,
				{
					x = junction.centerTopMeters.x,
					y = surfaceTopMeters - junction.thicknessMeters - groundingDepthMeters / 2,
					z = junction.centerTopMeters.z,
				},
				junction.radiusMeters,
				groundingDepthMeters,
				junction.appearance,
				junction.hash
			)
			grounding:SetAttribute("BasaltRouteGrounding", true)
		end
		table.insert(observations, artifactObservation("route_junction", junction.junctionId, junction.hash))
	end
	TerrainLowering.verify()
	pendingStage = "foundation"
	return { instances = {}, artifacts = observations }
end

local function compactFailure(value: any): string
	local message = tostring(value):gsub("[\r\n]+", " ")
	local marker = string.find(message, "Basalt connector: ", 1, true)
	if marker ~= nil then message = string.sub(message, marker + #"Basalt connector: ") end
	return if #message > 240 then string.sub(message, 1, 237) .. "..." else message
end

local function loadAssetModel(entry: any): Model
	if typeof(entry.robloxAssetId) ~= "number" then fail("instance has no admitted Roblox asset id") end
	local ok, container = pcall(function()
		return InsertService:LoadAsset(entry.robloxAssetId)
	end)
	if not ok or container == nil or not container:IsA("Model") then
		fail("Roblox asset " .. tostring(entry.robloxAssetId) .. " could not be loaded")
	end
	local wrapper = container :: Model
	local unwrapOk, unwrapped = pcall(function()
		return LoadedAsset.unwrap(wrapper)
	end)
	if not unwrapOk or unwrapped == nil or not unwrapped:IsA("Model") then
		wrapper:Destroy()
		fail(
			"Roblox asset "
				.. tostring(entry.robloxAssetId)
				.. " has an invalid loaded package: "
				.. compactFailure(unwrapped)
		)
	end
	return unwrapped :: Model
end

local function destroyAssetTemplates(templates: { [string]: Model }): ()
	for _, template in pairs(templates) do template:Destroy() end
end

local function prepareAssetTemplates(entries: { any }): { [string]: Model }
	local representatives: { [string]: any } = {}
	local assetOrder = {}
	for _, entry in ipairs(entries) do
		local assetHash = requireHash(entry.assetHash, "instance.assetHash")
		local representative = representatives[assetHash]
		if representative == nil then
			representatives[assetHash] = entry
			table.insert(assetOrder, assetHash)
		elseif representative.robloxAssetId ~= entry.robloxAssetId then
			fail("one catalog asset resolves to multiple Roblox asset ids")
		end
	end

	local templates: { [string]: Model } = {}
	local diagnostics = {}
	-- Validate every distinct binding before lowering any instance. One broken
	-- package therefore reports alongside its peers and cannot leave a partial
	-- layer or force the creator through asset-by-asset retries.
	for _, assetHash in ipairs(assetOrder) do
		local entry = representatives[assetHash]
		local loaded: Model? = nil
		local loadOk, loadFailure = pcall(function()
			loaded = loadAssetModel(entry)
			verifyMaterialExpectations(loaded :: Model, entry.materialExpectations)
		end)
		if loadOk and loaded ~= nil then
			templates[assetHash] = loaded
		else
			if loaded ~= nil then loaded:Destroy() end
			table.insert(diagnostics, string.format(
				"%s (Roblox %s): %s",
				string.sub(assetHash, 1, 12),
				tostring(entry.robloxAssetId),
				compactFailure(loadFailure)
			))
		end
	end
	if #diagnostics > 0 then
		destroyAssetTemplates(templates)
		fail("asset binding preflight failed: " .. table.concat(diagnostics, " | "))
	end
	return templates
end

local function lowerInstance(parent: Instance, entry: any, realizedHash: string, template: Model): any
	local clone = template:Clone()
	if clone == nil or not clone:IsA("Model") then fail("loaded package model could not be cloned") end
	local model = clone :: Model
	model.Name = entry.instanceId
	local initialPivot = model:GetPivot()
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
	local _, actualSize = ModelBounds.worldAabb(model)
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
	local initialOrientation = initialPivot - initialPivot.Position
	model:PivotTo(
		CFrame.new(meters(position.x), meters(position.y), meters(position.z))
			* quaternion(entry.transformMeters.rotation)
			* initialOrientation
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
	local rotatedCenter = ModelBounds.worldAabb(model)
	model:TranslateBy(expectedCenter - rotatedCenter)
	local settledCenter, settledSize = ModelBounds.worldAabb(model)
	if (settledCenter - expectedCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (settledSize - expectedSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
		model:Destroy()
		fail(string.format(
			"loaded asset bounds drifted for %s (Roblox %d): expected center %s size %s, observed center %s size %s",
			entry.instanceId,
			entry.robloxAssetId,
			formatVectorMeters(expectedCenter),
			formatVectorMeters(expectedSize),
			formatVectorMeters(settledCenter),
			formatVectorMeters(settledSize)
		))
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

local function observedBoundsMicrometers(center: Vector3, size: Vector3): any
	return {
		min = vectorMicrometers(center - size / 2),
		max = vectorMicrometers(center + size / 2),
	}
end

local function observeConstructedOpening(root: Instance, declaration: any): any
	local center, size = boundsCenterAndSize(declaration.clearanceBoundsMeters)
	local ignored = {}
	for _, panelId in ipairs(declaration.panelElementIds) do
		local panel = root:FindFirstChild("ConstructedElement_" .. panelId, true)
		if panel == nil or not panel:IsA("BasePart") then
			fail("constructed opening lost panel " .. panelId)
		end
		table.insert(ignored, panel)
	end
	local overlap = OverlapParams.new()
	overlap.FilterType = Enum.RaycastFilterType.Exclude
	overlap.FilterDescendantsInstances = ignored
	local blockerIds = {}
	for _, part in ipairs(Workspace:GetPartBoundsInBox(CFrame.new(center), size, overlap)) do
		if part:IsDescendantOf(root) then table.insert(blockerIds, part:GetFullName()) end
	end
	table.sort(blockerIds)
	return {
		openingId = declaration.openingId,
		clearanceBoundsMicrometers = observedBoundsMicrometers(center, size),
		blockingPartIds = blockerIds,
	}
end

local function structuralEvidenceFolder(root: Instance): Folder
	local existing = root:FindFirstChild("StructuralEvidence")
	if existing ~= nil then fail("structural evidence was already lowered") end
	local folder = Instance.new("Folder")
	folder.Name = "StructuralEvidence"
	folder.Parent = root
	return folder
end

local function constructedMaterial(name: any): Enum.Material
	if typeof(name) ~= "string" or #name == 0 then fail("constructed element has no material id") end
	local ok, value = pcall(function() return (Enum.Material :: any)[name] end)
	if not ok or value == nil then fail("constructed material has no exact Roblox binding: " .. tostring(name)) end
	return value
end

local function constructedGeometry(geometry: any): (Vector3, CFrame, Enum.PartType)
	if typeof(geometry) ~= "table" then fail("constructed element has no geometry") end
	local center = geometry.centerMeters
	if typeof(center) ~= "table" then fail("constructed element has no center") end
	local centerStuds = Vector3.new(
		meters(finite(center.x, "constructed x")),
		meters(finite(center.y, "constructed y")),
		meters(finite(center.z, "constructed z"))
	)
	if geometry.kind == "box" then
		local size = geometry.sizeMeters
		if typeof(size) ~= "table" then fail("constructed box has no size") end
		return Vector3.new(
			meters(finite(size.x, "constructed box width")),
			meters(finite(size.y, "constructed box height")),
			meters(finite(size.z, "constructed box depth"))
		), CFrame.new(centerStuds), Enum.PartType.Block
	elseif geometry.kind == "cylinder" then
		local diameter = meters(finite(geometry.radiusMeters, "constructed cylinder radius") * 2)
		return Vector3.new(
			meters(finite(geometry.heightMeters, "constructed cylinder height")),
			diameter,
			diameter
		), CFrame.new(centerStuds) * CFrame.Angles(0, 0, math.pi / 2), Enum.PartType.Cylinder
	end
	fail("constructed geometry has no Roblox lowering: " .. tostring(geometry.kind))
end

local function lowerConstructedStructures(root: Instance, structures: { any }, observations: { any }): ()
	local structuresRoot = Instance.new("Folder")
	structuresRoot.Name = "ConstructedStructures"
	structuresRoot.Parent = root
	for _, structure in ipairs(structures) do
		local folder = Instance.new("Folder")
		folder.Name = "ConstructedStructure_" .. structure.structureId
		folder:SetAttribute("BasaltArtifactHash", requireHash(structure.hash, "constructed structure hash"))
		folder:SetAttribute("BasaltProgramHash", requireHash(structure.constructionProgramHash, "construction program hash"))
		folder.Parent = structuresRoot
		for _, element in ipairs(structure.elements) do
			local geometry = element.geometry
			local part = Instance.new("Part")
			part.Name = "ConstructedElement_" .. element.elementId
			part.Anchored = true
			part.CanCollide = true
			part.Material = constructedMaterial(element.appearance.materialId)
			part.Color = routeColor(element.appearance)
			part.Size, part.CFrame, part.Shape = constructedGeometry(geometry)
			if part.Size.X <= 0 or part.Size.Y <= 0 or part.Size.Z <= 0 then
				part:Destroy()
				fail("constructed element is degenerate")
			end
			part:SetAttribute("BasaltArtifactHash", requireHash(element.hash, "constructed element hash"))
			part:SetAttribute("BasaltProgramHash", requireHash(element.constructionProgramHash, "constructed element program hash"))
			part:SetAttribute("BasaltStyleHash", requireHash(element.styleProfileHash, "constructed style hash"))
			part.Parent = folder
			table.insert(observations, artifactObservation("constructed_element", element.elementId, element.hash))
		end
		for _, opening in ipairs(structure.openings) do
			local record = Instance.new("Configuration")
			record.Name = "ConstructedOpening_" .. opening.openingId
			record:SetAttribute("BasaltArtifactHash", requireHash(opening.hash, "constructed opening hash"))
			record:SetAttribute("BasaltPanelCount", #opening.panelElementIds)
			record.Parent = folder
			for _, panelId in ipairs(opening.panelElementIds) do
				if folder:FindFirstChild("ConstructedElement_" .. panelId) == nil then
					fail("constructed opening panel is missing: " .. panelId)
				end
			end
			table.insert(observations, artifactObservation("constructed_opening", opening.openingId, opening.hash))
		end
		for _, portal in ipairs(structure.portals) do
			local record = Instance.new("Configuration")
			record.Name = "ConstructedPortal_" .. portal.portalId
			record:SetAttribute("BasaltArtifactHash", requireHash(portal.hash, "constructed portal hash"))
			record:SetAttribute("BasaltOpeningHash", requireHash(portal.openingHash, "constructed portal opening hash"))
			record.Parent = folder
			table.insert(observations, artifactObservation("constructed_portal", portal.portalId, portal.hash))
		end
		table.insert(observations, artifactObservation("constructed_structure", structure.structureId, structure.hash))
	end
end

local function lowerMeso(root: Instance, meso: any): { any }
	if typeof(meso) ~= "table" then fail("meso transaction has no structural payload") end
	pendingMeso = meso
	local evidence = structuralEvidenceFolder(root)
	local observations = {}
	lowerConstructedStructures(root, meso.constructedStructures, observations)
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
		local actualCenter, actualSize = ModelBounds.worldAabb(model)
		if (actualCenter - desiredCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (actualSize - desiredSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
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
			step.CanCollide = true
			step.Shape = Enum.PartType.Block
			step.Material = Enum.Material.Concrete
			step.Parent = folder
		end
		table.insert(observations, artifactObservation("procedural_stair", stair.stairId, stair.hash))
	end
	return observations
end

function WorldLowering.instances(transaction: any): any
	local expectedStage = if transaction.stage == "meso" then "foundation" else "meso"
	requireStage(expectedStage, transaction.stage)
	local root = requireStagingFolder(transaction.sessionHash)
	local layer = Instance.new("Folder")
	layer.Name = transaction.stage == "meso" and "Meso" or "Micro"
	layer.Parent = root
	local expected = {}
	for _, item in ipairs(transaction.expectedInstanceHashes) do expected[item.instanceId] = item.hash end
	for _, entry in ipairs(transaction.instances) do
		if expected[entry.instanceId] == nil then fail("instance has no expected realization hash") end
	end
	local templates = prepareAssetTemplates(transaction.instances)
	local observations = {}
	local loweringOk, loweringFailure = pcall(function()
		for _, entry in ipairs(transaction.instances) do
			local hash = expected[entry.instanceId]
			local template = templates[entry.assetHash]
			if hash == nil then fail("instance has no expected realization hash") end
			if template == nil then fail("instance has no prepared asset template") end
			table.insert(observations, lowerInstance(layer, entry, hash, template))
			pendingInstances[entry.instanceId] = entry
		end
	end)
	destroyAssetTemplates(templates)
	if not loweringOk then error(loweringFailure, 0) end
	local artifacts = if transaction.stage == "meso" then lowerMeso(root, transaction.meso) else {}
	pendingStage = transaction.stage
	return { instances = observations, artifacts = artifacts }
end

function WorldLowering.readback(transaction: any): any
	requireStage("micro", "readback")
	local root = requireStagingFolder(transaction.sessionHash)
	TerrainLowering.verify()
	local artifacts = {}
	if pendingFoundation ~= nil then
		local routeRoot = root:FindFirstChild("Routes")
		if routeRoot == nil or not routeRoot:IsA("Folder") or #routeRoot:GetChildren() ~= #pendingFoundation.routeConstructions then
			fail("route root contents drifted")
		end
		for _, field in ipairs(pendingFoundation.terrainFields) do
			table.insert(artifacts, artifactObservation("terrain_field", field.terrainPlanId, field.hash))
		end
		for _, routeConstruction in ipairs(pendingFoundation.routeConstructions) do
			verifyRouteConstruction(root, routeConstruction)
			local routes = root:FindFirstChild("Routes")
			if routes == nil or not routes:IsA("Folder") then fail("route root is missing") end
			local routeFolder = routes:FindFirstChild(routeConstruction.routeId)
			if routeFolder == nil or not routeFolder:IsA("Folder") then
				fail("route geometry is missing for " .. routeConstruction.routeId)
			end
			local stationAdjustments = pendingRouteStationAdjustments[routeConstruction.routeId]
			if stationAdjustments == nil then
				fail("route ancillary lowering evidence is missing for " .. routeConstruction.routeId)
			end
			verifyRouteAncillaries(routeFolder, routeConstruction, stationAdjustments)
			table.insert(artifacts, artifactObservation("route_construction", routeConstruction.routeId, routeConstruction.hash))
		end
		local junctionRoot = root:FindFirstChild("RouteJunctions")
		if junctionRoot == nil or not junctionRoot:IsA("Folder") or #junctionRoot:GetChildren() ~= #pendingFoundation.routeJunctions then
			fail("route junction root contents drifted")
		end
		local junctionGroundingRoot = root:FindFirstChild("RouteJunctionGrounding")
		if junctionGroundingRoot == nil or not junctionGroundingRoot:IsA("Folder") then
			fail("route junction grounding root is missing")
		end
		local expectedJunctionGroundings = 0
		for _, junction in ipairs(pendingFoundation.routeJunctions) do
			local resolution = pendingJunctionResolutions[junction.junctionId]
			if resolution ~= nil and (resolution.groundingDepthStuds or 0) > 0.001 then
				expectedJunctionGroundings += 1
			end
		end
		if #junctionGroundingRoot:GetChildren() ~= expectedJunctionGroundings then
			fail("route junction grounding count drifted")
		end
		for _, junction in ipairs(pendingFoundation.routeJunctions) do
			local resolution = pendingJunctionResolutions[junction.junctionId]
			if resolution == nil then fail("route junction lowering evidence is missing: " .. junction.junctionId) end
			local adjustmentMeters = resolution.adjustmentStuds * Constants.STUD_METERS
			local surfaceTopMeters = junction.centerTopMeters.y + adjustmentMeters
			verifyVerticalCylinder(
				junctionRoot,
				junction.junctionId,
				{ x = junction.centerTopMeters.x, y = surfaceTopMeters - junction.thicknessMeters / 2, z = junction.centerTopMeters.z },
				junction.radiusMeters,
				junction.thicknessMeters,
				junction.appearance,
				junction.hash
			)
			local junctionPart = junctionRoot:FindFirstChild(junction.junctionId)
			if junctionPart == nil or not junctionPart:IsA("BasePart") then fail("route junction is missing: " .. junction.junctionId) end
			local groundingPart: BasePart? = nil
			local groundingDepthMeters = resolution.groundingDepthStuds * Constants.STUD_METERS
			if resolution.groundingDepthStuds > 0.001 then
				verifyVerticalCylinder(
					junctionGroundingRoot,
					junction.junctionId,
					{
						x = junction.centerTopMeters.x,
						y = surfaceTopMeters - junction.thicknessMeters - groundingDepthMeters / 2,
						z = junction.centerTopMeters.z,
					},
					junction.radiusMeters,
					groundingDepthMeters,
					junction.appearance,
					junction.hash
				)
				local candidate = junctionGroundingRoot:FindFirstChild(junction.junctionId)
				if candidate == nil or not candidate:IsA("BasePart") then
					fail("route junction grounding is missing: " .. junction.junctionId)
				end
				if candidate:GetAttribute("BasaltRouteGrounding") ~= true then
					fail("route junction grounding identity drifted for " .. junction.junctionId)
				end
				groundingPart = candidate
			elseif junctionGroundingRoot:FindFirstChild(junction.junctionId) ~= nil then
				fail("route junction has unexpected grounding: " .. junction.junctionId)
			end
			verifyJunctionTerrainContact(junctionPart, groundingPart, junction, resolution)
			table.insert(artifacts, artifactObservation("route_junction", junction.junctionId, junction.hash))
		end
	end
	local observations = {}
	local constructedElements = {}
	local constructedOpenings = {}
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
		local actualCenter, actualSize = ModelBounds.worldAabb(model)
		if (actualCenter - expectedCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS or (actualSize - expectedSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
			fail(string.format(
				"realized instance bounds drifted for %s: expected center %s size %s, observed center %s size %s",
				expected.instanceId,
				formatVectorMeters(expectedCenter),
				formatVectorMeters(expectedSize),
				formatVectorMeters(actualCenter),
				formatVectorMeters(actualSize)
			))
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
			if expected.artifactKind == "terrain_field" or expected.artifactKind == "route_construction" or expected.artifactKind == "route_junction" then continue end
			local namePrefix = if expected.artifactKind == "assembly" then "Assembly_" elseif expected.artifactKind == "constructed_surface" then "Surface_" elseif expected.artifactKind == "portal" then "Portal_" elseif expected.artifactKind == "room" then "Room_" elseif expected.artifactKind == "constructed_structure" then "ConstructedStructure_" elseif expected.artifactKind == "constructed_element" then "ConstructedElement_" elseif expected.artifactKind == "constructed_opening" then "ConstructedOpening_" elseif expected.artifactKind == "constructed_portal" then "ConstructedPortal_" else ""
			local record = if expected.artifactKind == "procedural_stair" then root:FindFirstChild(expected.artifactId, true) else root:FindFirstChild(namePrefix .. expected.artifactId, true)
			if record == nil or record:GetAttribute("BasaltArtifactHash") ~= expected.realizedHash then
				fail(expected.artifactKind .. " readback drifted for " .. expected.artifactId)
			end
			if expected.artifactKind == "constructed_element" then
				if not record:IsA("Part") then fail("constructed element is no longer native geometry") end
				local declaration = nil
				for _, structure in ipairs(pendingMeso.constructedStructures) do
					for _, element in ipairs(structure.elements) do
						if element.elementId == expected.artifactId then declaration = element break end
					end
					if declaration ~= nil then break end
				end
				if declaration == nil then fail("constructed element declaration is missing") end
				local expectedCenter, expectedSize = boundsCenterAndSize(declaration.boundsMeters)
				local _, expectedFrame, expectedShape = constructedGeometry(declaration.geometry)
				local actualCenter = record.Position
				local actualSize = record.Size
				if declaration.geometry.kind == "cylinder" then
					actualSize = Vector3.new(record.Size.Y, record.Size.X, record.Size.Z)
				end
				if record.Shape ~= expectedShape
					or record.CFrame.RightVector:Dot(expectedFrame.RightVector) < 0.99999
					or record.CFrame.UpVector:Dot(expectedFrame.UpVector) < 0.99999
					or record.CFrame.LookVector:Dot(expectedFrame.LookVector) < 0.99999
					or (actualCenter - expectedCenter).Magnitude > Constants.BOUND_TOLERANCE_STUDS
					or (actualSize - expectedSize).Magnitude > Constants.BOUND_TOLERANCE_STUDS then
					fail("constructed element geometry drifted for " .. expected.artifactId)
				end
				if record.Material ~= constructedMaterial(declaration.appearance.materialId) then
					fail("constructed element material drifted for " .. expected.artifactId)
				end
				if not routeColorMatches(record, declaration.appearance) then
					fail("constructed element color drifted for " .. expected.artifactId)
				end
				table.insert(constructedElements, {
					elementId = declaration.elementId,
					geometryKind = declaration.geometry.kind,
					centerMicrometers = vectorMicrometers(actualCenter),
					sizeMicrometers = vectorMicrometers(actualSize),
					materialId = record.Material.Name,
					baseColorSrgb = {
						red = roundedChannel(record.Color.R),
						green = roundedChannel(record.Color.G),
						blue = roundedChannel(record.Color.B),
					},
					anchored = record.Anchored,
					canCollide = record.CanCollide,
				})
			elseif expected.artifactKind == "constructed_opening" then
				if not record:IsA("Configuration") then fail("constructed opening record is missing") end
				local declaration = nil
				for _, structure in ipairs(pendingMeso.constructedStructures) do
					for _, opening in ipairs(structure.openings) do
						if opening.openingId == expected.artifactId then declaration = opening break end
					end
					if declaration ~= nil then break end
				end
				if declaration == nil or record:GetAttribute("BasaltPanelCount") ~= #declaration.panelElementIds then fail("constructed opening panel binding drifted") end
				table.insert(constructedOpenings, observeConstructedOpening(root, declaration))
			elseif expected.artifactKind == "constructed_portal" then
				if not record:IsA("Configuration") then fail("constructed portal record is missing") end
				local declaration = nil
				for _, structure in ipairs(pendingMeso.constructedStructures) do
					for _, portal in ipairs(structure.portals) do
						if portal.portalId == expected.artifactId then declaration = portal break end
					end
					if declaration ~= nil then break end
				end
				if declaration == nil or record:GetAttribute("BasaltOpeningHash") ~= declaration.openingHash then fail("constructed portal opening binding drifted") end
			elseif expected.artifactKind == "portal" then
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
					if step == nil or not step:IsA("Part") then fail("procedural stair step is missing") end
					local center, size = boundsCenterAndSize(bounds)
					if step.Shape ~= Enum.PartType.Block
						or not step.Anchored
						or not step.CanCollide
						or step.Material ~= Enum.Material.Concrete
						or (step.Position - center).Magnitude > Constants.BOUND_TOLERANCE_STUDS
						or (step.Size - size).Magnitude > Constants.BOUND_TOLERANCE_STUDS
						or step.CFrame.RightVector:Dot(Vector3.xAxis) < 0.99999
						or step.CFrame.UpVector:Dot(Vector3.yAxis) < 0.99999
						or step.CFrame.LookVector:Dot(-Vector3.zAxis) < 0.99999 then
						fail("procedural stair geometry drifted for " .. expected.artifactId)
					end
				end
			end
			table.insert(artifacts, { artifactKind = expected.artifactKind, artifactId = expected.artifactId, realizedHash = expected.realizedHash })
		end
	end
	table.sort(constructedElements, function(left: any, right: any): boolean return left.elementId < right.elementId end)
	table.sort(constructedOpenings, function(left: any, right: any): boolean return left.openingId < right.openingId end)
	pendingStage = "readback"
	return {
		instances = observations,
		artifacts = artifacts,
		constructedElements = constructedElements,
		constructedOpenings = constructedOpenings,
	}
end

function WorldLowering.prepareCommit(transaction: any): ()
	requireStage("readback", "commit")
	if pendingCommit ~= nil then fail("a Basalt commit is already prepared") end
	local root = requireStagingFolder(transaction.sessionHash)
	local backup = Workspace:FindFirstChild(Constants.BACKUP_FOLDER)
	if backup ~= nil then fail("an unfinished Basalt commit backup is present") end
	local previous = Workspace:FindFirstChild(Constants.WORLD_FOLDER)
	if previous ~= nil and not isOwnedFolder(previous, "BasaltWorldBuildHash") then
		fail("Workspace." .. Constants.WORLD_FOLDER .. " is not an owned Basalt world")
	end
	pendingCommit = {
		staging = root,
		previous = previous,
		worldBuildHash = requireHash(transaction.worldBuildHash, "transaction.worldBuildHash"),
		observedWorldStateHash = requireHash(
			transaction.expectedObservedWorldStateHash,
			"transaction.expectedObservedWorldStateHash"
		),
	}
	if previous ~= nil then previous.Name = Constants.BACKUP_FOLDER end
	root.Name = Constants.WORLD_FOLDER
	root:SetAttribute("BasaltWorldBuildHash", transaction.worldBuildHash)
	root:SetAttribute("BasaltObservedWorldStateHash", transaction.expectedObservedWorldStateHash)
	TerrainLowering.verify()
	pendingStage = "prepared_commit"
end

function WorldLowering.finalizeCommit(transaction: any): ()
	requireStage("prepared_commit", "commit acknowledgement")
	local commit = pendingCommit
	if commit == nil then fail("no Basalt commit is prepared") end
	if commit.worldBuildHash ~= transaction.worldBuildHash
		or commit.observedWorldStateHash ~= transaction.expectedObservedWorldStateHash then
		fail("prepared commit does not match the acknowledged transaction")
	end
	local root = commit.staging
	if root.Parent ~= Workspace
		or root.Name ~= Constants.WORLD_FOLDER
		or root:GetAttribute("BasaltWorldBuildHash") ~= commit.worldBuildHash
		or root:GetAttribute("BasaltObservedWorldStateHash") ~= commit.observedWorldStateHash then
		fail("prepared Basalt world drifted before commit acknowledgement")
	end
	TerrainLowering.verify()
	TerrainLowering.commit()
	if commit.previous ~= nil then commit.previous:Destroy() end
	clearPendingState()
	local waypointOk, waypointProblem = pcall(function()
		ChangeHistoryService:SetWaypoint("Import Basalt world")
	end)
	if not waypointOk then warn("Basalt connector: imported world, but could not set undo waypoint: " .. tostring(waypointProblem)) end
end

function WorldLowering.takeTraceEvents(): { any }
	local events = pendingTraceEvents
	pendingTraceEvents = {}
	if pendingDroppedTraceEvents > 0 then
		table.insert(events, {
			kind = "trace_truncated",
			droppedEventCount = pendingDroppedTraceEvents,
		})
		pendingDroppedTraceEvents = 0
	end
	return events
end

function WorldLowering.rollback(): ()
	TerrainLowering.rollback()
	local commit = pendingCommit
	if commit ~= nil then
		if commit.staging.Parent ~= nil then commit.staging:Destroy() end
		if commit.previous ~= nil and commit.previous.Parent ~= nil then
			commit.previous.Name = Constants.WORLD_FOLDER
		end
	else
		local root = Workspace:FindFirstChild(Constants.STAGING_FOLDER)
		if root ~= nil and isOwnedFolder(root, "BasaltSessionHash") then root:Destroy() end
	end
	clearPendingState()
end

return WorldLowering
