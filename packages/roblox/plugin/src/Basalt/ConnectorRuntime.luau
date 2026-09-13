--!strict
local BridgeClient = require(script.Parent.BridgeClient)
local Constants = require(script.Parent.Constants)
local ImportSequence = require(script.Parent.ImportSequence)
local PluginPanel = require(script.Parent.PluginPanel)
local WorldLowering = require(script.Parent.WorldLowering)

local ConnectorRuntime = {}

local function compact(value: any): string
	local message = tostring(value):gsub("[\r\n]+", " ")
	local marker = string.find(message, "Basalt connector: ", 1, true)
	if marker ~= nil then message = string.sub(message, marker + #"Basalt connector: ") end
	return if #message > 180 then string.sub(message, 1, 177) .. "..." else message
end

local function readback(transaction: any, status: "complete" | "incomplete", observations: any, diagnostics: { string }): any
	return {
		kind = "RobloxReadback",
		sessionHash = transaction.sessionHash,
		worldBuildHash = transaction.worldBuildHash,
		transactionId = transaction.transactionId,
		status = status,
		instances = observations.instances or {},
		artifacts = observations.artifacts or {},
		diagnostics = diagnostics,
	}
end

local function applyTransaction(transaction: any, session: any): any
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
		WorldLowering.commit(transaction)
	else
		error("Basalt connector: unsupported import stage")
	end
	return BridgeClient.postReadback(readback(transaction, "complete", observations, {}))
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
		session = status
		if typeof(status) ~= "table" or typeof(status.state) ~= "string" then
			renderDisconnected()
			return
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
		elseif status.state == "incomplete" then
			panel:setState({
				title = "Import incomplete",
				detail = "The failed stage remains selected; retry after addressing the diagnostic.",
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
		if session.state == "complete" or session.state == "incomplete" then
			session = BridgeClient.restart()
			WorldLowering.rollback()
		end
		task.spawn(function()
			local ok, outcome = pcall(function()
				return ImportSequence.run(
					function(beforeStep: (transaction: any) -> ()): any
						local next = BridgeClient.getNext()
						if next.transaction == nil then return next end
						beforeStep(next.transaction)
						local stepOk, result = pcall(function()
							return applyTransaction(next.transaction, session)
						end)
						if not stepOk then
							WorldLowering.rollback()
							pcall(function()
								BridgeClient.postReadback(readback(next.transaction, "incomplete", { instances = {}, artifacts = {} }, { compact(result) }))
							end)
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
					function(): boolean return cancelRequested or not alive end,
					Constants.MAX_TRANSACTIONS
				)
			end)
			importing = false
			if not alive then return end
			if not ok then
				warn("Basalt connector: " .. compact(outcome))
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
		pcall(function() BridgeClient.cancel() end)
		WorldLowering.rollback()
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
