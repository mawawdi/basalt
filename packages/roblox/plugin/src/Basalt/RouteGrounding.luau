--!strict
-- Physical grounding policy for rigid Roblox route geometry. Surface reveal is
-- measured at the travel top; exposed space is measured beneath the authored
-- body. Keeping those quantities separate prevents a thick, grounded road from
-- being rejected merely because its top is far from smooth voxel terrain.
local RouteGrounding = {}

local function requireFinite(value: number, label: string): number
	assert(typeof(value) == "number" and value == value and math.abs(value) < math.huge, label .. " must be finite")
	return value
end

-- Seed every station from the prior solve, not just its shared endpoints.
-- This state is private to the fixed connector and never edits the authored route.
function RouteGrounding.seedStations(
	initial: { number },
	previous: { number }?,
	overrides: any,
	maximumStuds: number,
	label: string
): { number }
	assert(#initial >= 2, label .. " must have at least two stations")
	assert(previous == nil or #previous == #initial, label .. " correction station count changed")
	assert(requireFinite(maximumStuds, "maximum correction") >= 0, "maximum correction must be nonnegative")
	local result = table.clone(initial)
	for index, value in ipairs(result) do
		local prior = if previous then requireFinite(previous[index], label .. " prior correction") else 0
		assert(prior >= 0, label .. " prior correction must be nonnegative")
		result[index] = math.max(0, requireFinite(value, label .. " initial correction"), prior)
	end
	if overrides then
		result[1] = math.max(result[1], requireFinite(overrides.start or 0, label .. " start correction"))
		result[#result] = math.max(result[#result], requireFinite(overrides.finish or 0, label .. " finish correction"))
	end
	for _, value in ipairs(result) do
		assert(value <= maximumStuds, label .. " exceeds the bounded Roblox residual correction")
	end
	return result
end

function RouteGrounding.conformStations(
	seed: { number },
	observeClearance: (number, number, number) -> number,
	targetStuds: number,
	maximumStuds: number,
	maximumIterations: number,
	label: string
): { number }
	local stations = RouteGrounding.seedStations(seed, nil, nil, maximumStuds, label)
	assert(requireFinite(targetStuds, "target clearance") >= 0, "target clearance must be nonnegative")
	assert(maximumIterations > 0 and maximumIterations % 1 == 0, "conformance iteration bound must be a positive integer")
	for _ = 1, maximumIterations do
		local changed = false
		for index = 1, #stations - 1 do
			local clearance = requireFinite(observeClearance(index, stations[index], stations[index + 1]), label .. " observed clearance")
			local deficit = targetStuds - clearance
			if deficit > 0.00001 then
				stations[index] += deficit
				stations[index + 1] += deficit
				assert(stations[index] <= maximumStuds and stations[index + 1] <= maximumStuds,
					label .. " cannot conform to Roblox terrain within the bounded residual at span " .. tostring(index))
				changed = true
			end
		end
		if not changed then return stations end
	end
	error(label .. " residual conformance did not converge")
end

function RouteGrounding.withinTolerance(
	maximumBodyClearanceStuds: number,
	authoredMaximumGapStuds: number,
	terrainQuantizationAllowanceStuds: number,
	observationToleranceStuds: number
): boolean
	return maximumBodyClearanceStuds <= RouteGrounding.maximumPermittedGapStuds(
		authoredMaximumGapStuds,
		terrainQuantizationAllowanceStuds,
		observationToleranceStuds
	)
end

function RouteGrounding.maximumPermittedGapStuds(
	authoredMaximumGapStuds: number,
	terrainQuantizationAllowanceStuds: number,
	observationToleranceStuds: number
): number
	assert(authoredMaximumGapStuds >= 0, "authored grounding tolerance must be nonnegative")
	assert(terrainQuantizationAllowanceStuds >= 0, "terrain quantization allowance must be nonnegative")
	assert(observationToleranceStuds >= 0, "terrain observation tolerance must be nonnegative")
	return authoredMaximumGapStuds
		+ terrainQuantizationAllowanceStuds
		+ observationToleranceStuds
end

function RouteGrounding.initialDepthStuds(
	maximumBodyClearanceStuds: number,
	verticalPerLocalStud: number,
	overlapStuds: number
): number
	if maximumBodyClearanceStuds <= 0 then return 0 end
	assert(verticalPerLocalStud > 0, "route grounding requires a positive vertical thickness axis")
	return (maximumBodyClearanceStuds + overlapStuds) / verticalPerLocalStud
end

return RouteGrounding
