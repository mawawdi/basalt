export interface GeometryPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type GeometryTriangle = readonly [number, number, number];

export interface NormalizedMesh {
  readonly vertices: readonly GeometryPoint[];
  readonly triangles: readonly GeometryTriangle[];
}

export interface GeometryMeasurement {
  readonly genus: number;
  readonly surfaceArea: number;
  readonly bounds: readonly [number, number, number];
  readonly isManifold: boolean;
}

interface TopologySummary {
  readonly genus: number;
  readonly nonManifoldEdgeCount: number;
  readonly degenerateTriangleCount: number;
  readonly isManifold: boolean;
}

export function measureGeometry(mesh: NormalizedMesh): GeometryMeasurement {
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0)
    throw new Error("Geometry measurement requires vertices and triangles");
  const bounds = axisBounds(mesh.vertices);
  const surfaceArea = mesh.triangles.reduce((total, triangle) => {
    const [a, b, c] = triangle.map((index) => mesh.vertices[index]);
    if (!a || !b || !c) throw new Error("Triangle references a missing vertex");
    return total + triangleArea(a, b, c);
  }, 0);
  const topology = measureTopology(mesh.vertices.length, mesh.triangles);
  return {
    genus: topology.genus,
    surfaceArea,
    bounds,
    isManifold: topology.isManifold,
  };
}

function measureTopology(
  vertexCount: number,
  triangles: readonly GeometryTriangle[],
): TopologySummary {
  const parent = Array.from({ length: vertexCount }, (_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== value) {
      const next = parent[value]!;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const edgeCounts = new Map<string, { left: number; right: number; count: number }>();
  const validTriangles: GeometryTriangle[] = [];
  let degenerateTriangleCount = 0;
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      !Number.isInteger(c) ||
      a < 0 ||
      b < 0 ||
      c < 0 ||
      a >= vertexCount ||
      b >= vertexCount ||
      c >= vertexCount ||
      new Set([a, b, c]).size !== 3
    ) {
      degenerateTriangleCount += 1;
      continue;
    }
    validTriangles.push(triangle);
    union(a, b);
    union(b, c);
    union(c, a);
    for (const [left, right] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const orderedLeft = Math.min(left, right);
      const orderedRight = Math.max(left, right);
      const key = `${orderedLeft}:${orderedRight}`;
      const current = edgeCounts.get(key);
      if (current) current.count += 1;
      else edgeCounts.set(key, { left: orderedLeft, right: orderedRight, count: 1 });
    }
  }
  const componentVertices = new Map<number, Set<number>>();
  for (const triangle of validTriangles)
    for (const vertex of triangle) {
      const root = find(vertex);
      const vertices = componentVertices.get(root) ?? new Set<number>();
      vertices.add(vertex);
      componentVertices.set(root, vertices);
    }
  const componentEdges = new Map<
    number,
    Map<string, { left: number; right: number; count: number }>
  >();
  for (const edge of edgeCounts.values()) {
    const root = find(edge.left);
    const edges = componentEdges.get(root) ?? new Map();
    edges.set(`${edge.left}:${edge.right}`, edge);
    componentEdges.set(root, edges);
  }
  const componentFaces = new Map<number, number>();
  for (const triangle of validTriangles) {
    const root = find(triangle[0]!);
    componentFaces.set(root, (componentFaces.get(root) ?? 0) + 1);
  }
  let genus = 0;
  let nonManifoldEdgeCount = 0;
  let validGenus = degenerateTriangleCount === 0;
  for (const [root, vertices] of componentVertices) {
    const edges = componentEdges.get(root) ?? new Map();
    const boundaryEdges = [...edges.values()].filter((edge) => edge.count === 1);
    const boundaryGraph = new Map<number, Set<number>>();
    for (const edge of boundaryEdges) {
      const left = boundaryGraph.get(edge.left) ?? new Set<number>();
      const right = boundaryGraph.get(edge.right) ?? new Set<number>();
      left.add(edge.right);
      right.add(edge.left);
      boundaryGraph.set(edge.left, left);
      boundaryGraph.set(edge.right, right);
    }
    const visited = new Set<number>();
    let boundaryLoops = 0;
    for (const vertex of boundaryGraph.keys()) {
      if (visited.has(vertex)) continue;
      boundaryLoops += 1;
      const queue = [vertex];
      visited.add(vertex);
      while (queue.length > 0) {
        const current = queue.pop()!;
        for (const neighbor of boundaryGraph.get(current) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    for (const neighbors of boundaryGraph.values()) if (neighbors.size !== 2) validGenus = false;
    const chi = vertices.size - edges.size + (componentFaces.get(root) ?? 0);
    const numerator = 2 - boundaryLoops - chi;
    if (numerator < 0 || numerator % 2 !== 0) validGenus = false;
    else genus += numerator / 2;
    nonManifoldEdgeCount += [...edges.values()].filter((edge) => edge.count > 2).length;
  }
  if (nonManifoldEdgeCount > 0) validGenus = false;
  return {
    genus: validGenus ? genus : -1,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
    isManifold: validTriangles.length > 0 && validGenus && nonManifoldEdgeCount === 0,
  };
}

function axisBounds(vertices: readonly GeometryPoint[]): readonly [number, number, number] {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of vertices) {
    const values = [point.x, point.y, point.z];
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, values[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, values[axis]!);
    }
  }
  return [maximum[0]! - minimum[0]!, maximum[1]! - minimum[1]!, maximum[2]! - minimum[2]!];
}

function triangleArea(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return (
    Math.hypot(ab.y * ac.z - ab.z * ac.y, ab.z * ac.x - ab.x * ac.z, ab.x * ac.y - ab.y * ac.x) / 2
  );
}
