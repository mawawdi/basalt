--!strict
-- Smooth-terrain occupancy is quantized by Roblox. A solid material has no
-- observable meaning when both the written and read occupancy are within one
-- engine quantization step of empty.
local TerrainReadback = {}

TerrainReadback.OCCUPANCY_TOLERANCE = 1 / 255 + 0.000001

function TerrainReadback.occupancyMatches(expected: number, observed: number): boolean
	return math.abs(observed - expected) <= TerrainReadback.OCCUPANCY_TOLERANCE
end

function TerrainReadback.materialMatches(
	expectedMaterial: any,
	observedMaterial: any,
	expectedOccupancy: number,
	observedOccupancy: number
): boolean
	if math.max(expectedOccupancy, observedOccupancy) <= TerrainReadback.OCCUPANCY_TOLERANCE then
		return true
	end
	return observedMaterial == expectedMaterial
end

return TerrainReadback
