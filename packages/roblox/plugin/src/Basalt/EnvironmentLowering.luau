--!strict
local Lighting = game:GetService("Lighting")

local EnvironmentLowering = {}

local MANAGED_ATTRIBUTE = "BasaltManagedVisualEnvironment"
local HASH_ATTRIBUTE = "BasaltVisualEnvironmentHash"
local ATMOSPHERE_NAME = "BasaltAtmosphere"
local COLOR_GRADE_NAME = "BasaltColorGrade"
local SUN_RAYS_NAME = "BasaltSunRays"
local EPSILON = 0.0001

local pending: any = nil

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local function requireHash(value: any, label: string): string
	if typeof(value) ~= "string" or #value ~= 64 or string.match(value, "^[a-f0-9]+$") == nil then
		fail(label .. " must be a sha256 hash")
	end
	return value
end

local function finite(value: any, label: string): number
	if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		fail(label .. " must be finite")
	end
	return value
end

local function color(value: any, label: string): Color3
	if typeof(value) ~= "table" then fail(label .. " must be an sRGB color") end
	local red = finite(value.red, label .. ".red")
	local green = finite(value.green, label .. ".green")
	local blue = finite(value.blue, label .. ".blue")
	for channelName, channel in pairs({ red = red, green = green, blue = blue }) do
		if channel % 1 ~= 0 or channel < 0 or channel > 255 then
			fail(label .. "." .. channelName .. " must be an integer from 0 to 255")
		end
	end
	return Color3.fromRGB(red, green, blue)
end

local function closeNumber(actual: number, expected: number): boolean
	return math.abs(actual - expected) <= EPSILON
end

local function closeColor(actual: Color3, expected: Color3): boolean
	return closeNumber(actual.R, expected.R)
		and closeNumber(actual.G, expected.G)
		and closeNumber(actual.B, expected.B)
end

local function captureEffects(classNames: { string }): ({ Instance }, { Instance })
	local originals = {}
	local clones = {}
	for _, child in ipairs(Lighting:GetChildren()) do
		local selected = false
		for _, className in ipairs(classNames) do
			if child:IsA(className) then selected = true break end
		end
		if selected then
			local wasArchivable = child.Archivable
			child.Archivable = true
			local clone = child:Clone()
			child.Archivable = wasArchivable
			clone.Archivable = wasArchivable
			clone.Parent = nil
			table.insert(originals, child)
			table.insert(clones, clone)
		end
	end
	return originals, clones
end

local function markManaged(instance: Instance, profileHash: string): ()
	instance.Archivable = true
	instance:SetAttribute(MANAGED_ATTRIBUTE, true)
	instance:SetAttribute(HASH_ATTRIBUTE, profileHash)
end

local function requireAppliedEffect(effect: Instance, name: string, className: string, hash: string): ()
	if effect.Parent ~= Lighting
		or effect.Name ~= name
		or not effect:IsA(className)
		or effect:GetAttribute(MANAGED_ATTRIBUTE) ~= true
		or effect:GetAttribute(HASH_ATTRIBUTE) ~= hash then
		fail("visual environment effect drifted: " .. name)
	end
end

