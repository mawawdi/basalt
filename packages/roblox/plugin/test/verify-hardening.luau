--!strict
local ImportSequence = require("../src/Basalt/ImportSequence")
local BoundedQuery = require("../src/Basalt/BoundedQuery")
local Constants = require("../src/Basalt/Constants")
local LoadedAsset = require("../src/Basalt/LoadedAsset")
local AssetBindingCapture = require("../src/Basalt/AssetBindingCapture")
local ModelBounds = require("../src/Basalt/ModelBounds")
local RouteCoordination = require("../src/Basalt/RouteCoordination")
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

check("multipart oblique bounds match the compiler wind pump declaration", function()
	-- Measured canonical boxes, in meters, for the rotor, tail, and tower.
	local measured = {
		{ {-8173092026, 32881402759, 396250308}, {8004403021, 49093698077, 5480526521} },
		{ {-1542173440, 37958868992, -15252494336}, {1238420608, 43872575488, 396250304} },
		{ {-4509715456, -214748352, -4509715456}, {4509715456, 40016437248, 4509715456} },
	}
	local placement = Roblox.CFrame.new(85, 6.049999997019768, 66)
		* Roblox.CFrame.Angles(0, math.rad(20), 0)
	local boxes = {}
	for _, bounds in ipairs(measured) do
		local minimum = Roblox.Vector3.new(bounds[1][1], bounds[1][2], bounds[1][3]) / 4294967296
		local maximum = Roblox.Vector3.new(bounds[2][1], bounds[2][2], bounds[2][3]) / 4294967296
		table.insert(boxes, {
			cframe = placement * Roblox.CFrame.new((minimum + maximum) / 2),
			size = maximum - minimum,
		})
	end
	local center, size = ModelBounds.worldAabbForBoxes(boxes, function(x: number, y: number, z: number): any
		return Roblox.Vector3.new(x, y, z)
	end)
	assert((size - Roblox.Vector3.new(3.9443368086460993, 11.48051731963642, 5.285626651233812)).Magnitude < 0.0001)
	assert((center - Roblox.Vector3.new(85.21553833970582, 11.74025865981821, 65.2071128527154)).Magnitude < 0.0001)
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

check("asset observation preserves duplicate-name paths and exact texture properties", function()
	local model = Roblox.Instance.new("Model")
	local folder = Roblox.Instance.new("Folder")
	folder.Name = "Geometry"
	folder.Parent = model
	for index = 1, 2 do
		local part = Roblox.Instance.new("MeshPart")
		part.Name = "Mesh"
		part.Material = Roblox.Enum.Material.Plastic
		part.Color = Roblox.Color3.fromRGB(81, 121, 63)
		part.Transparency = 0.1
		part.Reflectance = 0
		part.TextureID = "rbxassetid://" .. tostring(index)
		part.Parent = folder
	end
	local captured = AssetBindingCapture.inspectModel(model)
	assert(#captured == 2)
	for index, item in ipairs(captured) do
		assert(#item.partPath == 2 and item.partPath[1].name == "Geometry")
		assert(item.partPath[2].name == "Mesh" and item.partPath[2].siblingOrdinal == index - 1)
		assert(item.meshTextureId == "rbxassetid://" .. tostring(index))
		assert(item.color.red == 81 and item.color.green == 121 and item.color.blue == 63)
	end
	local executable = Roblox.Instance.new("Script")
	executable.Parent = model
	local ok = pcall(function() AssetBindingCapture.inspectModel(model) end)
	assert(not ok)
	model:Destroy()
end)

check("static catalog placement anchors every part and readback rejects physics drift", function()
	local model = Roblox.Instance.new("Model")
	local nested = Roblox.Instance.new("Model")
	nested.Parent = model
	local first = Roblox.Instance.new("Part")
	first.Anchored = false
	first.CanCollide = false
	first.Parent = model
	local second = Roblox.Instance.new("MeshPart")
	second.Anchored = false
	second.CanCollide = true
	second.Parent = nested
	LoadedAsset.anchorGeometry(model)
	LoadedAsset.verifyAnchoredGeometry(model)
	assert(first.Anchored and second.Anchored)
	assert(not first.CanCollide and second.CanCollide)
	second.Anchored = false
	assert(not pcall(function() LoadedAsset.verifyAnchoredGeometry(model) end))
	model:Destroy()
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

check("grounding separates authored tolerance from Roblox voxel residuals", function()
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
		Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS,
		observationToleranceStuds
	))
	local depth = RouteGrounding.initialDepthStuds(bodyClearanceStuds, 1, 0.02)
	assert(depth > bodyClearanceStuds)

	-- A later real Studio readback exposed 0.1679m under an authored 0.12m
	-- route. That difference is voxel realization, so it receives the explicit
	-- half-voxel engine allowance while the authored budget remains unchanged.
	assert(Constants.TERRAIN_VOXEL_STUDS == 4)
	assert(Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS == 2)
	local reportedBodyGapStuds = 0.16793348312377931 / studMeters
	assert(RouteGrounding.withinTolerance(
		reportedBodyGapStuds,
		maximumGapStuds,
		Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS,
		observationToleranceStuds
	))
	local maximumPermitted = RouteGrounding.maximumPermittedGapStuds(
		maximumGapStuds,
		Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS,
		observationToleranceStuds
	)
	assert(math.abs(maximumPermitted * studMeters - 0.708) < 0.0000001)
	assert(not RouteGrounding.withinTolerance(
		maximumPermitted + 0.0001,
		maximumGapStuds,
		Constants.TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_STUDS,
		observationToleranceStuds
	))
end)

check("route junction coordination reaches a quantized monotone fixed point", function()
	local routes = { { routeId = "Slow" }, { routeId = "Floor" } }
	local junctions = {
		{
			junctionId = "Shared",
			participants = {
				{ routeId = "Slow", endpoint = "start" },
				{ routeId = "Floor", endpoint = "start" },
			},
		},
	}
	local result = RouteCoordination.resolve(
		routes,
		junctions,
		{ Shared = 0 },
		function(route: any, overrides: any): any
			local current = if overrides == nil then 0 else overrides.start
			local endpoint = if route.routeId == "Slow"
				then math.max(current, 0.01 + current * 0.25)
				else math.max(current, 0.005)
			return { stationAdjustments = { endpoint, 0 } }
		end,
		16,
		0.0001
	)
	assert(result.iterations > 4 and result.iterations <= 16)
	assert(result.junctionAdjustments.Shared >= 0.0133)
	assert(result.junctionAdjustments.Shared < 0.0135)
	assert(result.routeOverrides.Slow.start == result.junctionAdjustments.Shared)
	assert(result.routeOverrides.Floor.start == result.junctionAdjustments.Shared)
end)

check("route junction coordination propagates corrections across a route graph", function()
	local routes = { { routeId = "Source" }, { routeId = "Link" }, { routeId = "Sink" } }
	local junctions = {
		{
			junctionId = "Start",
			participants = {
				{ routeId = "Source", endpoint = "start" },
				{ routeId = "Link", endpoint = "start" },
			},
		},
		{
			junctionId = "Finish",
			participants = {
				{ routeId = "Link", endpoint = "end" },
				{ routeId = "Sink", endpoint = "start" },
			},
		},
	}
	local result = RouteCoordination.resolve(
		routes,
		junctions,
		{ Start = 0, Finish = 0 },
		function(route: any, overrides: any): any
			local start = if overrides == nil then 0 else overrides.start
			local finish = if overrides == nil then 0 else overrides.finish
			if route.routeId == "Source" then start = math.max(start, 0.02) end
			if route.routeId == "Link" then finish = math.max(finish, start) end
			return { stationAdjustments = { start, finish } }
		end,
		16,
		0.0001
	)
	assert(result.junctionAdjustments.Start == 0.02)
	assert(result.junctionAdjustments.Finish == 0.02)
	assert(result.routeOverrides.Link.start == 0.02)
	assert(result.routeOverrides.Link.finish == 0.02)
end)

check("route junction coordination retains a hard divergence bound", function()
	local ok, message = pcall(function()
		RouteCoordination.resolve(
			{ { routeId = "Diverging" } },
			{
				{
					junctionId = "Unstable",
					participants = { { routeId = "Diverging", endpoint = "start" } },
				},
			},
			{ Unstable = 0 },
			function(_route: any, overrides: any): any
				local current = if overrides == nil then 0 else overrides.start
				return { stationAdjustments = { current + 0.001, 0 } }
			end,
			4,
			0.0001
		)
	end)
	assert(not ok)
	assert(string.find(tostring(message), "after 4 monotone passes", 1, true) ~= nil)
end)

check("junction passes retain interior corrections instead of repeatedly lifting the endpoint", function()
	local calls = 0
	local result = RouteCoordination.resolve(
		{ { routeId = "InteriorDip" } },
		{ { junctionId = "Shared", participants = { { routeId = "InteriorDip", endpoint = "start" } } } },
		{ Shared = 0 },
		function(_route: any, overrides: any, previous: any): any
			calls += 1
			if previous then assert(table.isfrozen(previous)) end
			local seed = RouteGrounding.seedStations({ 0, 0, 0 }, previous, overrides, 2, "InteriorDip")
			-- The footprint bottleneck is at an interior station. Lifting both
			-- ends of that span is valid, but forgetting the interior lift on the
			-- next junction pass repeats the same correction forever.
			local stations = RouteGrounding.conformStations(seed,
				function(index: number, start: number, finish: number): number
					return if index == 1 then finish - 0.00005 else math.min(start, finish)
				end, 0, 2, 8, "InteriorDip")
			return { stationAdjustments = stations, acceptedCall = calls }
		end,
		16,
		0.0001
	)
	assert(result.iterations == 2)
	assert(result.junctionAdjustments.Shared == 0.0001)
	assert(result.routeResolutions.InteriorDip.stationAdjustments[2] == 0.00005)
	assert(result.routeResolutions.InteriorDip.acceptedCall == calls)
end)

check("carried route corrections and junction overrides retain the physical residual bound", function()
	local initial = { 0.1, 0.2, 0.3 }
	local previous = { 0.2, 0.4, 0.3 }
	local seed = RouteGrounding.seedStations(initial, previous, { start = 0.5, finish = 0.6 }, 2, "Bounded")
	assert(seed[1] == 0.5 and seed[2] == 0.4 and seed[3] == 0.6)
	assert(initial[1] == 0.1 and previous[2] == 0.4)
	for _, bad in ipairs({ 2.0001, math.huge, 0 / 0 }) do
		assert(not pcall(function()
			RouteGrounding.seedStations(initial, previous, { start = bad }, 2, "Bounded")
		end))
	end
	assert(not pcall(function()
		RouteGrounding.seedStations(initial, { 0, 2.0001, 0 }, nil, 2, "Bounded")
	end))
	assert(not pcall(function()
		RouteGrounding.conformStations({ 0, 0 }, function(): number return -3 end, 0, 2, 8, "Bounded")
	end))
	assert(not pcall(function()
		RouteGrounding.conformStations({ 0, 0 }, function(): number return 0 / 0 end, 0, 2, 8, "Bounded")
	end))
end)

check("route correction remains stable with float32 heights and a four-way junction", function()
	local routes = {}
	local participants = {}
	for index = 1, 4 do
		local id = "Branch" .. tostring(index)
		table.insert(routes, { routeId = id, terrainY = 32 + index * 0.02 })
		table.insert(participants, { routeId = id, endpoint = if index % 2 == 0 then "start" else "end" })
	end
	local target = 0.08 / Constants.STUD_METERS + Constants.TERRAIN_CONFORMANCE_MARGIN_STUDS
	local result = RouteCoordination.resolve(routes, { { junctionId = "Cross", participants = participants } },
		{ Cross = 0 },
		function(route: any, overrides: any, previous: any): any
			local seed = RouteGrounding.seedStations({ 0, 0, 0 }, previous, overrides, 2, route.routeId)
			local stations = RouteGrounding.conformStations(seed,
				function(_index: number, start: number, finish: number): number
					local first = Roblox.Vector3.new(200, 32 + start, 210).Y
					local last = Roblox.Vector3.new(200, 32 + finish, 212).Y
					return math.min(first, last) - route.terrainY
				end, target, 2, 8, route.routeId)
			return { stationAdjustments = stations }
		end, 16, 0.0001)
	assert(result.iterations <= 4)
	for index, route in ipairs(routes) do
		local stations = result.routeResolutions[route.routeId].stationAdjustments
		assert(stations[if index % 2 == 0 then 1 else #stations] == result.junctionAdjustments.Cross)
		for _, adjustment in ipairs(stations) do
			assert(Roblox.Vector3.new(0, 32 + adjustment, 0).Y - route.terrainY >= target - 0.00001)
		end
	end
end)

check("junction coordination rejects a solver that forgets a prior station correction", function()
	local calls = 0
	local ok, message = pcall(function()
		RouteCoordination.resolve({ { routeId = "Regressing" } },
			{ { junctionId = "Shared", participants = { { routeId = "Regressing", endpoint = "start" } } } },
			{ Shared = 0 }, function(_route: any, overrides: any): any
				calls += 1
				return { stationAdjustments = { if overrides then overrides.start else 0.01, if calls == 1 then 1 else 0, 0 } }
			end, 16, 0.0001)
	end)
	assert(not ok and string.find(tostring(message), "not monotone", 1, true) ~= nil)
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
