--!strict
-- Roblox-specific lowering for the engine-neutral height fields. The generic
-- compiler speaks meters; this adapter resamples onto Roblox's fixed four-stud
-- (1.12 meter) voxel grid. Original channels are retained until commit so any
-- failed or cancelled import restores the creator's terrain exactly.
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)

local TerrainLowering = {}
local CELL_STUDS = 4
local CELL_METERS = CELL_STUDS * Constants.STUD_METERS
-- SolidOccupancy is sampled on Roblox's smooth-terrain voxel field. Basalt's
-- elevations describe the geometric surface, so convert from surface space to
-- sample space before calculating the fractional boundary voxel.
local SURFACE_SAMPLE_OFFSET_METERS = CELL_METERS / 2
local CHANNELS = { "SolidMaterial", "SolidOccupancy", "LiquidOccupancy" }
local OCCUPANCY_TOLERANCE = 1 / 255 + 0.000001
local pending: { any } = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function finite(value: any, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		fail(label .. " must be finite")
	end
	return value
end

local function material(name: any): Enum.Material
	if typeof(name) ~= "string" or #name == 0 then fail("terrain sample lacks a material id") end
	local ok, resolved = pcall(function() return (Enum.Material :: any)[name] end)
	if not ok or resolved == nil then fail("terrain material has no exact Roblox binding: " .. tostring(name)) end
	return resolved
end

local function coordinateKey(x: number, z: number): string
	return string.format("%.17g:%.17g", x, z)
end

local function uniqueCoordinates(samples: { any }, field: string): { number }
	local seen: { [string]: boolean } = {}
	local result: { number } = {}
	for _, sample in ipairs(samples) do
		local value = finite(sample[field], "terrain sample " .. field)
		local key = string.format("%.17g", value)
		if not seen[key] then
			seen[key] = true
			table.insert(result, value)
		end
	end
	table.sort(result)
	return result
end

local function nearestIndex(values: { number }, target: number): number
	local best = 1
	local distance = math.huge
	for index, value in ipairs(values) do
		local candidate = math.abs(value - target)
		if candidate < distance then
			best = index
			distance = candidate
		end
	end
	return best
end

local function enclosingIndices(values: { number }, target: number): (number, number, number)
	if target <= values[1] then return 1, 1, 0 end
	if target >= values[#values] then return #values, #values, 0 end
	for upper = 2, #values do
		if target <= values[upper] then
			local lower = upper - 1
			local span = values[upper] - values[lower]
			return lower, upper, if span == 0 then 0 else (target - values[lower]) / span
		end
	end
	fail("terrain interpolation lookup failed")
end

local function sampleElevation(samples: { [string]: any }, xs: { number }, zs: { number }, x: number, z: number): number
	local x0, x1, tx = enclosingIndices(xs, x)
	local z0, z1, tz = enclosingIndices(zs, z)
	local q00 = samples[coordinateKey(xs[x0], zs[z0])]
	local q10 = samples[coordinateKey(xs[x1], zs[z0])]
	local q01 = samples[coordinateKey(xs[x0], zs[z1])]
	local q11 = samples[coordinateKey(xs[x1], zs[z1])]
	if q00 == nil or q10 == nil or q01 == nil or q11 == nil then fail("terrain interpolation sample is missing") end
	local bottom = q00.elevationMeters + (q10.elevationMeters - q00.elevationMeters) * tx
	local top = q01.elevationMeters + (q11.elevationMeters - q01.elevationMeters) * tx
	return bottom + (top - bottom) * tz
end

local function nearestRoutePoint(profile: any, x: number, z: number): any
	local best = nil
	for index = 2, #profile do
		local start = profile[index - 1].centerTopMeters
		local finish = profile[index].centerTopMeters
		local dx, dz = finish.x - start.x, finish.z - start.z
		local lengthSquared = dx * dx + dz * dz
		local amount = if lengthSquared <= 0.000000000000000001 then 0 else math.clamp(((x - start.x) * dx + (z - start.z) * dz) / lengthSquared, 0, 1)
		local centerX, centerZ = start.x + dx * amount, start.z + dz * amount
		local offsetX, offsetZ = x - centerX, z - centerZ
		local distanceSquared = offsetX * offsetX + offsetZ * offsetZ
		if best == nil or distanceSquared < best.distanceSquared then
			local length = math.sqrt(lengthSquared)
			best = {
				distanceSquared = distanceSquared,
				absoluteLateralMeters = math.sqrt(distanceSquared),
				signedLateralMeters = if length <= 0.000000001 then math.sqrt(distanceSquared) else offsetX * (-dz / length) + offsetZ * (dx / length),
				centerTopMeters = {
					x = centerX,
					y = start.y + (finish.y - start.y) * amount,
					z = centerZ,
				},
			}
		end
	end
	if best == nil then fail("route terrain treatment has no profile") end
	return best
end

local function smoothstep(value: number): number
	local bounded = math.clamp(value, 0, 1)
	return bounded * bounded * (3 - 2 * bounded)
end

local function triangleElevation(first: any, second: any, third: any, x: number, z: number): number?
	local denominator = (second.z - third.z) * (first.x - third.x) + (third.x - second.x) * (first.z - third.z)
	if math.abs(denominator) <= 0.000000000001 then return nil end
	local firstWeight = ((second.z - third.z) * (x - third.x) + (third.x - second.x) * (z - third.z)) / denominator
	local secondWeight = ((third.z - first.z) * (x - third.x) + (first.x - third.x) * (z - third.z)) / denominator
	local thirdWeight = 1 - firstWeight - secondWeight
	if firstWeight < -0.000000001 or secondWeight < -0.000000001 or thirdWeight < -0.000000001 then return nil end
	return first.y * firstWeight + second.y * secondWeight + third.y * thirdWeight
end

local function routeSurfaceTop(route: any, x: number, z: number): number?
	local lowest: number? = nil
	for _, segment in ipairs(route.travelSegments) do
		local bounds = segment.boundsMeters
		if x >= bounds.min.x - 0.000000001 and x <= bounds.max.x + 0.000000001
			and z >= bounds.min.z - 0.000000001 and z <= bounds.max.z + 0.000000001 then
			local first = segment.vertices[1].positionMeters
			local second = segment.vertices[2].positionMeters
			local third = segment.vertices[3].positionMeters
			local fourth = segment.vertices[4].positionMeters
			local firstElevation = triangleElevation(first, second, third, x, z)
			local secondElevation = triangleElevation(third, second, fourth, x, z)
			if firstElevation ~= nil and (lowest == nil or firstElevation < lowest) then lowest = firstElevation end
			if secondElevation ~= nil and (lowest == nil or secondElevation < lowest) then lowest = secondElevation end
		end
	end
	return lowest
end

local function applyRouteTreatments(elevation: number, baseMaterial: Enum.Material, composite: any, routeByHash: any, junctionByHash: any, x: number, z: number): (number, Enum.Material)
	local result = elevation
	local materialResult = baseMaterial
	local coordinatedTravelBed: number? = nil
	local coordinatedTravelMaterial: Enum.Material? = nil
	for _, routeHash in ipairs(composite.routeConstructionHashes) do
		local route = routeByHash[routeHash]
		if route == nil or route.status ~= "eligible" or route.terrainTreatment.kind ~= "grade" then
			fail("terrain field references an unavailable route treatment")
		end
		local surfaceTop = routeSurfaceTop(route, x, z)
		if surfaceTop ~= nil then
			local bed = surfaceTop - route.terrainTreatment.surfaceRevealMeters
			coordinatedTravelBed = if coordinatedTravelBed == nil then bed else math.min(coordinatedTravelBed, bed)
			coordinatedTravelMaterial = material(route.terrainTreatment.terrainMaterialId)
		end
	end
	for _, routeHash in ipairs(composite.routeConstructionHashes) do
		local route = routeByHash[routeHash]
		if route == nil or route.status ~= "eligible" or route.terrainTreatment.kind ~= "grade" then
			fail("terrain field references an unavailable route treatment")
		end
		local treatment = route.terrainTreatment
		local nearest = nearestRoutePoint(route.profile, x, z)
		local surfaceTop = routeSurfaceTop(route, x, z)
		local fullRadius = treatment.coreHalfWidthMeters + treatment.shoulderWidthMeters
		local maximumRadius = fullRadius + treatment.blendWidthMeters
		if surfaceTop ~= nil or nearest.absoluteLateralMeters <= maximumRadius + 0.000000001 then
			local targetTop = if surfaceTop ~= nil then surfaceTop else nearest.centerTopMeters.y + nearest.signedLateralMeters * treatment.crossfallRatio
			local target = targetTop - treatment.surfaceRevealMeters
			local influence = if surfaceTop ~= nil or nearest.absoluteLateralMeters <= fullRadius or treatment.blendWidthMeters == 0
				then 1
				else smoothstep(1 - (nearest.absoluteLateralMeters - fullRadius) / treatment.blendWidthMeters)
			result += (target - result) * influence
			if route.materialMask ~= nil and nearest.absoluteLateralMeters <= route.materialMask.halfWidthMeters then
				materialResult = material(route.materialMask.terrainMaterialId)
			end
		end
	end
	if coordinatedTravelBed ~= nil then
		result = coordinatedTravelBed
		materialResult = coordinatedTravelMaterial :: Enum.Material
	end
	for _, junctionHash in ipairs(composite.routeJunctionHashes) do
		local junction = junctionByHash[junctionHash]
		if junction == nil or junction.terrainTreatment.kind ~= "grade" then
			fail("terrain field references an unavailable route-junction treatment")
		end
		local treatment = junction.terrainTreatment
		local dx = x - junction.centerTopMeters.x
		local dz = z - junction.centerTopMeters.z
		local distance = math.sqrt(dx * dx + dz * dz)
		if distance <= junction.radiusMeters + 0.000000001 then
			local targetTop = junction.centerTopMeters.y
			for _, participant in ipairs(junction.participants) do
				for _, routeHash in ipairs(composite.routeConstructionHashes) do
					local route = routeByHash[routeHash]
					if route ~= nil and route.routeId == participant.routeId then
						local participantTop = routeSurfaceTop(route, x, z)
						if participantTop ~= nil then targetTop = math.min(targetTop, participantTop) end
					end
				end
			end
			local target = targetTop - treatment.surfaceRevealMeters
			if coordinatedTravelBed ~= nil then target = math.min(target, coordinatedTravelBed) end
			result = target
			materialResult = material(treatment.terrainMaterialId)
		end
	end
	return result, materialResult
end

local function grid(baseField: any, composite: any, routeByHash: any, junctionByHash: any, worldBounds: any): any
	if typeof(baseField.samples) ~= "table" or #baseField.samples < 4 then fail("base terrain field is empty") end
	if composite.baseTerrainFieldHash ~= baseField.hash then fail("terrain composition binds the wrong base field") end
	local xs = uniqueCoordinates(baseField.samples, "xMeters")
	local zs = uniqueCoordinates(baseField.samples, "zMeters")
	if #xs * #zs ~= #baseField.samples then fail("base terrain field must be a complete rectangular grid") end
	local samples: { [string]: any } = {}
	local maximumElevation = -math.huge
	for _, sample in ipairs(baseField.samples) do
		local key = coordinateKey(sample.xMeters, sample.zMeters)
		if samples[key] ~= nil then fail("terrain field repeats a sample coordinate") end
		samples[key] = sample
		maximumElevation = math.max(maximumElevation, finite(sample.elevationMeters, "terrain elevation"))
	end
	for _, routeHash in ipairs(composite.routeConstructionHashes) do
		local route = routeByHash[routeHash]
		if route == nil then fail("terrain composition references a missing route") end
		for _, station in ipairs(route.profile) do maximumElevation = math.max(maximumElevation, station.centerTopMeters.y) end
	end
	for _, junctionHash in ipairs(composite.routeJunctionHashes) do
		local junction = junctionByHash[junctionHash]
		if junction == nil then fail("terrain composition references a missing route junction") end
		maximumElevation = math.max(maximumElevation, junction.centerTopMeters.y)
	end
	local minimumX = math.floor(xs[1] / CELL_METERS) * CELL_METERS
	local maximumX = math.ceil(xs[#xs] / CELL_METERS) * CELL_METERS
	local minimumZ = math.floor(zs[1] / CELL_METERS) * CELL_METERS
	local maximumZ = math.ceil(zs[#zs] / CELL_METERS) * CELL_METERS
	local minimumY = math.floor(finite(worldBounds.min.y, "world minimum y") / CELL_METERS) * CELL_METERS
	local maximumY = math.ceil(maximumElevation / CELL_METERS) * CELL_METERS
	if maximumX <= minimumX then maximumX = minimumX + CELL_METERS end
	if maximumZ <= minimumZ then maximumZ = minimumZ + CELL_METERS end
	if maximumY <= minimumY then maximumY = minimumY + CELL_METERS end
	local nx = math.round((maximumX - minimumX) / CELL_METERS)
	local ny = math.round((maximumY - minimumY) / CELL_METERS)
	local nz = math.round((maximumZ - minimumZ) / CELL_METERS)
	if nx * ny * nz > Constants.MAX_TERRAIN_VOXELS then fail("terrain field exceeds the Roblox voxel budget") end
	local materials: { { { Enum.Material } } } = table.create(nx)
	local occupancy: { { { number } } } = table.create(nx)
	local liquid: { { { number } } } = table.create(nx)
	for ix = 1, nx do
		materials[ix] = table.create(ny)
		occupancy[ix] = table.create(ny)
		liquid[ix] = table.create(ny)
		local x = minimumX + (ix - 0.5) * CELL_METERS
		local columnElevations: { number } = table.create(nz)
		local columnMaterials: { Enum.Material } = table.create(nz)
		for iz = 1, nz do
			local z = minimumZ + (iz - 0.5) * CELL_METERS
			local sourceX = xs[nearestIndex(xs, x)]
			local sourceZ = zs[nearestIndex(zs, z)]
			local sample = samples[coordinateKey(sourceX, sourceZ)]
			if sample == nil then fail("terrain grid lookup failed") end
			columnElevations[iz], columnMaterials[iz] = applyRouteTreatments(
				sampleElevation(samples, xs, zs, x, z),
				material(sample.materialId),
				composite,
				routeByHash,
				junctionByHash,
				x,
				z
			)
		end
		for iy = 1, ny do
			materials[ix][iy] = table.create(nz)
			occupancy[ix][iy] = table.create(nz)
			liquid[ix][iy] = table.create(nz)
			local cellBottom = minimumY + (iy - 1) * CELL_METERS
			for iz = 1, nz do
				local sampleElevationMeters = columnElevations[iz] - SURFACE_SAMPLE_OFFSET_METERS
				local fill = math.clamp((sampleElevationMeters - cellBottom) / CELL_METERS, 0, 1)
				materials[ix][iy][iz] = if fill > 0 then columnMaterials[iz] else Enum.Material.Air
				occupancy[ix][iy][iz] = fill
				liquid[ix][iy][iz] = 0
			end
		end
	end
	local originStuds = Vector3.new(minimumX / Constants.STUD_METERS, minimumY / Constants.STUD_METERS, minimumZ / Constants.STUD_METERS)
	local region = Region3.new(originStuds, originStuds + Vector3.new(nx * CELL_STUDS, ny * CELL_STUDS, nz * CELL_STUDS))
	return {
		fieldHash = composite.hash,
		region = region,
		materials = materials,
		occupancy = occupancy,
		liquid = liquid,
		dimensions = { nx, ny, nz },
	}
end

local function writeChannels(terrain: Terrain, region: Region3, channels: any): ()
	local ok, problem = pcall(function()
		terrain:WriteVoxelChannels(region, CELL_STUDS, {
			SolidMaterial = channels.materials,
			SolidOccupancy = channels.occupancy,
			LiquidOccupancy = channels.liquid,
		})
	end)
	if not ok then fail("Terrain:WriteVoxelChannels failed: " .. tostring(problem)) end
end

function TerrainLowering.begin(baseFields: { any }, fields: { any }, routes: { any }, junctions: { any }, worldBounds: any): ()
	if #pending > 0 then fail("terrain transaction is already active") end
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain") end
	local baseByHash = {}
	for _, baseField in ipairs(baseFields) do baseByHash[baseField.hash] = baseField end
	local routeByHash = {}
	for _, route in ipairs(routes) do routeByHash[route.hash] = route end
	local junctionByHash = {}
	for _, junction in ipairs(junctions) do junctionByHash[junction.hash] = junction end
	for _, field in ipairs(fields) do
		local baseField = baseByHash[field.baseTerrainFieldHash]
		if baseField == nil then fail("terrain field has no exact base artifact") end
		local expected = grid(baseField, field, routeByHash, junctionByHash, worldBounds)
		local original = terrain:ReadVoxelChannels(expected.region, CELL_STUDS, CHANNELS)
		local record = {
			fieldHash = expected.fieldHash,
			region = expected.region,
			dimensions = expected.dimensions,
			expected = expected,
			original = {
				materials = original.SolidMaterial,
				occupancy = original.SolidOccupancy,
				liquid = original.LiquidOccupancy,
			},
		}
		table.insert(pending, record)
		writeChannels(terrain, expected.region, expected)
	end
end

function TerrainLowering.verify(): ()
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain") end
	for _, record in ipairs(pending) do
		local live = terrain:ReadVoxelChannels(record.region, CELL_STUDS, CHANNELS)
		local nx, ny, nz = record.dimensions[1], record.dimensions[2], record.dimensions[3]
		for ix = 1, nx do for iy = 1, ny do for iz = 1, nz do
			if live.SolidMaterial[ix][iy][iz] ~= record.expected.materials[ix][iy][iz] then
				fail("terrain material readback drifted for " .. record.fieldHash)
			end
			if math.abs(live.SolidOccupancy[ix][iy][iz] - record.expected.occupancy[ix][iy][iz]) > OCCUPANCY_TOLERANCE then
				fail("terrain occupancy readback drifted for " .. record.fieldHash)
			end
			if math.abs(live.LiquidOccupancy[ix][iy][iz] - record.expected.liquid[ix][iy][iz]) > OCCUPANCY_TOLERANCE then
				fail("terrain liquid readback drifted for " .. record.fieldHash)
			end
		end end end
	end
end

function TerrainLowering.commit(): ()
	pending = {}
end

function TerrainLowering.rollback(): ()
	if #pending == 0 then return end
	local terrain = Workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then
		pending = {}
		return
	end
	for index = #pending, 1, -1 do
		local record = pending[index]
		writeChannels(terrain, record.region, record.original)
	end
	pending = {}
end

return TerrainLowering