function EnvironmentLowering.begin(profile: any): ()
	if pending ~= nil then fail("a visual environment transaction is already active") end
	if typeof(profile) ~= "table" then fail("commit transaction lacks its visual environment") end
	local profileHash = requireHash(profile.hash, "visualEnvironment.hash")
	local previousEffects, previousEffectClones = captureEffects({
		"Atmosphere",
		"ColorCorrectionEffect",
		"SunRaysEffect",
	})
	local snapshot = {
		ambient = Lighting.Ambient,
		outdoorAmbient = Lighting.OutdoorAmbient,
		brightness = Lighting.Brightness,
		clockTime = Lighting.ClockTime,
		geographicLatitude = Lighting.GeographicLatitude,
		environmentDiffuseScale = Lighting.EnvironmentDiffuseScale,
		environmentSpecularScale = Lighting.EnvironmentSpecularScale,
		exposureCompensation = Lighting.ExposureCompensation,
		globalShadows = Lighting.GlobalShadows,
		shadowSoftness = Lighting.ShadowSoftness,
		colorShiftTop = Lighting.ColorShift_Top,
		colorShiftBottom = Lighting.ColorShift_Bottom,
		effects = previousEffectClones,
	}

	pending = {
		profile = profile,
		profileHash = profileHash,
		snapshot = snapshot,
		atmosphere = nil,
		colorGrade = nil,
		sunRays = nil,
	}
	for _, effect in ipairs(previousEffects) do effect:Destroy() end

	local atmosphere = Instance.new("Atmosphere")
	pending.atmosphere = atmosphere
	atmosphere.Name = ATMOSPHERE_NAME
	markManaged(atmosphere, profileHash)
	atmosphere.Color = color(profile.atmosphere.colorSrgb, "visualEnvironment.atmosphere.colorSrgb")
	atmosphere.Decay = color(profile.atmosphere.decaySrgb, "visualEnvironment.atmosphere.decaySrgb")
	atmosphere.Density = finite(profile.atmosphere.density, "visualEnvironment.atmosphere.density")
	atmosphere.Offset = finite(profile.atmosphere.offset, "visualEnvironment.atmosphere.offset")
	atmosphere.Haze = finite(profile.atmosphere.haze, "visualEnvironment.atmosphere.haze")
	atmosphere.Glare = finite(profile.atmosphere.glare, "visualEnvironment.atmosphere.glare")
	atmosphere.Parent = Lighting

	local colorGrade = Instance.new("ColorCorrectionEffect")
	pending.colorGrade = colorGrade
	colorGrade.Name = COLOR_GRADE_NAME
	markManaged(colorGrade, profileHash)
	colorGrade.Enabled = true
	colorGrade.Brightness = finite(profile.colorGrade.brightness, "visualEnvironment.colorGrade.brightness")
	colorGrade.Contrast = finite(profile.colorGrade.contrast, "visualEnvironment.colorGrade.contrast")
	colorGrade.Saturation = finite(profile.colorGrade.saturation, "visualEnvironment.colorGrade.saturation")
	colorGrade.TintColor = color(profile.colorGrade.tintSrgb, "visualEnvironment.colorGrade.tintSrgb")
	colorGrade.Parent = Lighting

	local sunRays = Instance.new("SunRaysEffect")
	pending.sunRays = sunRays
	sunRays.Name = SUN_RAYS_NAME
	markManaged(sunRays, profileHash)
	sunRays.Enabled = true
	sunRays.Intensity = finite(profile.sunRays.intensity, "visualEnvironment.sunRays.intensity")
	sunRays.Spread = finite(profile.sunRays.spread, "visualEnvironment.sunRays.spread")
	sunRays.Parent = Lighting

	Lighting.Ambient = color(profile.ambientSrgb, "visualEnvironment.ambientSrgb")
	Lighting.OutdoorAmbient = color(profile.outdoorAmbientSrgb, "visualEnvironment.outdoorAmbientSrgb")
	Lighting.Brightness = finite(profile.brightness, "visualEnvironment.brightness")
	Lighting.ClockTime = finite(profile.clockTimeHours, "visualEnvironment.clockTimeHours")
	Lighting.GeographicLatitude = finite(
		profile.geographicLatitudeDegrees,
		"visualEnvironment.geographicLatitudeDegrees"
	)
	Lighting.EnvironmentDiffuseScale = finite(
		profile.environmentDiffuseScale,
		"visualEnvironment.environmentDiffuseScale"
	)
	Lighting.EnvironmentSpecularScale = finite(
		profile.environmentSpecularScale,
		"visualEnvironment.environmentSpecularScale"
	)
	Lighting.ExposureCompensation = finite(
		profile.exposureCompensation,
		"visualEnvironment.exposureCompensation"
	)
	Lighting.GlobalShadows = true
	Lighting.ShadowSoftness = finite(profile.shadowSoftness, "visualEnvironment.shadowSoftness")
	Lighting.ColorShift_Top = color(profile.colorShiftTopSrgb, "visualEnvironment.colorShiftTopSrgb")
	Lighting.ColorShift_Bottom = color(
		profile.colorShiftBottomSrgb,
		"visualEnvironment.colorShiftBottomSrgb"
	)

	EnvironmentLowering.verify()
end

