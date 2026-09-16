--!strict
-- Physical grounding policy for rigid Roblox route geometry. Surface reveal is
-- measured at the travel top; exposed space is measured beneath the authored
-- body. Keeping those quantities separate prevents a thick, grounded road from
-- being rejected merely because its top is far from smooth voxel terrain.
local RouteGrounding = {}

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
