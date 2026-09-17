--!strict
-- Shared route endpoints and junction surfaces must receive one identical
-- Roblox terrain correction. Work in integer correction quanta so a monotone
-- fixed-point solve terminates exactly instead of comparing floating-point
-- adjustments against an arbitrary near-zero epsilon.
local RouteCoordination = {}

local function correctionTicks(value: any, quantumStuds: number, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		error(label .. " must be finite")
	end
	if value <= 0 then return 0 end
	-- Ignore only representation noise far below one quantum. Any physically
	-- meaningful increase advances to the next integer correction tick.
	return math.ceil(value / quantumStuds - 0.000000001)
end

local function studOverrides(ticks: any, quantumStuds: number): any
	if ticks == nil then return nil end
	return {
		start = (ticks.start or 0) * quantumStuds,
		finish = (ticks.finish or 0) * quantumStuds,
	}
end

local function studAdjustments(ticksByJunction: { [string]: number }, quantumStuds: number): { [string]: number }
	local result: { [string]: number } = {}
	for junctionId, ticks in pairs(ticksByJunction) do
		result[junctionId] = ticks * quantumStuds
	end
	return result
end

local function routeStudOverrides(ticksByRoute: { [string]: any }, quantumStuds: number): { [string]: any }
	local result: { [string]: any } = {}
	for routeId, ticks in pairs(ticksByRoute) do
		result[routeId] = studOverrides(ticks, quantumStuds)
	end
	return result
end

function RouteCoordination.resolve(
	routes: { any },
	junctions: { any },
	initialJunctionAdjustments: { [string]: number },
	resolveRoute: (any, any, any) -> any,
	maximumIterations: number,
	quantumStuds: number
): any
	assert(maximumIterations > 0 and maximumIterations % 1 == 0, "coordination iteration bound must be a positive integer")
	assert(quantumStuds > 0 and quantumStuds < math.huge, "coordination quantum must be finite and positive")

	local junctionTicks: { [string]: number } = {}
	for _, junction in ipairs(junctions) do
		local initial = initialJunctionAdjustments[junction.junctionId]
		if initial == nil then error("route junction has no initial terrain correction: " .. junction.junctionId) end
		junctionTicks[junction.junctionId] = correctionTicks(
			initial,
			quantumStuds,
			"route junction correction " .. junction.junctionId
		)
	end

	local overrideTicks: { [string]: any } = {}
	local previousStations: { [string]: { number } } = {}
	local lastChangedJunction = "none"
	local lastIncreaseTicks = 0
	for iteration = 1, maximumIterations do
		local resolutions: { [string]: any } = {}
		for _, route in ipairs(routes) do
			local previous = previousStations[route.routeId]
			local resolution = resolveRoute(
				route,
				studOverrides(overrideTicks[route.routeId], quantumStuds),
				if previous then table.freeze(table.clone(previous)) else nil
			)
			local stations = resolution.stationAdjustments
			if typeof(stations) ~= "table" or #stations < 2 or (previous and #previous ~= #stations) then
				error("route correction station count changed: " .. route.routeId)
			end
			for index, adjustment in ipairs(stations) do
				correctionTicks(adjustment, quantumStuds, "route station correction " .. route.routeId)
				if adjustment < 0 or (previous and adjustment < previous[index]) then
					error("route station correction is not monotone: " .. route.routeId)
				end
			end
			previousStations[route.routeId] = table.clone(stations)
			resolutions[route.routeId] = resolution
		end

		local changed = false
		lastIncreaseTicks = 0
		for _, junction in ipairs(junctions) do
			local currentTicks = junctionTicks[junction.junctionId] or 0
			local sharedTicks = currentTicks
			for _, participant in ipairs(junction.participants) do
				local resolution = resolutions[participant.routeId]
				if resolution == nil then
					error("route junction has no participant geometry: " .. participant.routeId)
				end
				local adjustments = resolution.stationAdjustments
				if typeof(adjustments) ~= "table" or #adjustments == 0 then
					error("route junction participant has no station adjustments: " .. participant.routeId)
				end
				if participant.endpoint ~= "start" and participant.endpoint ~= "end" then
					error("route junction participant has an invalid endpoint: " .. tostring(participant.endpoint))
				end
				local endpoint = if participant.endpoint == "start" then adjustments[1] else adjustments[#adjustments]
				sharedTicks = math.max(
					sharedTicks,
					correctionTicks(
						endpoint,
						quantumStuds,
						"route endpoint correction " .. participant.routeId
					)
				)
			end

			if sharedTicks > currentTicks then
				junctionTicks[junction.junctionId] = sharedTicks
				changed = true
				local increase = sharedTicks - currentTicks
				if increase > lastIncreaseTicks then
					lastIncreaseTicks = increase
					lastChangedJunction = junction.junctionId
				end
			end
			for _, participant in ipairs(junction.participants) do
				local routeTicks = overrideTicks[participant.routeId] or { start = 0, finish = 0 }
				local key = if participant.endpoint == "start" then "start" else "finish"
				local currentRouteTicks = routeTicks[key] or 0
				if sharedTicks > currentRouteTicks then
					routeTicks[key] = sharedTicks
					overrideTicks[participant.routeId] = routeTicks
					changed = true
				end
			end
		end

		if not changed then
			return {
				junctionAdjustments = studAdjustments(junctionTicks, quantumStuds),
				routeOverrides = routeStudOverrides(overrideTicks, quantumStuds),
				routeResolutions = resolutions,
				iterations = iteration,
			}
		end
	end

	error(string.format(
		"route junction residual coordination did not converge after %d monotone passes; %s still increased by %.9f studs",
		maximumIterations,
		lastChangedJunction,
		lastIncreaseTicks * quantumStuds
	))
end

return RouteCoordination
