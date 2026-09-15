--!strict
-- Model:GetBoundingBox() follows the model pivot orientation. Basalt world
-- bounds are axis-aligned, so derive them from every BasePart corner instead.
local ModelBounds = {}

export type Box = { cframe: CFrame, size: Vector3 }

function ModelBounds.worldAabbForBoxes(
	boxes: { Box },
	vectorFactory: ((number, number, number) -> Vector3)?
): (Vector3, Vector3)
	if #boxes == 0 then error("model bounds require at least one box") end
	local vector = vectorFactory or function(x: number, y: number, z: number): Vector3
		return Vector3.new(x, y, z)
	end
	local minimum = vector(math.huge, math.huge, math.huge)
	local maximum = vector(-math.huge, -math.huge, -math.huge)
	for _, box in ipairs(boxes) do
		local half = box.size / 2
		for _, x in ipairs({ -half.X, half.X }) do
			for _, y in ipairs({ -half.Y, half.Y }) do
				for _, z in ipairs({ -half.Z, half.Z }) do
					local point = box.cframe:PointToWorldSpace(vector(x, y, z))
					minimum = vector(
						math.min(minimum.X, point.X),
						math.min(minimum.Y, point.Y),
						math.min(minimum.Z, point.Z)
					)
					maximum = vector(
						math.max(maximum.X, point.X),
						math.max(maximum.Y, point.Y),
						math.max(maximum.Z, point.Z)
					)
				end
			end
		end
	end
	return (minimum + maximum) / 2, maximum - minimum
end

function ModelBounds.worldAabb(model: Model): (Vector3, Vector3)
	local boxes: { Box } = {}
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("BasePart") then
			table.insert(boxes, { cframe = descendant.CFrame, size = descendant.Size })
		end
	end
	return ModelBounds.worldAabbForBoxes(boxes)
end

return ModelBounds
