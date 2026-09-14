--!strict
local BridgeClient = require(script.Parent.BridgeClient)
local Constants = require(script.Parent.Constants)
local ImportSequence = require(script.Parent.ImportSequence)
local PluginPanel = require(script.Parent.PluginPanel)
local TransactionBoundary = require(script.Parent.TransactionBoundary)
local WorldLowering = require(script.Parent.WorldLowering)

local ConnectorRuntime = {}

local function compact(value: any): string
	local message = tostring(value):gsub("[\r\n]+", " ")
	local marker = string.find(message, "Basalt connector: ", 1, true)
	if marker ~= nil then message = string.sub(message, marker + #"Basalt connector: ") end
	return if #message > 180 then string.sub(message, 1, 177) .. "..." else message
end

local function diagnostic(value: any): string
	local message = tostring(value):gsub("[\r\n]+", " ")
	local marker = string.find(message, "Basalt connector: ", 1, true)
	if marker ~= nil then message = string.sub(message, marker + #"Basalt connector: ") end
	return if #message > 1024 then string.sub(message, 1, 1021) .. "..." else message
end

local function readback(
	transaction: any,
	status: "complete" | "incomplete",
	observations: any,
	diagnostics: { string },
	traceEvents: { any }
): any
	return {
		kind = "RobloxReadback",
		sessionHash = transaction.sessionHash,
		worldBuildHash = transaction.worldBuildHash,
		transactionId = transaction.transactionId,
		status = status,
		instances = observations.instances or {},
		artifacts = observations.artifacts or {},
		constructedElements = observations.constructedElements or {},
		constructedOpenings = observations.constructedOpenings or {},
		traceEvents = traceEvents,
		diagnostics = diagnostics,
	}
end

local function applyTransaction(transaction: any, session: any, shouldCancel: () -> boolean): any
	local observations = { instances = {}, artifacts = {} }
	if transaction.stage == "preflight" then
		WorldLowering.preflight(transaction, session)
	elseif transaction.stage == "foundation" then
		observations = WorldLowering.foundation(transaction)
	elseif transaction.stage == "meso" or transaction.stage == "micro" then
		observations = WorldLowering.instances(transaction)
	elseif transaction.stage == "readback" then
		observations = WorldLowering.readback(transaction)
	elseif transaction.stage == "commit" then
		return TransactionBoundary.commit(
			function(): () WorldLowering.prepareCommit(transaction) end,
			function(): any
				return BridgeClient.postReadback(readback(
					transaction,
					"complete",
					observations,
					{},
					WorldLowering.takeTraceEvents()
				))
			end,
			function(): (boolean, any)
				local connected, status = BridgeClient.discover()
				local accepted = connected
					and typeof(status) == "table"
					and status.state == "complete"
					and status.sessionHash == transaction.sessionHash
					and status.worldBuildHash == transaction.worldBuildHash
				return accepted, status
			end,
			function(): ()
				if shouldCancel() then error("Basalt connector: import cancelled at the commit boundary") end
				WorldLowering.finalizeCommit(transaction)
			end
		)
	else
		error("Basalt connector: unsupported import stage")
	end
	return BridgeClient.postReadback(readback(
		transaction,
		"complete",
		observations,
		{},
		WorldLowering.takeTraceEvents()
	))
end

function ConnectorRuntime.start(pluginInstance: Plugin): ()
	BridgeClient.configure(pluginInstance)
	local toolbar = pluginInstance:CreateToolbar("Basalt")
	local panel = PluginPanel.create(pluginInstance)
	local panelButton = toolbar:CreateButton("Basalt", "Show Basalt world import", "")
	panelButton.Click:Connect(function()
		panel.widget.Enabled = not panel.widget.Enabled
	end)
	panel.widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		panelButton:SetActive(panel.widget.Enabled)
	end)

	local alive = true
	local importing = false
	local cancelRequested = false
	local restartRequired = false
	local session: any = nil

	local function progress(status: any): number
		if typeof(status) ~= "table" or typeof(status.progress) ~= "table" then return 0 end
		local total = status.progress.total
		local complete = status.progress.complete
		if typeof(total) ~= "number" or total <= 0 or typeof(complete) ~= "number" then return 0 end
		return math.clamp(complete / total, 0, 1)
	end

	local function renderDisconnected(): ()
		panel:setState({
			title = "Bridge offline",
			detail = "Run basalt roblox import. Connection is automatic.",
			tone = "neutral",
			progress = 0,
			primaryText = "Waiting for bridge",
			primaryEnabled = false,
			stopVisible = false,
		})
	end

	local function renderStatus(status: any): ()
		if typeof(status) ~= "table"
			or typeof(status.state) ~= "string"
			or typeof(status.worldBuildHash) ~= "string"
			or typeof(status.loweringGapCount) ~= "number"
		then
			session = nil
			renderDisconnected()
			return
		end
		session = status
		if not importing
			and status.state == "pending"
			and typeof(status.progress) == "table"
			and typeof(status.progress.complete) == "number"
			and status.progress.complete > 0 then
			restartRequired = true
		end
		if status.loweringGapCount > 0 then
			panel:setState({
				title = "Asset bindings required",
				detail = tostring(status.loweringGapCount) .. " assets are not admitted for Roblox import.",
				tone = "error",
				progress = 0,
				primaryText = "Import unavailable",
				primaryEnabled = false,
				stopVisible = false,
			})
		elseif status.state == "complete" then
			panel:setState({
				title = "Import complete",
				detail = "WorldBuild " .. string.sub(status.worldBuildHash, 1, 12) .. " was applied and read back.",
				tone = "success",
				progress = 1,
				primaryText = "Reimport",
				primaryEnabled = true,
				stopVisible = false,
			})
		elseif status.state == "incomplete" or restartRequired then
			panel:setState({
				title = "Import incomplete",
				detail = "Full diagnostics are in .basalt/roblox/import-report.json. Retry starts cleanly.",
				tone = "error",
				progress = progress(status),
				primaryText = "Retry",
				primaryEnabled = true,
				stopVisible = false,
			})
		else
			panel:setState({
				title = "Ready",
				detail = tostring(status.stage) .. " · " .. string.sub(status.worldBuildHash, 1, 12),
				tone = "active",
				progress = progress(status),
				primaryText = "Import",
				primaryEnabled = true,
				stopVisible = false,
			})
		end
	end

	local function runImport(): ()
		if importing or session == nil then return end
		importing = true
		cancelRequested = false
		task.spawn(function()
			local ok, outcome = pcall(function()
				if restartRequired or session.state == "complete" or session.state == "incomplete" then
					WorldLowering.rollback()
					session = BridgeClient.restart()
					restartRequired = false
				end
				return ImportSequence.run(
					function(beforeStep: (transaction: any) -> ()): any
						local next = BridgeClient.getNext()
						if next.transaction == nil then return next end
						beforeStep(next.transaction)
						local stepOk, result = pcall(function()
							return applyTransaction(next.transaction, session, function(): boolean
								return cancelRequested or not alive
							end)
						end)
						if not stepOk then
							local traceEvents = WorldLowering.takeTraceEvents()
							WorldLowering.rollback()
							restartRequired = true
							local reported = pcall(function()
								BridgeClient.postReadback(readback(next.transaction, "incomplete", {
									instances = {},
									artifacts = {},
									constructedElements = {},
									constructedOpenings = {},
								}, { diagnostic(result) }, traceEvents))
							end)
							if not reported then
								local connected = BridgeClient.discover()
								if connected then pcall(function() BridgeClient.cancel() end) end
							end
							error(result)
						end
						return result
					end,
					function(transaction: any): ()
						panel:setState({
							title = "Importing " .. transaction.stage,
							detail = "Stages run sequentially and are verified before advancing.",
							tone = "active",
							progress = progress(session),
							primaryText = "Importing…",
							primaryEnabled = false,
							stopVisible = true,
							stopText = if cancelRequested then "Cancelling…" else "Cancel",
							stopEnabled = not cancelRequested,
						})
					end,
					function(status: any, _steps: number): () session = status end,
					function(): boolean
						if not cancelRequested and alive then return false end
						restartRequired = true
						pcall(function() BridgeClient.cancel() end)
						WorldLowering.rollback()
						return true
					end,
					Constants.MAX_TRANSACTIONS
				)
			end)
			importing = false
			if not alive then return end
			if not ok then
				warn("Basalt connector: " .. compact(outcome) .. " (full report: .basalt/roblox/import-report.json)")
				local connected, status = BridgeClient.discover()
				if connected then renderStatus(status) else renderDisconnected() end
			elseif outcome.status ~= nil then
				renderStatus(outcome.status)
			else
				local connected, status = BridgeClient.discover()
				if connected then renderStatus(status) else renderDisconnected() end
			end
		end)
	end

	panel:onPrimary(runImport)
	panel:onStop(function()
		if not importing then return end
		cancelRequested = true
	end)
	renderDisconnected()

	task.spawn(function()
		while alive do
			if not importing then
				local connected, status = BridgeClient.discover()
				if connected then renderStatus(status) else renderDisconnected() end
			end
			task.wait(1)
		end
	end)
	pluginInstance.Unloading:Connect(function()
		alive = false
		cancelRequested = true
		WorldLowering.rollback()
	end)
end

return ConnectorRuntime
