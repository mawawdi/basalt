--!strict
-- Shared sealed-quad lowering. Spans two edge pairs with one thin anchored
-- visual part oriented to the given normal. Roads and skirts share this math;
-- only the lift and thickness differ per use.
local Parts = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

function Parts.spanQuad(
	folder: Instance,
	name: string,
	context: string,
	edge0Left: Vector3,
	edge0Right: Vector3,
	edge1Left: Vector3,
	edge1Right: Vector3,
	up: Vector3,
	material: Enum.Material,
	liftStuds: number,
	thicknessStuds: number
): ()
	local mid0 = (edge0Left + edge0Right) / 2
	local mid1 = (edge1Left + edge1Right) / 2
	local widthDir = (edge0Right + edge1Right) / 2 - ((edge0Left + edge1Left) / 2)
	local width = widthDir.Magnitude
	local length = (mid1 - mid0).Magnitude
	if width < 1e-6 or length < 1e-6 then
		fail(context .. " carries a degenerate sealed quad")
	end
	local axisUp = up.Unit
	local axisRight = (widthDir - axisUp * widthDir:Dot(axisUp))
	if axisRight.Magnitude < 1e-6 then
		fail(context .. " has a sealed normal parallel to its width")
	end
	axisRight = axisRight.Unit
	local center = (mid0 + mid1) / 2 + axisUp * liftStuds
	local part = Instance.new("Part")
	part.Name = name
	part.Size = Vector3.new(width, thicknessStuds, length)
	part.CFrame = CFrame.fromMatrix(center, axisRight, axisUp)
	part.Material = material
	part.Color = Color3.new(1, 1, 1)
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.Parent = folder
end

return Parts
