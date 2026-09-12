--!strict
-- Pure repaint planning for material-only updates. Live voxels keep their
-- sealed payload while the adapter repaints one neutral material id to
-- another per surface; the plan filters the export record to one surface,
-- validates it, and seals a gate string the marker path compares so a stale
-- paint can never pass the skip check. Loads no engine services, so Lune
-- executes it directly in the plugin test suite.
local TerrainRepaints = {}

export type SurfaceRepaint = { sourceId: string, targetId: string }
export type RepaintPlan = { gate: string, substitutions: { SurfaceRepaint } }

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

function TerrainRepaints.planRepaints(repaints: any, surfaceId: string): RepaintPlan
	local empty: RepaintPlan = { gate = "", substitutions = {} }
	if repaints == nil then return empty end
	if typeof(repaints) ~= "table" then fail("terrain repaints must be an array") end
	local substitutions: { SurfaceRepaint } = {}
	for _, repaint in ipairs(repaints) do
		if typeof(repaint) ~= "table" then fail("terrain repaint must be a record") end
		if repaint.surfaceId == surfaceId then
			local source = repaint.sourceMaterialId
			local target = repaint.targetMaterialId
			if typeof(source) ~= "string" or #source == 0 then
				fail("terrain repaint lacks a sourceMaterialId")
			end
			if typeof(target) ~= "string" or #target == 0 then
				fail("terrain repaint lacks a targetMaterialId")
			end
			if source == target then fail("terrain repaint source and target must differ") end
			table.insert(substitutions, { sourceId = source, targetId = target })
		end
	end
	table.sort(substitutions, function(left: SurfaceRepaint, right: SurfaceRepaint): boolean
		if left.sourceId ~= right.sourceId then return left.sourceId < right.sourceId end
		return left.targetId < right.targetId
	end)
	local parts: { string } = {}
	for _, substitution in ipairs(substitutions) do
		table.insert(parts, substitution.sourceId .. ">" .. substitution.targetId .. ";")
	end
	return { gate = table.concat(parts), substitutions = substitutions }
end

return TerrainRepaints
