--!strict
local ImportSequence = require("../src/Basalt/ImportSequence")

local failures = 0
local function check(name: string, body: () -> ()): ()
	local ok, message = pcall(body)
	if ok then
		print("ok - " .. name)
	else
		failures += 1
		print("FAIL - " .. name .. ": " .. tostring(message))
	end
end

check("one action drains stages sequentially", function()
	local states = {
		{ state = "pending" },
		{ state = "pending" },
		{ state = "pending" },
		{ state = "complete" },
	}
	local calls = 0
	local observed = {}
	local outcome = ImportSequence.run(
		function(beforeStep: (transaction: any) -> ()): any
			calls += 1
			beforeStep({ stage = "stage_" .. tostring(calls) })
			return states[calls]
		end,
		function(transaction: any): () table.insert(observed, transaction.stage) end,
		function(_status: any, _steps: number): () end,
		function(): boolean return false end,
		8
	)
	assert(outcome.kind == "complete" and outcome.steps == 4)
	for index, stage in ipairs(observed) do
		assert(stage == "stage_" .. tostring(index), "stages changed order")
	end
end)

check("cancel is observed only between stages", function()
	local calls = 0
	local outcome = ImportSequence.run(
		function(beforeStep: (transaction: any) -> ()): any
			calls += 1
			beforeStep({ stage = "micro" })
			return { state = "pending" }
		end,
		function(_transaction: any): () end,
		function(_status: any, _steps: number): () end,
		function(): boolean return calls >= 2 end,
		8
	)
	assert(outcome.kind == "stopped" and outcome.steps == 2 and calls == 2)
end)

check("step budget is a hard bound", function()
	local ok, message = pcall(function()
		ImportSequence.run(
			function(_beforeStep: (transaction: any) -> ()): any return { state = "pending" } end,
			function(_transaction: any): () end,
			function(_status: any, _steps: number): () end,
			function(): boolean return false end,
			2
		)
	end)
	assert(not ok and string.find(tostring(message), "bounded step budget") ~= nil)
end)

if failures > 0 then error(failures .. " Lune checks failed") end
print("Lune connector checks passed")
