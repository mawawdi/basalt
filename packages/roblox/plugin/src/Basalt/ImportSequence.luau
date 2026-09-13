--!strict
local ImportSequence = {}

export type Outcome = {
	kind: "complete" | "stopped" | "idle" | "incomplete",
	steps: number,
	status: any,
}

-- Drain a bounded bridge queue in order. Each sync step remains atomic from
-- Roblox's perspective; stopping is observed only between those safe points.
function ImportSequence.run(
	syncStep: (beforeStep: (transaction: any) -> ()) -> any,
	beforeStep: (transaction: any) -> (),
	afterStep: (status: any, steps: number) -> (),
	shouldStop: () -> boolean,
	maxSteps: number
): Outcome
	if maxSteps < 1 or maxSteps % 1 ~= 0 then
		error("Basalt import sequence: maxSteps must be a positive integer")
	end
	local lastStatus: any = nil
	local steps = 0
	while steps < maxSteps do
		if shouldStop() then
			return { kind = "stopped", steps = steps, status = lastStatus }
		end
		local status = syncStep(beforeStep)
		if status == nil then return { kind = "idle", steps = steps, status = lastStatus } end
		if typeof(status) ~= "table" or typeof(status.state) ~= "string" then
			error("Basalt import sequence: bridge returned an invalid status")
		end
		steps += 1
		lastStatus = status
		afterStep(status, steps)
		if status.state == "complete" then
			return { kind = "complete", steps = steps, status = status }
		end
		if status.state == "incomplete" then
			return { kind = "incomplete", steps = steps, status = status }
		end
		if status.state == "idle" then
			return { kind = "idle", steps = steps, status = status }
		end
		if status.state ~= "pending" then
			error("Basalt import sequence: bridge returned an unknown state")
		end
	end
	error("Basalt import sequence exceeded its bounded step budget")
end

return ImportSequence
