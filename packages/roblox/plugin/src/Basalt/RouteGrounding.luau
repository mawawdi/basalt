--!strict
-- Physical grounding policy for rigid Roblox route geometry. Surface reveal is
-- measured at the travel top; exposed space is measured beneath the authored
-- body. Keeping those quantities separate prevents a thick, grounded road from
-- being rejected merely because its top is far from smooth voxel terrain.
local RouteGrounding = {}

function RouteGrounding.withinTolerance(
	maximumBodyClearanceStuds: number,
	maximumGapStuds: number,
	observationToleranceStuds: number
): boolean
	return maximumBodyClearanceStuds - observationToleranceStuds <= maximumGapStuds
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
