--!strict
local Constants = require(script.Parent.Constants)
local Frames = require(script.Parent.Frames)
local SceneData = require(script.Parent.SceneData)

-- Road ribbon lowering. Each sealed segment carries left/right edge frames;
-- the adapter spans every consecutive frame pair with one thin anchored part
-- oriented to the ribbon normal. Roads are visual: they never collide.
local RoadLowering = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function studs(point: any): Vector3
	return Vector3.new(
		Frames.metersToStuds(point.x),
		Frames.metersToStuds(point.y),
		Frames.metersToStuds(point.z)
	)
end

local function spanQuad(folder: Instance, segmentId: string, left0: Vector3, right0: Vector3, left1: Vector3, right1: Vector3, up: Vector3, material: Enum.Material): ()
	local mid0 = (left0 + right0) / 2
	local mid1 = (left1 + right1) / 2
	local widthDir = (right0 + right1) / 2 - ((left0 + left1) / 2)
	local width = widthDir.Magnitude
	local length = (mid1 - mid0).Magnitude
	if width < 1e-6 or length < 1e-6 then
		fail("road segment " .. segmentId .. " carries a degenerate ribbon frame")
	end
	local axisUp = up.Unit
	local axisRight = (widthDir - axisUp * widthDir:Dot(axisUp))
	if axisRight.Magnitude < 1e-6 then
		fail("road segment " .. segmentId .. " has a ribbon normal parallel to its width")
	end
	axisRight = axisRight.Unit
	local center = (mid0 + mid1) / 2 + axisUp * Constants.ROAD_LIFT_STUDS
	local part = Instance.new("Part")
	part.Name = segmentId .. "__ribbon"
	part.Size = Vector3.new(width, Constants.ROAD_THICKNESS_STUDS, length)
	part.CFrame = CFrame.fromMatrix(center, axisRight, axisUp)
	part.Material = material
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.Parent = folder
end

function RoadLowering.lowerRoads(parent: Instance, transaction: any, scene: any): ()
	local stale = parent:FindFirstChild("roads")
	if stale ~= nil then stale:Destroy() end
	local folder = Instance.new("Folder")
	folder.Name = "roads"
	folder.Parent = parent
	for _, segmentId in ipairs(transaction.roadSegmentIds) do
		local resolved = scene.roadSegmentsById[segmentId]
		local segment = resolved.segment
		local material = SceneData.resolveEngineMaterial(
			scene,
			segment.materialId,
			"road segment " .. segmentId
		)
		local segmentFolder = Instance.new("Folder")
		segmentFolder.Name = segmentId
		segmentFolder:SetAttribute("BasaltRoadSegmentId", segmentId)
		segmentFolder:SetAttribute("BasaltRouteId", resolved.routeId)
		local vertices = segment.vertices
		if #vertices < 4 or #vertices % 2 ~= 0 then
			fail("road segment " .. segmentId .. " has malformed ribbon vertices")
		end
		for frame = 1, #vertices / 2 - 1 do
			local left0 = studs(vertices[frame * 2 - 1].position)
			local right0 = studs(vertices[frame * 2].position)
			local left1 = studs(vertices[frame * 2 + 1].position)
			local right1 = studs(vertices[frame * 2 + 2].position)
			local normal0 = studs(vertices[frame * 2 - 1].normal)
			local normal1 = studs(vertices[frame * 2 + 1].normal)
			spanQuad(segmentFolder, segmentId, left0, right0, left1, right1, (normal0 + normal1) / 2, material)
		end
		if #segmentFolder:GetChildren() == 0 then
			fail("road segment " .. segmentId .. " lowered no ribbon")
		end
		segmentFolder.Parent = folder
	end
end

return RoadLowering
