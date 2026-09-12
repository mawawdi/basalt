--!strict
local Constants = require(script.Parent.Constants)
local Frames = require(script.Parent.Frames)

-- Portal marker lowering. Portals lower no door geometry in v1 (rooms
-- are open plan; entrances bind the assembly's own door instances), so
-- each portal lowers one transparent non-colliding evidence slab
-- centered on the sealed pose, wide across the opening. Marker poses
-- return to the readback; the yaw attribute guards record skew.
local PortalLowering = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

function PortalLowering.lowerPortals(parent: Instance, transaction: any, scene: any): { any }
	local stale = parent:FindFirstChild("portals")
	if stale ~= nil then stale:Destroy() end
	local folder = Instance.new("Folder")
	folder.Name = "portals"
	folder.Parent = parent
	local readings: { any } = {}
	for _, portalId in ipairs(transaction.portalIds) do
		local portal = scene.portalsById[portalId]
		if portal == nil then fail("scene export has no portal " .. portalId) end
		local yawSteps = portal.yawStepsY90
		if yawSteps ~= 0 and yawSteps ~= 1 and yawSteps ~= 2 and yawSteps ~= 3 then
			fail("portal " .. portalId .. " has an invalid yaw " .. tostring(yawSteps))
		end
		local position = portal.positionMeters
		local center = Vector3.new(
			Frames.metersToStuds(position.x),
			Frames.metersToStuds(position.y),
			Frames.metersToStuds(position.z)
		)
		local width = Frames.metersToStuds(portal.widthMeters)
		if width <= 0 then fail("portal " .. portalId .. " carries a degenerate width") end
		local acrossX = yawSteps == 0 or yawSteps == 2
		local marker = Instance.new("Part")
		marker.Name = portalId
		if acrossX then
			marker.Size = Vector3.new(width, Constants.PORTAL_MARKER_HEIGHT_STUDS, Constants.PORTAL_MARKER_THICKNESS_STUDS)
		else
			marker.Size = Vector3.new(Constants.PORTAL_MARKER_THICKNESS_STUDS, Constants.PORTAL_MARKER_HEIGHT_STUDS, width)
		end
		marker.CFrame = CFrame.new(center)
		marker.Transparency = 1
		marker.Anchored = true
		marker.CanCollide = false
		marker.CanQuery = false
		marker.CanTouch = false
		marker:SetAttribute("BasaltPortalId", portalId)
		marker:SetAttribute("BasaltPortalYaw", yawSteps)
		marker.Parent = folder
		table.insert(readings, {
			portalId = portalId,
			x = Frames.studsToMeters(center.X),
			y = Frames.studsToMeters(center.Y),
			z = Frames.studsToMeters(center.Z),
			yawStepsY90 = marker:GetAttribute("BasaltPortalYaw"),
		})
	end
	return readings
end

return PortalLowering
