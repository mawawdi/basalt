--!strict
-- Pure readback spot math. `VoxelSpots.cells` must return the exact cell set
-- of the host `voxelSpotCells` rule for the same dimensions; the host
-- requires an exact match, so any drift between the two fails closed at
-- settle. This module touches no engine services, so Lune executes it
-- directly in the plugin test suite.
local VoxelSpots = {}

export type SpotCell = { x: number, y: number, z: number }
export type SpotReading = {
	x: number,
	y: number,
	z: number,
	occupancy: number,
	material: string,
}
export type SpotDrift = {
	x: number,
	y: number,
	z: number,
	field: string,
	expected: any,
	observed: any,
}

local SPOT_CAP = 32

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

function VoxelSpots.cells(nx: number, ny: number, nz: number): { SpotCell }
	if nx < 1 or ny < 1 or nz < 1 or nx % 1 ~= 0 or ny % 1 ~= 0 or nz % 1 ~= 0 then
		fail("spot cells need positive integer dimensions")
	end
	local total = nx * ny * nz
	local seen: { [number]: boolean } = {}
	local cells: { SpotCell } = {}
	local function push(x: number, y: number, z: number): ()
		local flat = x + nx * (z + nz * y)
		if seen[flat] then return end
		seen[flat] = true
		table.insert(cells, { x = x, y = y, z = z })
	end
	for _, x in ipairs({ 0, nx - 1 }) do
		for _, y in ipairs({ 0, ny - 1 }) do
			for _, z in ipairs({ 0, nz - 1 }) do
				push(x, y, z)
			end
		end
	end
	push(math.floor(nx / 2), math.floor(ny / 2), math.floor(nz / 2))
	local step = math.max(1, math.floor(total / (SPOT_CAP - 9)))
	for i = 0, SPOT_CAP - 10 do
		if #cells >= SPOT_CAP then break end
		local flat = (i * step) % total
		local x = flat % nx
		local rest = (flat - x) // nx
		local z = rest % nz
		push(x, (rest - z) // nz, z)
	end
	table.sort(cells, function(left: SpotCell, right: SpotCell): boolean
		if left.x ~= right.x then return left.x < right.x end
		if left.y ~= right.y then return left.y < right.y end
		return left.z < right.z
	end)
	return cells
end

-- First difference between sealed and observed spot readings, or nil when
-- the surface reads back clean. Occupancy compares within the engine
-- quantization tolerance; materials compare exactly.
function VoxelSpots.findDrift(
	expected: { SpotReading },
	observed: { SpotReading },
	tolerance: number
): SpotDrift?
	local seen: { [string]: SpotReading } = {}
	for _, reading in ipairs(observed) do
		seen[reading.x .. "," .. reading.y .. "," .. reading.z] = reading
	end
	for _, want in ipairs(expected) do
		local key = want.x .. "," .. want.y .. "," .. want.z
		local got = seen[key]
		seen[key] = nil
		if got == nil then
			return { x = want.x, y = want.y, z = want.z, field = "missing", expected = want, observed = nil }
		end
		if math.abs(got.occupancy - want.occupancy) > tolerance then
			return {
				x = want.x,
				y = want.y,
				z = want.z,
				field = "occupancy",
				expected = want.occupancy,
				observed = got.occupancy,
			}
		end
		if got.material ~= want.material then
			return {
				x = want.x,
				y = want.y,
				z = want.z,
				field = "material",
				expected = want.material,
				observed = got.material,
			}
		end
	end
	for _, extra in pairs(seen) do
		return {
			x = extra.x,
			y = extra.y,
			z = extra.z,
			field = "extra",
			expected = nil,
			observed = extra,
		}
	end
	return nil
end

return VoxelSpots
