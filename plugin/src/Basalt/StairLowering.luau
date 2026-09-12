--!strict
local Frames = require(script.Parent.Frames)
local SceneData = require(script.Parent.SceneData)

-- Stair run lowering. Each sealed run carries its base, yaw, and step
-- module; the adapter builds one solid anchored part per tread, sized
-- width x riser x tread along the run axis. Stairs collide: the avatar
-- climbs them. Step centers return to the readback in export meters;
-- the host replays them against the sealed run.
local StairLowering = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function runDirection(yawSteps: number): Vector3
	if yawSteps == 0 then
		return Vector3.new(0, 0, 1)
	elseif yawSteps == 1 then
		return Vector3.new(1, 0, 0)
	elseif yawSteps == 2 then
		return Vector3.new(0, 0, -1)
	elseif yawSteps == 3 then
		return Vector3.new(-1, 0, 0)
	else
		fail("stair run has an invalid yaw " .. tostring(yawSteps))
	end
end

function StairLowering.lowerStairs(parent: Instance, transaction: any, scene: any): { any }
	local stale = parent:FindFirstChild("stairs")
	if stale ~= nil then stale:Destroy() end
	local folder = Instance.new("Folder")
	folder.Name = "stairs"
	folder.Parent = parent
	local readings: { any } = {}
	for _, stairId in ipairs(transaction.stairIds) do
		local stair = scene.stairsById[stairId]
		if stair == nil then fail("scene export has no stair " .. stairId) end
		local material = SceneData.resolveEngineMaterial(scene, stair.materialId, "stair " .. stairId)
		local materialName = scene.materialById[stair.materialId]
		local stairFolder = Instance.new("Folder")
		stairFolder.Name = stairId
		stairFolder:SetAttribute("BasaltStairId", stairId)
		local base = stair.baseMeters
		local baseStuds = Vector3.new(
			Frames.metersToStuds(base.x),
			Frames.metersToStuds(base.y),
			Frames.metersToStuds(base.z)
		)
		local direction = runDirection(stair.yawStepsY90)
		local riser = Frames.metersToStuds(stair.riserMeters)
		local tread = Frames.metersToStuds(stair.treadMeters)
		local width = Frames.metersToStuds(stair.widthMeters)
		if riser <= 0 or tread <= 0 or width <= 0 then
			fail("stair " .. stairId .. " carries a degenerate step module")
		end
		local acrossX = direction.X == 0
		for step = 0, stair.steps - 1 do
			local center = baseStuds + direction * (tread * (step + 0.5)) + Vector3.new(0, riser * (step + 0.5), 0)
			local part = Instance.new("Part")
			part.Name = stairId .. "__step_" .. string.format("%02d", step)
			if acrossX then
				part.Size = Vector3.new(width, riser, tread)
			else
				part.Size = Vector3.new(tread, riser, width)
			end
			part.CFrame = CFrame.new(center)
			part.Material = material
			part.Color = Color3.new(1, 1, 1)
			part.Anchored = true
			part.CanCollide = true
			part:SetAttribute("BasaltStairId", stairId)
			part:SetAttribute("BasaltStepIndex", step)
			part.Parent = stairFolder
			table.insert(readings, {
				stairId = stairId,
				step = step,
				x = Frames.studsToMeters(center.X),
				y = Frames.studsToMeters(center.Y),
				z = Frames.studsToMeters(center.Z),
				material = materialName,
			})
		end
		if #stairFolder:GetChildren() == 0 then
			fail("stair " .. stairId .. " lowered no steps")
		end
		stairFolder.Parent = folder
	end
	return readings
end

return StairLowering
