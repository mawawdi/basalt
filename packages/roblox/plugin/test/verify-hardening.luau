--!strict
local ImportSequence = require("../src/Basalt/ImportSequence")
local BoundedQuery = require("../src/Basalt/BoundedQuery")
local LoadedAsset = require("../src/Basalt/LoadedAsset")
local ModelBounds = require("../src/Basalt/ModelBounds")
local RouteGeometry = require("../src/Basalt/RouteGeometry")
local RouteGrounding = require("../src/Basalt/RouteGrounding")
local TerrainReadback = require("../src/Basalt/TerrainReadback")
local TransactionBoundary = require("../src/Basalt/TransactionBoundary")
local Roblox = require("@lune/roblox")

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

check("terrain collision readiness waits only for missing query results", function()
	local reads = 0
	local waits = 0
	local result = BoundedQuery.awaitResult(
		function(): any
			reads += 1
			return if reads == 3 then "ready" else nil
		end,
		function(): () waits += 1 end,
		4
	)
	assert(result == "ready" and reads == 3 and waits == 2)
end)

check("terrain collision readiness terminates at its frame bound", function()
	local reads = 0
	local waits = 0
	local result = BoundedQuery.awaitResult(
		function(): any
			reads += 1
			return nil
		end,
		function(): () waits += 1 end,
		4
	)
	assert(result == nil and reads == 5 and waits == 4)
end)

check("terrain readback ignores material labels only for quantized-empty voxels", function()
	local tiny = 0.0026877875767169646
	assert(TerrainReadback.occupancyMatches(tiny, 0))
	assert(TerrainReadback.materialMatches("Grass", "Air", tiny, 0))
	assert(not TerrainReadback.materialMatches("Grass", "Air", 0.01, 0.01))
	assert(TerrainReadback.materialMatches("Grass", "Grass", 0.01, 0.01))
	assert(not TerrainReadback.occupancyMatches(0.01, 0))
end)

check("model bounds are world-axis-aligned independently of the model pivot", function()
	local center, size = ModelBounds.worldAabbForBoxes({
		{
			cframe = Roblox.CFrame.new(3, 4, 5) * Roblox.CFrame.Angles(0, math.pi / 2, 0),
			size = Roblox.Vector3.new(2, 4, 6),
		},
	}, function(x: number, y: number, z: number): any
		return Roblox.Vector3.new(x, y, z)
	end)
	assert((center - Roblox.Vector3.new(3, 4, 5)).Magnitude < 0.000001)
	assert((size - Roblox.Vector3.new(6, 4, 2)).Magnitude < 0.000001)
end)

check("loaded model assets unwrap their transport container", function()
	local wrapper = Roblox.Instance.new("Model")
	local packageModel = Roblox.Instance.new("Model")
	packageModel.Name = "PublishedPackage"
	packageModel.Parent = wrapper
	local node = Roblox.Instance.new("Model")
	node.Name = "SM_Plant_Fern_01_Node"
	node.Parent = packageModel
	local part = Roblox.Instance.new("Part")
	part.Name = "SM_Plant_Fern_01"
	part.Parent = node
	local resolved = LoadedAsset.unwrap(wrapper)
	assert(resolved == packageModel)
	assert(resolved.Parent == nil)
	assert(resolved:FindFirstChild("SM_Plant_Fern_01_Node") == node)
end)

check("loaded model assets reject ambiguous package roots", function()
	local wrapper = Roblox.Instance.new("Model")
	for _ = 1, 2 do
		local packageModel = Roblox.Instance.new("Model")
		packageModel.Parent = wrapper
		local part = Roblox.Instance.new("Part")
		part.Parent = packageModel
	end
	local ok, message = pcall(function() LoadedAsset.unwrap(wrapper) end)
	assert(not ok)
	assert(string.find(tostring(message), "exactly one geometric package model", 1, true) ~= nil)
end)

check("loaded model assets reject geometry outside the package root", function()
	local wrapper = Roblox.Instance.new("Model")
	local packageModel = Roblox.Instance.new("Model")
	packageModel.Parent = wrapper
	local packagePart = Roblox.Instance.new("Part")
	packagePart.Parent = packageModel
	local strayPart = Roblox.Instance.new("Part")
	strayPart.Parent = wrapper
	local ok, message = pcall(function() LoadedAsset.unwrap(wrapper) end)
	assert(not ok)
	assert(string.find(tostring(message), "geometry outside", 1, true) ~= nil)
end)