function EnvironmentLowering.verify(): ()
	local state = pending
	if state == nil then fail("visual environment verification has no active transaction") end
	local profile = state.profile
	local hash = state.profileHash
	requireAppliedEffect(state.atmosphere, ATMOSPHERE_NAME, "Atmosphere", hash)
	requireAppliedEffect(state.colorGrade, COLOR_GRADE_NAME, "ColorCorrectionEffect", hash)
	requireAppliedEffect(state.sunRays, SUN_RAYS_NAME, "SunRaysEffect", hash)

	if not closeColor(Lighting.Ambient, color(profile.ambientSrgb, "visualEnvironment.ambientSrgb"))
		or not closeColor(
			Lighting.OutdoorAmbient,
			color(profile.outdoorAmbientSrgb, "visualEnvironment.outdoorAmbientSrgb")
		)
		or not closeNumber(Lighting.Brightness, profile.brightness)
		or not closeNumber(Lighting.ClockTime, profile.clockTimeHours)
		or not closeNumber(Lighting.GeographicLatitude, profile.geographicLatitudeDegrees)
		or not closeNumber(Lighting.EnvironmentDiffuseScale, profile.environmentDiffuseScale)
		or not closeNumber(Lighting.EnvironmentSpecularScale, profile.environmentSpecularScale)
		or not closeNumber(Lighting.ExposureCompensation, profile.exposureCompensation)
		or not Lighting.GlobalShadows
		or not closeNumber(Lighting.ShadowSoftness, profile.shadowSoftness)
		or not closeColor(
			Lighting.ColorShift_Top,
			color(profile.colorShiftTopSrgb, "visualEnvironment.colorShiftTopSrgb")
		)
		or not closeColor(
			Lighting.ColorShift_Bottom,
			color(profile.colorShiftBottomSrgb, "visualEnvironment.colorShiftBottomSrgb")
		) then
		fail("visual environment lighting readback drifted")
	end

	local atmosphere = state.atmosphere :: Atmosphere
	if not closeColor(atmosphere.Color, color(profile.atmosphere.colorSrgb, "visualEnvironment.atmosphere.colorSrgb"))
		or not closeColor(atmosphere.Decay, color(profile.atmosphere.decaySrgb, "visualEnvironment.atmosphere.decaySrgb"))
		or not closeNumber(atmosphere.Density, profile.atmosphere.density)
		or not closeNumber(atmosphere.Offset, profile.atmosphere.offset)
		or not closeNumber(atmosphere.Haze, profile.atmosphere.haze)
		or not closeNumber(atmosphere.Glare, profile.atmosphere.glare) then
		fail("visual environment atmosphere readback drifted")
	end
	local colorGrade = state.colorGrade :: ColorCorrectionEffect
	if not colorGrade.Enabled
		or not closeNumber(colorGrade.Brightness, profile.colorGrade.brightness)
		or not closeNumber(colorGrade.Contrast, profile.colorGrade.contrast)
		or not closeNumber(colorGrade.Saturation, profile.colorGrade.saturation)
		or not closeColor(colorGrade.TintColor, color(profile.colorGrade.tintSrgb, "visualEnvironment.colorGrade.tintSrgb")) then
		fail("visual environment color-grade readback drifted")
	end
	local sunRays = state.sunRays :: SunRaysEffect
	if not sunRays.Enabled
		or not closeNumber(sunRays.Intensity, profile.sunRays.intensity)
		or not closeNumber(sunRays.Spread, profile.sunRays.spread) then
		fail("visual environment sun-rays readback drifted")
	end
end

function EnvironmentLowering.commit(): ()
	local state = pending
	if state == nil then fail("visual environment commit has no active transaction") end
	EnvironmentLowering.verify()
	for _, effect in ipairs(state.snapshot.effects) do effect:Destroy() end
	pending = nil
end

function EnvironmentLowering.rollback(): ()
	local state = pending
	if state == nil then return end
	local snapshot = state.snapshot
	Lighting.Ambient = snapshot.ambient
	Lighting.OutdoorAmbient = snapshot.outdoorAmbient
	Lighting.Brightness = snapshot.brightness
	Lighting.ClockTime = snapshot.clockTime
	Lighting.GeographicLatitude = snapshot.geographicLatitude
	Lighting.EnvironmentDiffuseScale = snapshot.environmentDiffuseScale
	Lighting.EnvironmentSpecularScale = snapshot.environmentSpecularScale
	Lighting.ExposureCompensation = snapshot.exposureCompensation
	Lighting.GlobalShadows = snapshot.globalShadows
	Lighting.ShadowSoftness = snapshot.shadowSoftness
	Lighting.ColorShift_Top = snapshot.colorShiftTop
	Lighting.ColorShift_Bottom = snapshot.colorShiftBottom
	if state.atmosphere ~= nil then state.atmosphere:Destroy() end
	if state.colorGrade ~= nil then state.colorGrade:Destroy() end
	if state.sunRays ~= nil then state.sunRays:Destroy() end
	for _, effect in ipairs(snapshot.effects) do effect.Parent = Lighting end
	pending = nil
end

return EnvironmentLowering
