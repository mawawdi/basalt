--!strict
-- One-time terrain appearance lowering. The neutral export carries water
-- color/transparency/reflectance/waves, grass enablement/length, and
-- material tints; this Roblox adapter converts meters to studs and applies
-- the engine properties. Engine bounds narrower than the neutral record
-- clamp with a printed note (the bay's open-water swell exceeds the
-- 1-stud wave cap); values the neutral schema already bounds fail closed
-- instead of drifting silently. A folder attribute gates re-application so
-- repeated applies stay idempotent; rollback leaves appearance in place
-- because it is global terrain state, not chunk voxels. Engine grass is the
-- one degradable step: builds lacking the Decoration/GrassLength members
-- skip it with a warning (meadows still paint Grass) and leave the gate
-- unset, so water and tints re-apply idempotently and a future engine
-- upgrade picks grass up on the next apply.
--
-- The module loads no engine services: `planAppearance` is pure and runs
-- under Lune in the plugin suite, while `lowerAppearance` binds the engine
-- at call time in Studio only.
local TerrainAppearance = {}

export type AppearanceRgb = { r: number, g: number, b: number }
export type AppearanceTint = { materialId: string, color: AppearanceRgb }
export type AppearancePlan = {
	water: {
		color: AppearanceRgb,
		transparency: number,
		reflectance: number,
		waveSizeStuds: number,
		waveSpeedPerMinute: number,
	}?,
	grass: { enabled: boolean, lengthStuds: number }?,
	tints: { AppearanceTint },
	clamped: { string },
}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireUnit(value: any, label: string): number
	if typeof(value) ~= "number" or value < 0 or value > 1 then
		fail(label .. " must be a number in [0, 1]")
	end
	return value
end

local function requireColor(value: any, label: string): AppearanceRgb
	if typeof(value) ~= "table" then fail(label .. " must be an rgb record") end
	return { r = requireUnit(value.r, label .. ".r"), g = requireUnit(value.g, label .. ".g"), b = requireUnit(value.b, label .. ".b") }
end

