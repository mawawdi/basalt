--!strict

local RouteGeometry = {}

function RouteGeometry.profileMiterOffset(extensionMeters: number, gradeRatio: number): (number, number)
	if extensionMeters ~= extensionMeters or extensionMeters < 0 or extensionMeters == math.huge then
		error("profile miter extension must be finite and nonnegative")
	end
	if gradeRatio ~= gradeRatio or gradeRatio == math.huge or gradeRatio == -math.huge then
		error("profile grade ratio must be finite")
	end
	local normalization = math.sqrt(1 + gradeRatio * gradeRatio)
	return extensionMeters / normalization, extensionMeters * gradeRatio / normalization
end

return RouteGeometry
