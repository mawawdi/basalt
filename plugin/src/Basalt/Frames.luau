--!strict
local Constants = require(script.Parent.Constants)

-- Pure placement math for the sealed instance composition:
-- T(positionMeters).R(rotationQuaternion).S(uniformScale)
--   .T(-pivotOffsetMeters).S(unitsToMeters)
-- applied to asset-frame points in source units, evaluated in studs.
local Frames = {}

function Frames.metersToStuds(meters: number): number
	return meters / Constants.STUD_METERS
end

-- Unit quaternion [x, y, z, w] to a rotation-only CFrame.
function Frames.quaternionToCFrame(qx: number, qy: number, qz: number, qw: number): CFrame
	local xx = qx * qx
	local yy = qy * qy
	local zz = qz * qz
	local xy = qx * qy
	local xz = qx * qz
	local yz = qy * qz
	local wx = qw * qx
	local wy = qw * qy
	local wz = qw * qz
	return CFrame.new(
		0,
		0,
		0,
		1 - 2 * (yy + zz),
		2 * (xy - wz),
		2 * (xz + wy),
		2 * (xy + wz),
		1 - 2 * (xx + zz),
		2 * (yz - wx),
		2 * (xz - wy),
		2 * (yz + wx),
		1 - 2 * (xx + yy)
	)
end

export type InstanceFrame = {
	positionStuds: Vector3,
	rotation: CFrame,
	scale: number,
	pivotStuds: Vector3,
	sourceToStuds: number,
}

function Frames.instanceFrame(instance: any, asset: any): InstanceFrame
	local position = instance.positionMeters
	local pivot = asset.pivotOffsetMeters
	local rotation = instance.rotation
	return {
		positionStuds = Vector3.new(
			Frames.metersToStuds(position.x),
			Frames.metersToStuds(position.y),
			Frames.metersToStuds(position.z)
		),
		rotation = Frames.quaternionToCFrame(rotation[1], rotation[2], rotation[3], rotation[4]),
		scale = instance.scale,
		pivotStuds = Vector3.new(
			Frames.metersToStuds(pivot.x),
			Frames.metersToStuds(pivot.y),
			Frames.metersToStuds(pivot.z)
		),
		sourceToStuds = asset.unitsToMeters / Constants.STUD_METERS,
	}
end

-- Lower one asset-frame point (source units) to world studs.
function Frames.worldPosition(frame: InstanceFrame, assetPoint: Vector3): Vector3
	local scaled = assetPoint * frame.sourceToStuds - frame.pivotStuds
	local rotated = frame.rotation:VectorToWorldSpace(scaled * frame.scale)
	return frame.positionStuds + rotated
end

-- Rotation applied to imported part orientations (scale-free).
function Frames.worldRotation(frame: InstanceFrame, importedRotation: CFrame): CFrame
	return frame.rotation * importedRotation
end

return Frames
