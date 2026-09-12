--!strict

-- Pure BVX2 decoder. Every integer and float is decoded manually from raw
-- bytes in little-endian order, so lowering depends on no engine float
-- decoding behavior beyond IEEE-754 doubles.
local VoxelField = {}

local function fail(message: string): never
	error("Basalt connector: " .. message)
end

local Reader = {}
Reader.__index = Reader

function Reader.new(bytes: string): any
	return setmetatable({ bytes = bytes, offset = 1 }, Reader)
end

function Reader:remaining(): number
	return #self.bytes - self.offset + 1
end

function Reader:take(count: number, label: string): string
	if self:remaining() < count then fail("voxel payload truncates " .. label) end
	local chunk = string.sub(self.bytes, self.offset, self.offset + count - 1)
	self.offset += count
	return chunk
end

function Reader:u8(): number
	return string.byte(self:take(1, "u8"))
end

function Reader:u16(label: string): number
	local chunk = self:take(2, label)
	local b0, b1 = string.byte(chunk, 1, 2)
	return b0 + b1 * 256
end

function Reader:u32(label: string): number
	local chunk = self:take(4, label)
	local b0, b1, b2, b3 = string.byte(chunk, 1, 4)
	return b0 + b1 * 256 + b2 * 65536 + b3 * 16777216
end

local function decodeBinary32(bits: number, label: string): number
	local sign = if bits >= 2147483648 then -1 else 1
	local magnitude = bits % 2147483648
	local exponent = math.floor(magnitude / 8388608)
	local mantissa = magnitude % 8388608
	if exponent == 255 then fail("voxel payload carries a non-finite " .. label) end
	if exponent == 0 then
		return sign * math.ldexp(mantissa / 8388608, -126)
	end
	return sign * math.ldexp(1 + mantissa / 8388608, exponent - 127)
end

local function decodeBinary64(lo: number, hi: number, label: string): number
	local sign = if hi >= 2147483648 then -1 else 1
	local hiMagnitude = hi % 2147483648
	local exponent = math.floor(hiMagnitude / 1048576)
	local mantissa = (hiMagnitude % 1048576) * 4294967296 + lo
	if exponent == 2047 then fail("voxel payload carries a non-finite " .. label) end
	if exponent == 0 then
		return sign * math.ldexp(mantissa / 4503599627370496, -1022)
	end
	return sign * math.ldexp(1 + mantissa / 4503599627370496, exponent - 1023)
end

function Reader:f32(label: string): number
	return decodeBinary32(self:u32(label), label)
end

function Reader:f64(label: string): number
	local lo = self:u32(label)
	local hi = self:u32(label)
	return decodeBinary64(lo, hi, label)
end

export type DecodedVoxelField = {
	dimensions: { number },
	origin: { number },
	cellSize: number,
	materials: { string },
	occupancy: { number },
	liquid: { number },
	materialIndex: { number },
}

-- Decode bytes written by the compiler voxel exporter. Index order is
-- x-fastest, then z, then y: flat = x + dimX * (z + dimZ * y), 0-based.
function VoxelField.decode(bytes: string): DecodedVoxelField
	local reader = Reader.new(bytes)
	if reader:take(4, "magic") ~= "BVX2" then fail("voxel payload has an unknown magic") end
	local nx = reader:u32("dimX")
	local ny = reader:u32("dimY")
	local nz = reader:u32("dimZ")
	if nx < 1 or ny < 1 or nz < 1 then fail("voxel payload has empty dimensions") end
	local origin = { reader:f64("originX"), reader:f64("originY"), reader:f64("originZ") }
	local cellSize = reader:f64("cellSize")
	if cellSize <= 0 then fail("voxel payload has a non-positive cell size") end
	local materialCount = reader:u32("materialCount")
	local materials: { string } = {}
	for _ = 1, materialCount do
		local length = reader:u16("material name length")
		table.insert(materials, reader:take(length, "material name"))
	end
	local total = nx * ny * nz
	if reader:remaining() ~= total * 10 then
		fail("voxel payload length disagrees with its dimensions")
	end
	local occupancy: { number } = table.create(total)
	for index = 1, total do
		local value = reader:f32("occupancy")
		if value < 0 or value > 1 then fail("voxel payload occupancy escapes [0, 1]") end
		occupancy[index] = value
	end
	local liquid: { number } = table.create(total)
	for index = 1, total do
		local value = reader:f32("liquid")
		if value < 0 or value > 1 then fail("voxel payload liquid escapes [0, 1]") end
		liquid[index] = value
	end
	local materialIndex: { number } = table.create(total)
	for index = 1, total do
		local value = reader:u16("material index")
		if value < 0 or value >= materialCount then
			fail("voxel payload references an unknown material")
		end
		materialIndex[index] = value
	end
	return {
		dimensions = { nx, ny, nz },
		origin = origin,
		cellSize = cellSize,
		materials = materials,
		occupancy = occupancy,
		liquid = liquid,
		materialIndex = materialIndex,
	}
end

return VoxelField
