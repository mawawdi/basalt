--!strict

local LoadedAsset = {}

-- Catalog realization is static. Do not inherit accidental physics state from
-- a published package or allow geometry to fall apart when Play starts.
function LoadedAsset.anchorGeometry(model: Model): ()
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("BasePart") then descendant.Anchored = true end
	end
end

function LoadedAsset.verifyAnchoredGeometry(model: Model): ()
	local hasGeometry = false
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("BasePart") then
			hasGeometry = true
			if not descendant.Anchored then error("catalog geometry is not anchored: " .. descendant:GetFullName()) end
		end
	end
	if not hasGeometry then error("catalog model has no geometry: " .. model.Name) end
end

local function containsGeometry(instance: Instance): boolean
	if instance:IsA("BasePart") then return true end
	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("BasePart") then return true end
	end
	return false
end

-- InsertService:LoadAsset returns a transport Model containing the published
-- model asset. Catalog part paths are sealed relative to that published model,
-- so the transport wrapper must never become part of the semantic hierarchy.
function LoadedAsset.unwrap(container: Model): Model
	local packageModel: Model? = nil
	local packageModelCount = 0
	for _, child in ipairs(container:GetChildren()) do
		if child:IsA("Model") and containsGeometry(child) then
			packageModel = child
			packageModelCount += 1
		end
	end
	if packageModelCount ~= 1 or packageModel == nil then
		error(string.format(
			"loaded asset wrapper must contain exactly one geometric package model; observed %d",
			packageModelCount
		))
	end
	local resolved = packageModel :: Model
	for _, descendant in ipairs(container:GetDescendants()) do
		if descendant:IsA("LuaSourceContainer") then
			error("loaded asset wrapper contains executable source")
		end
		if descendant:IsA("BasePart") and not descendant:IsDescendantOf(resolved) then
			error("loaded asset wrapper contains geometry outside its package model")
		end
	end
	resolved.Parent = nil
	container:Destroy()
	return resolved
end

return LoadedAsset
