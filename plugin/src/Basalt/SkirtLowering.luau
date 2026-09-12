--!strict
local Constants = require(script.Parent.Constants)
local Frames = require(script.Parent.Frames)
local Parts = require(script.Parent.Parts)
local SceneData = require(script.Parent.SceneData)

-- Skirt lowering. Each sealed skirt hangs a four-face terrain-material curtain
-- from a flat instance's bottom edge past its deepest footprint sample, hiding
-- relief gaps under groundcover slabs. Skirts are visual: they never collide.
local SkirtLowering = {}

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

function SkirtLowering.lowerSkirts(parent: Instance, transaction: any, scene: any): ()
	local stale = parent:FindFirstChild("skirts")
	if stale ~= nil then
		stale:Destroy()
	end
	local folder = Instance.new("Folder")
	folder.Name = "skirts"
	folder.Parent = parent
	for _, instanceId in ipairs(transaction.instanceIds) do
		local skirt = scene.skirtsByInstanceId[instanceId]
		if skirt == nil then
			continue
		end
		local material = SceneData.resolveEngineMaterial(
			scene,
			skirt.materialId,
			"skirt " .. instanceId
		)
		if typeof(skirt.faces) ~= "table" or #skirt.faces ~= 4 then
			fail("skirt " .. instanceId .. " lacks four curtain faces")
		end
		local skirtFolder = Instance.new("Folder")
		skirtFolder.Name = instanceId
		skirtFolder:SetAttribute("BasaltSkirtInstanceId", instanceId)
		for index, face in ipairs(skirt.faces) do
			local topLeft = studs(face.topLeft)
			local topRight = studs(face.topRight)
			local bottomLeft = studs(face.bottomLeft)
			local bottomRight = studs(face.bottomRight)
			local edge = topRight - topLeft
			local normal = edge:Cross(Vector3.new(0, -1, 0))
			if normal.Magnitude < 1e-6 then
				fail("skirt " .. instanceId .. " carries a degenerate curtain face")
			end
			Parts.spanQuad(
				skirtFolder,
				instanceId .. "__skirt" .. index,
				"skirt " .. instanceId,
				topLeft,
				topRight,
				bottomLeft,
				bottomRight,
				normal,
				material,
				0,
				Constants.SKIRT_THICKNESS_STUDS
			)
		end
		if #skirtFolder:GetChildren() == 0 then
			fail("skirt " .. instanceId .. " lowered no curtain")
		end
		skirtFolder.Parent = folder
	end
end

return SkirtLowering