local function requireFinite(value: any, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		fail(label .. " must be a finite number")
	end
	return value
end

-- Pure plan step, executed under Lune in the plugin suite: validate the
-- neutral appearance record and convert it to engine values. Tints keep
-- their neutral material ids; the Studio path resolves them through the
-- material map at apply time.
function TerrainAppearance.planAppearance(appearance: any, studMeters: number): AppearancePlan
	if typeof(appearance) ~= "table" then fail("terrain appearance must be a record") end
	if typeof(studMeters) ~= "number" or studMeters <= 0 then fail("stud length must be positive") end
	local clamped: { string } = {}
	local plan: AppearancePlan = { water = nil, grass = nil, tints = {}, clamped = clamped }
	local water = appearance.water
	if water ~= nil then
		if typeof(water) ~= "table" then fail("terrain appearance water must be a record") end
		local waveSize = requireFinite(water.waveSizeMeters, "water waveSizeMeters")
		local waveSpeed = requireFinite(water.waveSpeedMeters, "water waveSpeedMeters")
		if waveSize < 0 or waveSpeed < 0 then fail("water waves must be non-negative") end
		local waveSizeStuds = waveSize / studMeters
		local waveSpeedPerMinute = waveSpeed / studMeters
		if waveSizeStuds > 1 then
			table.insert(clamped, string.format("wave size %.2f studs exceeds the 1-stud engine cap", waveSizeStuds))
			waveSizeStuds = 1
		end
		if waveSpeedPerMinute > 100 then
			table.insert(clamped, string.format("wave speed %.2f/min exceeds the 100/min engine cap", waveSpeedPerMinute))
			waveSpeedPerMinute = 100
		end
		plan.water = {
			color = requireColor(water.colorRgb, "water colorRgb"),
			transparency = requireUnit(water.transparency, "water transparency"),
			reflectance = requireUnit(water.reflectance, "water reflectance"),
			waveSizeStuds = waveSizeStuds,
			waveSpeedPerMinute = waveSpeedPerMinute,
		}
	end
	local grass = appearance.grass
	if grass ~= nil then
		if typeof(grass) ~= "table" then fail("terrain appearance grass must be a record") end
		if typeof(grass.enabled) ~= "boolean" then fail("grass enabled must be a boolean") end
		local lengthStuds = requireFinite(grass.lengthMeters, "grass lengthMeters") / studMeters
		if lengthStuds < 0.1 or lengthStuds > 1 then fail("grass length escapes the 0.1-1 stud engine range") end
		plan.grass = { enabled = grass.enabled, lengthStuds = lengthStuds }
	end
	local tints = appearance.materialTints
	if tints ~= nil then
		if typeof(tints) ~= "table" then fail("materialTints must be an array") end
		if #tints > 256 then fail("materialTints exceeds 256 entries") end
		for _, tint in ipairs(tints) do
			if typeof(tint) ~= "table" or typeof(tint.materialId) ~= "string" or #tint.materialId == 0 then
				fail("material tint lacks a materialId")
			end
			table.insert(plan.tints, {
				materialId = tint.materialId,
				color = requireColor(tint.colorRgb, "tint " .. tint.materialId),
			})
		end
	end
	return plan
end

-- Studio-only apply step: plan, bind engine materials, write properties.
function TerrainAppearance.lowerAppearance(parent: Instance, scene: any): ()
	local appearance = scene.terrainAppearance
	if appearance == nil then return end
	local folder = parent:FindFirstChild("terrain")
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = "terrain"
		folder.Parent = parent
	end
	local gate = game:GetService("HttpService"):JSONEncode(appearance)
	if folder:GetAttribute("BasaltAppearance") == gate then return end
	local terrain = workspace:FindFirstChildOfClass("Terrain")
	if terrain == nil then fail("place has no Terrain for appearance") end
	local Constants = require(script.Parent.Constants)
	local SceneData = require(script.Parent.SceneData)
	local plan = TerrainAppearance.planAppearance(appearance, Constants.STUD_METERS)
	if plan.water ~= nil then
		terrain.WaterColor = Color3.new(plan.water.color.r, plan.water.color.g, plan.water.color.b)
		terrain.WaterTransparency = plan.water.transparency
		terrain.WaterReflectance = plan.water.reflectance
		terrain.WaterWaveSize = plan.water.waveSizeStuds
		terrain.WaterWaveSpeed = plan.water.waveSpeedPerMinute
	end
	local grassSkipped = false
	if plan.grass ~= nil then
		local decorationSupported = pcall(function()
			return terrain.Decoration
		end)
		if not decorationSupported then
			print(
				"Basalt world connector: Terrain.Decoration is missing on this engine build; "
					.. "skipping engine grass (meadows still paint Grass)"
			)
			grassSkipped = true
		else
			terrain.Decoration = plan.grass.enabled
			local lengthSupported = pcall(function()
				return terrain.GrassLength
			end)
			if not lengthSupported then
				print(
					"Basalt world connector: Terrain.GrassLength is missing on this engine build; "
						.. "leaving the engine grass-length default"
				)
				grassSkipped = true
			else
				terrain.GrassLength = plan.grass.lengthStuds
			end
		end
	end
	for _, tint in ipairs(plan.tints) do
		local material = SceneData.resolveEngineMaterial(scene, tint.materialId, "tint " .. tint.materialId)
		local tintColor = Color3.new(tint.color.r, tint.color.g, tint.color.b)
		local ok, tintError = pcall(function()
			terrain:SetMaterialColor(material, tintColor)
		end)
		if not ok then fail("Terrain:SetMaterialColor failed for " .. material.Name .. ": " .. tostring(tintError)) end
	end
	for _, note in ipairs(plan.clamped) do
		print("Basalt world connector: " .. note .. "; clamped to the engine bound")
	end
	if not grassSkipped then
		folder:SetAttribute("BasaltAppearance", gate)
	end
end

return TerrainAppearance
