--!strict
local TransactionBoundary = {}

-- The local world swap remains reversible until the bridge has durably
-- accepted the commit readback. If the HTTP response is lost after acceptance,
-- authenticated discovery may confirm that exact session before finalization.
function TransactionBoundary.commit(
	prepare: () -> (),
	acknowledge: () -> any,
	confirmAccepted: () -> (boolean, any),
	finalize: () -> ()
): any
	prepare()
	local acknowledged, outcome = pcall(acknowledge)
	if not acknowledged then
		local confirmationCall, accepted, recovered = pcall(confirmAccepted)
		if not confirmationCall or not accepted then error(outcome, 0) end
		outcome = recovered
	end
	finalize()
	return outcome
end

return TransactionBoundary
