--!strict
local HttpService = game:GetService("HttpService")
local Constants = require(script.Parent.Constants)

local BridgeClient = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

function BridgeClient.getJson(path: string): any
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Constants.BRIDGE_URL .. path,
			Method = "GET",
			Headers = { ["Content-Type"] = "application/json" },
		})
	end)
	if not ok or response == nil or response.Success ~= true then
		fail("bridge request failed for " .. path)
	end
	local decodedOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk then fail("bridge returned invalid JSON for " .. path) end
	return decoded
end

function BridgeClient.postJson(path: string, payload: any): any
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Constants.BRIDGE_URL .. path,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode(payload),
		})
	end)
	if not ok or response == nil or response.Success ~= true then
		fail("bridge request failed for " .. path)
	end
	return HttpService:JSONDecode(response.Body)
end

-- Raw bytes for hash-addressed payloads. Luau strings are binary-safe, so
-- the body passes through untouched; callers verify length and decode it.
function BridgeClient.getBytes(path: string): string
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Constants.BRIDGE_URL .. path,
			Method = "GET",
		})
	end)
	if not ok or response == nil or response.Success ~= true then
		fail("bridge request failed for " .. path)
	end
	if typeof(response.Body) ~= "string" then fail("bridge returned no bytes for " .. path) end
	return response.Body
end

return BridgeClient
