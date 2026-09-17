--!strict
local HttpService = game:GetService("HttpService")
local EmbeddedConnection = require(script.Parent.EmbeddedConnection)
local Constants = require(script.Parent.Constants)

local BridgeClient = {}
local bridgeUrl: string? = nil
local bridgeToken: string? = nil

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requestAt(url: string, token: string?, path: string, method: string, body: string?): any
	local headers = { ["Content-Type"] = "application/json" }
	if token ~= nil then headers["Authorization"] = "Bearer " .. token end
	return HttpService:RequestAsync({
		Url = url .. path,
		Method = method,
		Headers = headers,
		Body = body,
	})
end

function BridgeClient.configure(pluginInstance: Plugin): ()
	local embeddedToken = EmbeddedConnection.token
	if typeof(embeddedToken) ~= "string" or string.match(embeddedToken, "^[a-f0-9]+$") == nil or #embeddedToken ~= 64 then
		fail("embedded bridge token is invalid; reinstall the plugin")
	end
	pluginInstance:SetSetting(Constants.CONNECTION_TOKEN_SETTING, embeddedToken)
	bridgeToken = embeddedToken
end

function BridgeClient.discover(): (boolean, any)
	if bridgeToken == nil then return false, nil end
	local minimumPort = EmbeddedConnection.minimumPort
	local maximumPort = EmbeddedConnection.maximumPort
	if typeof(minimumPort) ~= "number" or typeof(maximumPort) ~= "number" then return false, nil end
	for port = minimumPort, maximumPort do
		local candidate = "http://127.0.0.1:" .. tostring(port)
		local healthOk, health = pcall(function()
			return requestAt(candidate, nil, "/health", "GET", nil)
		end)
		if not healthOk or health.Success ~= true then continue end
		local sessionOk, sessionResponse = pcall(function()
			return requestAt(candidate, bridgeToken, "/session", "GET", nil)
		end)
		if sessionOk and sessionResponse.Success == true then
			local decodeOk, session = pcall(function()
				return HttpService:JSONDecode(sessionResponse.Body)
			end)
			if decodeOk and typeof(session) == "table" then
				bridgeUrl = candidate
				return true, session
			end
		end
	end
	bridgeUrl = nil
	return false, nil
end

local function request(path: string, method: string, body: string?): any
	if bridgeUrl == nil or bridgeToken == nil then fail("local bridge is not connected") end
	local ok, response = pcall(function()
		return requestAt(bridgeUrl :: string, bridgeToken, path, method, body)
	end)
	if not ok then
		bridgeUrl = nil
		fail("bridge request failed for " .. path .. ": " .. string.sub(tostring(response), 1, 512))
	end
	if response.Success ~= true then
		local detail = if typeof(response.Body) == "string" then response.Body else "no diagnostic"
		fail("bridge rejected " .. path .. " (HTTP " .. tostring(response.StatusCode) .. "): " .. string.sub(detail, 1, 512))
	end
	local decodeOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk then fail("bridge returned invalid JSON for " .. path) end
	return decoded
end

function BridgeClient.getNext(): any
	return request("/next", "GET", nil)
end

function BridgeClient.getBindingPacket(): any
	return request("/binding-packet", "GET", nil)
end

function BridgeClient.postBindingCapture(decision: any): any
	return request("/binding-capture", "POST", HttpService:JSONEncode(decision))
end

function BridgeClient.postReadback(readback: any): any
	return request("/readback", "POST", HttpService:JSONEncode(readback))
end

function BridgeClient.cancel(): any
	return request("/cancel", "POST", "{}")
end

function BridgeClient.restart(): any
	return request("/restart", "POST", "{}")
end

return BridgeClient
