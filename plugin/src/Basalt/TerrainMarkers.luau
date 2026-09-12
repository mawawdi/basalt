--!strict
-- Pure terrain marker decisions. Markers carry the sealed voxel hash plus
-- the writer chunk and the written region, so rollback clears exactly what
-- was written without loading the scene, and any marker that cannot prove
-- itself is suspect and gets rewritten on the next apply. This module
-- touches no engine services, so Lune executes it directly.
local TerrainMarkers = {}

export type MarkerView = {
	name: string,
	voxelHash: string?,
	chunkId: string?,
	origin: { number }?,
	dimensions: { number }?,
}

export type ClearPlan = {
	clear: { { name: string, origin: { number }, dimensions: { number } } },
	drop: { string },
}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function hasRegion(marker: MarkerView): boolean
	local origin = marker.origin
	local dimensions = marker.dimensions
	if origin == nil or dimensions == nil then return false end
	if #origin ~= 3 or #dimensions ~= 3 then return false end
	for _, axis in ipairs(origin) do
		if typeof(axis) ~= "number" or axis % 1 ~= 0 then return false end
	end
	for _, axis in ipairs(dimensions) do
		if typeof(axis) ~= "number" or axis % 1 ~= 0 or axis < 1 then return false end
	end
	return true
end

-- A marker skips its surface only when it proves the sealed hash and a full
-- region. Anything else, including pre-verify markers that predate the
-- writer/region attributes, is suspect and forces a rewrite.
function TerrainMarkers.isSuspect(marker: MarkerView, sealedVoxelHash: string): (boolean, string?)
	if marker.voxelHash == nil then return true, "marker lacks its voxel hash" end
	if marker.voxelHash ~= sealedVoxelHash then return true, "marker binds another voxel hash" end
	if marker.chunkId == nil then return true, "marker lacks its writer chunk" end
	if not hasRegion(marker) then return true, "marker lacks its written region" end
	return false, nil
end

-- Rollback plan for one chunk folder's markers. Markers this chunk wrote
-- with a full region clear exactly that region; legacy markers without a
-- writer are dropped so the next apply rewrites them. A marker naming
-- another chunk under this chunk's folder is impossible and fails closed,
-- as does a writer match without a region, since blind clears are forbidden.
function TerrainMarkers.planClear(markers: { MarkerView }, chunkId: string, cellStuds: number): ClearPlan
	local plan: ClearPlan = { clear = {}, drop = {} }
	for _, marker in ipairs(markers) do
		if marker.chunkId ~= nil and marker.chunkId ~= chunkId then
			fail("chunk " .. chunkId .. " holds a marker for chunk " .. marker.chunkId)
		end
		if marker.chunkId == nil then
			table.insert(plan.drop, marker.name)
		elseif not hasRegion(marker) then
			fail("chunk " .. chunkId .. " marker " .. marker.name .. " lacks its written region")
		else
			local origin = marker.origin :: { number }
			local dimensions = marker.dimensions :: { number }
			for _, axis in ipairs(origin) do
				if axis % cellStuds ~= 0 then
					fail("chunk " .. chunkId .. " marker " .. marker.name .. " region is not cell-aligned")
				end
			end
			table.insert(plan.clear, { name = marker.name, origin = origin, dimensions = dimensions })
		end
	end
	return plan
end

return TerrainMarkers
