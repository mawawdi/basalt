--!strict
local AssetBindingCapture = {}

-- Observe the exact published hierarchy without parenting it into the place.
-- The result records engine properties; it makes no visual-quality judgment.
function AssetBindingCapture.inspectModel(model: Model): { any }
	local observations = {}
	local visited = 0
	local function visit(parent: Instance, parentPath: { any }): ()
		if #parentPath >= 128 then error("asset material hierarchy is too deep") end
		local ordinals: { [string]: number } = {}
		for _, child in ipairs(parent:GetChildren()) do
			visited += 1
			if visited > 100000 then error("asset material hierarchy exceeds its bound") end
			if child:IsA("LuaSourceContainer") then error("asset contains executable source") end
			local path = table.clone(parentPath)
			local ordinal = ordinals[child.Name] or 0
			ordinals[child.Name] = ordinal + 1
			table.insert(path, { name = child.Name, siblingOrdinal = ordinal })
			if child:IsA("BasePart") then
				local item: any = {
					partPath = path,
					className = child.ClassName,
					material = child.Material.Name,
					color = { red = math.floor(child.Color.R * 255 + 0.5), green = math.floor(child.Color.G * 255 + 0.5), blue = math.floor(child.Color.B * 255 + 0.5) },
					transparency = child.Transparency,
					reflectance = child.Reflectance,
				}
				if child:IsA("MeshPart") then item.meshTextureId = child.TextureID end
				for _, appearance in ipairs(child:GetChildren()) do
					if not appearance:IsA("SurfaceAppearance") then continue end
					if item.surfaceAppearance ~= nil then error("asset part has multiple SurfaceAppearances") end
					item.surfaceAppearance = { colorMap = appearance.ColorMap, metalnessMap = appearance.MetalnessMap, normalMap = appearance.NormalMap, roughnessMap = appearance.RoughnessMap, alphaMode = appearance.AlphaMode.Name }
				end
				table.insert(observations, item)
			end
			visit(child, path)
		end
	end
	visit(model, {})
	if #observations == 0 then error("asset has no material-bearing parts") end
	return observations
end

function AssetBindingCapture.capture(packet: any, onProgress: (number, number) -> (), shouldCancel: () -> boolean): any
	local LoadedAsset = require(script.Parent.LoadedAsset)
	if typeof(packet) ~= "table" or packet.kind ~= "CatalogFirstUseRobloxUploadPacket"
		or typeof(packet.missingBindings) ~= "table" or #packet.missingBindings == 0 or #packet.missingBindings > 128 then
		error("invalid bounded asset-binding capture packet")
	end
	local userId = game:GetService("StudioService"):GetUserId()
	if userId <= 0 then error("sign in to Studio before observing published assets") end
	local bindings = {}
	for index, item in ipairs(packet.missingBindings) do
		if shouldCancel() then error("asset binding capture cancelled") end
		if typeof(item.robloxAssetId) ~= "number" or item.robloxAssetId <= 0 or item.robloxAssetId % 1 ~= 0 then error("capture requires an exact published model ID") end
		onProgress(index - 1, #packet.missingBindings)
		local container = game:GetService("InsertService"):LoadAsset(item.robloxAssetId)
		local model: Model? = nil
		local ok, result = pcall(function(): { any }
			model = LoadedAsset.unwrap(container :: Model)
			return AssetBindingCapture.inspectModel(model :: Model)
		end)
		if model ~= nil then (model :: Model):Destroy() else container:Destroy() end
		if not ok then error(result) end
		table.insert(bindings, {
			assetHash = item.assetHash, robloxAssetId = item.robloxAssetId,
			sourceArtifactHash = item.sourceArtifactHash, uploadArtifactHash = item.uploadArtifactHash,
			publicationEvidenceHash = item.publicationEvidenceHash, materialExpectations = result,
		})
	end
	if shouldCancel() then error("asset binding capture cancelled") end
	onProgress(#bindings, #bindings)
	return {
		kind = "CatalogFirstUseRobloxBindingDecision", uploadPacketHash = packet.hash,
		recordedBy = { authority = "creator", reviewerId = tostring(userId) },
		reviewerStatement = "The creator initiated fixed connector observation of these exact published models in Studio. Material properties and hierarchy were read from the engine; visual quality and world traversal are not asserted by this capture.",
		recordedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), bindings = bindings,
	}
end

return AssetBindingCapture
