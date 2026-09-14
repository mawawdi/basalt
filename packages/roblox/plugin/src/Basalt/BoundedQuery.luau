--!strict
local BoundedQuery = {}

-- Retry a query only when its result is unavailable. The caller owns both the
-- query and the scheduler boundary, which keeps this policy deterministic in
-- tests and prevents it from silently becoming a wall-clock sleep.
function BoundedQuery.awaitResult(
	read: () -> any,
	waitForNextFrame: () -> (),
	maximumWaitFrames: number
): any
	if maximumWaitFrames < 0 or maximumWaitFrames % 1 ~= 0 then
		error("Basalt bounded query: maximumWaitFrames must be a non-negative integer")
	end
	for attempt = 0, maximumWaitFrames do
		local result = read()
		if result ~= nil then return result end
		if attempt < maximumWaitFrames then waitForNextFrame() end
	end
	return nil
end

return BoundedQuery