check("skewed route quads lower through an orthonormal frame", function()
	-- Exact axes from the Studio segment that exposed the former raw-matrix
	-- lowering bug. Its cross-section is measurably non-perpendicular to travel.
	local travel = Roblox.Vector3.new(
		0.9691072910723079,
		-0.24216732206769034,
		0.04675517632366488
	)
	local rawLateral = Roblox.Vector3.new(
		-0.04817992765151553,
		-0.019996001199600166,
		0.9986385004131977
	)
	assert(math.abs(rawLateral:Dot(travel)) > 0.004)
	local lateral = (rawLateral - travel * rawLateral:Dot(travel)).Unit
	local up = lateral:Cross(travel).Unit
	local frame = Roblox.CFrame.fromMatrix(Roblox.Vector3.zero, lateral, up)
	local part = Roblox.Instance.new("Part")
	part.CFrame = frame
	assert(math.abs(lateral:Dot(travel)) < 0.000001)
	assert(math.abs(up:Dot(travel)) < 0.000001)
	assert(math.abs(up:Dot(lateral)) < 0.000001)
	assert(part.CFrame.RightVector:Dot(frame.RightVector) > 0.99999)
	assert(part.CFrame.UpVector:Dot(frame.UpVector) > 0.99999)
	assert(part.CFrame.LookVector:Dot(frame.LookVector) > 0.99999)
end)

check("grounding measures exposed space beneath the road body, not its travel top", function()
	-- Exact failure reported by Studio: the top was 0.2371m above terrain,
	-- but the 0.16m road body left only 0.0771m exposed underneath it.
	local studMeters = 0.28
	local topClearanceStuds = 0.2371 / studMeters
	local bodyClearanceStuds = topClearanceStuds - 0.16 / studMeters
	local maximumGapStuds = 0.12 / studMeters
	local observationToleranceStuds = 0.1
	assert(math.abs(bodyClearanceStuds * studMeters - 0.0771) < 0.0000001)
	assert(RouteGrounding.withinTolerance(
		bodyClearanceStuds,
		maximumGapStuds,
		observationToleranceStuds
	))
	local depth = RouteGrounding.initialDepthStuds(bodyClearanceStuds, 1, 0.02)
	assert(depth > bodyClearanceStuds)
end)

check("profile miters preserve their sealed sloped extension", function()
	local extensionMeters = 0.16 * math.tan(math.rad(1) / 2)
	local gradeRatio = 0.25
	local horizontalMeters, verticalMeters = RouteGeometry.profileMiterOffset(
		extensionMeters,
		gradeRatio
	)
	assert(math.abs(math.sqrt(horizontalMeters ^ 2 + verticalMeters ^ 2) - extensionMeters) < 1e-12)
	assert(math.abs(verticalMeters / horizontalMeters - gradeRatio) < 1e-12)
end)

check("commit finalizes only after bridge acknowledgement", function()
	local order = {}
	local outcome = TransactionBoundary.commit(
		function(): () table.insert(order, "prepare") end,
		function(): any
			table.insert(order, "acknowledge")
			return { state = "complete" }
		end,
		function(): (boolean, any)
			table.insert(order, "confirm")
			return false, nil
		end,
		function(): () table.insert(order, "finalize") end
	)
	assert(outcome.state == "complete")
	assert(table.concat(order, ",") == "prepare,acknowledge,finalize")
end)

check("commit remains reversible when acknowledgement is rejected", function()
	local finalized = false
	local ok, message = pcall(function()
		TransactionBoundary.commit(
			function(): () end,
			function(): any error("rejected") end,
			function(): (boolean, any) return false, nil end,
			function(): () finalized = true end
		)
	end)
	assert(not ok and string.find(tostring(message), "rejected") ~= nil)
	assert(not finalized)
end)

check("commit recovers a lost acknowledgement by exact discovery", function()
	local finalized = false
	local recovered = { state = "complete", recovered = true }
	local outcome = TransactionBoundary.commit(
		function(): () end,
		function(): any error("response lost") end,
		function(): (boolean, any) return true, recovered end,
		function(): () finalized = true end
	)
	assert(outcome == recovered and finalized)
end)

if failures > 0 then error(failures .. " Lune checks failed") end
print("Lune connector checks passed")
