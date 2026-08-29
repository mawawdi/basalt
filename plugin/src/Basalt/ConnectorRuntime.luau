--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)

local ConnectorRuntime = {}
local activeRecording: any = nil

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or string.match(value, "^[a-f0-9]+$") == nil or #value ~= 64 then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function requireId(value: any, label: string): string
	if typeof(value) ~= "string" or string.match(value, "^[A-Za-z][A-Za-z0-9_-]*$") == nil then
		fail(label .. " is invalid")
	end
	return value
end

local function beginRecording(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	if typeof(transaction) ~= "table" then fail("transaction must be a table") end
	requireHash(transaction.hash, "transaction.hash")
	requireHash(transaction.worldPlanHash, "transaction.worldPlanHash")
	requireHash(transaction.chunkHash, "transaction.chunkHash")
	requireId(transaction.chunkId, "transaction.chunkId")
	if typeof(transaction.instanceIds) ~= "table" then fail("transaction.instanceIds must be an array") end
	if #transaction.instanceIds > Constants.MAX_WORLD_INSTANCES_PER_CHUNK then
		fail("transaction.instanceIds exceeds its bound")
	end
	local seen = {}
	for _, instanceId in ipairs(transaction.instanceIds) do
		local id = requireId(instanceId, "transaction.instanceId")
		if seen[id] then fail("transaction.instanceIds must be unique") end
		seen[id] = true
	end
	if transaction.phase ~= "preflight" and transaction.phase ~= "apply" and transaction.phase ~= "commit" and transaction.phase ~= "rollback" then
		fail("transaction.phase is invalid")
	end
	activeRecording = { hash = transaction.hash, chunkId = transaction.chunkId }
	return activeRecording
end

local function readRevision(): string
	local value = Workspace:GetAttribute("BasaltWorldRevisionHash")
	if typeof(value) ~= "string" then return string.rep("0", 64) end
	return requireHash(value, "BasaltWorldRevisionHash")
end

local function request(method: string, path: string, payload: any?): any
	local options: any = {
		Url = Constants.BRIDGE_URL .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json" },
	}
	if payload ~= nil then options.Body = HttpService:JSONEncode(payload) end
	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)
	if not ok or response == nil or response.Success ~= true then
		fail("bridge request failed for " .. path)
	end
	return HttpService:JSONDecode(response.Body)
end

function ConnectorRuntime.detachedPreflight(transaction: any): any
	if transaction.phase ~= "preflight" then fail("detachedPreflight requires a preflight transaction") end
	local recording = beginRecording(transaction)
	activeRecording = nil
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "preflighted",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
	}
end

function ConnectorRuntime.applyChunk(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "apply" then fail("applyChunk requires an apply transaction") end
	local chunkId = requireId(transaction.chunkId, "transaction.chunkId")
	if chunkId ~= recording.chunkId then fail("transaction does not match its recording") end
	local folder = Workspace:FindFirstChild(chunkId)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = chunkId
		folder.Parent = Workspace
	end
	folder:SetAttribute("BasaltChunkHash", requireHash(transaction.chunkHash, "transaction.chunkHash"))
	folder:SetAttribute("BasaltWorldPlanHash", requireHash(transaction.worldPlanHash, "transaction.worldPlanHash"))
	ChangeHistoryService:SetWaypoint("Basalt apply " .. chunkId)
	activeRecording = nil
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "applied",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
	}
end

function ConnectorRuntime.commit(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "commit" then fail("commit requires a commit transaction") end
	ChangeHistoryService:SetWaypoint("Basalt commit " .. recording.chunkId)
	activeRecording = nil
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "committed",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
	}
end

function ConnectorRuntime.rollback(transaction: any): any
	if activeRecording ~= nil then fail("a world transaction is already open") end
	local recording = beginRecording(transaction)
	if transaction.phase ~= "rollback" then fail("rollback requires a rollback transaction") end
	ChangeHistoryService:SetWaypoint("Basalt rollback " .. recording.chunkId)
	activeRecording = nil
	return {
		kind = "BasaltWorldReadbackObservation",
		abi = Constants.WORLD_READBACK_ABI,
		transactionHash = recording.hash,
		chunkId = recording.chunkId,
		phase = "rolled_back",
		observedRevisionHash = readRevision(),
		observedInstanceIds = transaction.instanceIds,
	}
end

-- Apply one bounded transaction phase and let the host seal the observation.
function ConnectorRuntime.syncOnce(): any
	local transaction = request("GET", "/poll", nil)
	if transaction == nil then
		print("Basalt world connector: no pending chunk transaction")
		return nil
	end
	local observation
	if transaction.phase == "preflight" then
		observation = ConnectorRuntime.detachedPreflight(transaction)
	elseif transaction.phase == "apply" then
		observation = ConnectorRuntime.applyChunk(transaction)
	elseif transaction.phase == "commit" then
		observation = ConnectorRuntime.commit(transaction)
	elseif transaction.phase == "rollback" then
		observation = ConnectorRuntime.rollback(transaction)
	else
		fail("bridge returned an unsupported transaction phase")
	end
	local status = request("POST", "/settle", { transaction = transaction, readback = observation })
	print("Basalt world connector settled " .. transaction.chunkId .. " (" .. transaction.phase .. ")")
	return status
end

function ConnectorRuntime.start(pluginInstance: Plugin)
	local toolbar = pluginInstance:CreateToolbar("Basalt")
	local button = toolbar:CreateButton("BasaltWorld", "Sync one Basalt world transaction", "")
	button.Click:Connect(function()
		local ok, errorMessage = pcall(ConnectorRuntime.syncOnce)
		if not ok then warn("Basalt world connector: " .. tostring(errorMessage)) end
	end)
end

return ConnectorRuntime
