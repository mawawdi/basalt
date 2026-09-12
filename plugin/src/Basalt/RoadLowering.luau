--!strict
local Constants = require(script.Parent.Constants)
local Frames = require(script.Parent.Frames)
local Parts = require(script.Parent.Parts)
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
			Parts.spanQuad(
				segmentFolder,
				segmentId .. "__ribbon",
				"road segment " .. segmentId .. " ribbon",
				left0,
				right0,
				left1,
				right1,
				(normal0 + normal1) / 2,
				material,
				Constants.ROAD_LIFT_STUDS,
				Constants.ROAD_THICKNESS_STUDS
			)
		end
		if #segmentFolder:GetChildren() == 0 then
			fail("road segment " .. segmentId .. " lowered no ribbon")
		end
		segmentFolder.Parent = folder
	end
end

return RoadLowering
