/** Shared planar geometry for road cutouts, height queries and collision. */
export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
}
export interface SurfaceMesh {
  positions: number[];
  indices: number[];
}
export type SurfaceTriangle = [SurfacePoint, SurfacePoint, SurfacePoint];
const EPSILON = 1e-8;

export function signedArea(
  a: SurfacePoint,
  b: SurfacePoint,
  c: SurfacePoint,
): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

export function triangleHeight(
  triangle: SurfaceTriangle,
  x: number,
  z: number,
): number | undefined {
  const [a, b, c] = triangle;
  const area = signedArea(a, b, c);
  if (Math.abs(area) < EPSILON) return undefined;
  const p = { x, y: 0, z };
  const u = signedArea(p, b, c) / area;
  const v = signedArea(a, p, c) / area;
  const w = 1 - u - v;
  if (Math.min(u, v, w) < -EPSILON) return undefined;
  return u * a.y + v * b.y + w * c.y;
}

export function meshTriangles(mesh: SurfaceMesh): SurfaceTriangle[] {
  const result: SurfaceTriangle[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const points = mesh.indices.slice(i, i + 3).map((index) => ({
      x: mesh.positions[index * 3] ?? 0,
      y: mesh.positions[index * 3 + 1] ?? 0,
      z: mesh.positions[index * 3 + 2] ?? 0,
    }));
    if (points.length === 3) result.push(points as SurfaceTriangle);
  }
  return result;
}

export function combineSurfaces(meshes: SurfaceMesh[]): SurfaceMesh {
  const result: SurfaceMesh = { positions: [], indices: [] };
  for (const mesh of meshes) {
    const offset = result.positions.length / 3;
    for (const value of mesh.positions) result.positions.push(value);
    for (const index of mesh.indices) result.indices.push(index + offset);
  }
  return result;
}

export class SurfaceIndex {
  private readonly buckets = new Map<string, SurfaceTriangle[]>();
  constructor(
    mesh: SurfaceMesh,
    private readonly size = 16,
  ) {
    for (const triangle of meshTriangles(mesh)) {
      const xs = triangle.map((point) => point.x);
      const zs = triangle.map((point) => point.z);
      for (
        let x = Math.floor(Math.min(...xs) / size);
        x <= Math.floor(Math.max(...xs) / size);
        x++
      ) {
        for (
          let z = Math.floor(Math.min(...zs) / size);
          z <= Math.floor(Math.max(...zs) / size);
          z++
        ) {
          const key = `${x}:${z}`;
          const bucket = this.buckets.get(key) ?? [];
          bucket.push(triangle);
          this.buckets.set(key, bucket);
        }
      }
    }
  }
  at(x: number, z: number): SurfaceTriangle[] {
    return (
      this.buckets.get(
        `${Math.floor(x / this.size)}:${Math.floor(z / this.size)}`,
      ) ?? []
    );
  }
  within(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): SurfaceTriangle[] {
    const result = new Set<SurfaceTriangle>();
    for (
      let x = Math.floor(minX / this.size);
      x <= Math.floor(maxX / this.size);
      x++
    ) {
      for (
        let z = Math.floor(minZ / this.size);
        z <= Math.floor(maxZ / this.size);
        z++
      ) {
        for (const triangle of this.buckets.get(`${x}:${z}`) ?? [])
          result.add(triangle);
      }
    }
    return [...result];
  }
  height(x: number, z: number): number | undefined {
    let result: number | undefined;
    for (const triangle of this.at(x, z)) {
      const height = triangleHeight(triangle, x, z);
      if (height !== undefined) result = Math.min(result ?? Infinity, height);
    }
    return result;
  }
}

/** Split a convex polygon by an oriented line, preserving interpolated heights. */
function halfPlane(
  polygon: SurfacePoint[],
  a: SurfacePoint,
  b: SurfacePoint,
  sign: number,
): SurfacePoint[] {
  const result: SurfacePoint[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i]!;
    const end = polygon[(i + 1) % polygon.length]!;
    const d0 = signedArea(a, b, start) * sign;
    const d1 = signedArea(a, b, end) * sign;
    if (d0 >= 0) result.push(start);
    if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
      const t = d0 / (d0 - d1);
      result.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      });
    }
  }
  return result;
}

/** Convex pieces outside the clip triangle; never deletes an entire intersecting cell. */
export function subtractTriangle(
  polygon: SurfacePoint[],
  clip: SurfaceTriangle,
): SurfacePoint[][] {
  const orientation = Math.sign(signedArea(...clip));
  if (!orientation) return [polygon];
  for (let edge = 0; edge < 3; edge++) {
    if (
      polygon.every(
        (point) =>
          signedArea(clip[edge]!, clip[(edge + 1) % 3]!, point) * orientation <=
          EPSILON,
      )
    )
      return [polygon];
  }
  let inside = polygon;
  const outside: SurfacePoint[][] = [];
  for (let edge = 0; edge < 3 && inside.length >= 3; edge++) {
    const a = clip[edge]!;
    const b = clip[(edge + 1) % 3]!;
    const piece = halfPlane(inside, a, b, -orientation);
    if (piece.length >= 3) outside.push(piece);
    inside = halfPlane(inside, a, b, orientation);
  }
  return outside;
}

const vertexMaps = new WeakMap<SurfaceMesh, Map<string, number>>();

export function appendPolygon(
  mesh: SurfaceMesh,
  polygon: SurfacePoint[],
): void {
  if (polygon.length < 3) return;
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[0]!;
    const b = polygon[i]!;
    const c = polygon[i + 1]!;
    const area = signedArea(a, b, c);
    if (Math.abs(area) < EPSILON) continue;
    let vertices = vertexMaps.get(mesh);
    if (!vertices) {
      vertices = new Map();
      vertexMaps.set(mesh, vertices);
    }
    const ids = [a, b, c].map((point) => {
      const key = `${Math.round(point.x * 1e7)}:${Math.round(point.y * 1e7)}:${Math.round(point.z * 1e7)}`;
      let id = vertices.get(key);
      if (id === undefined) {
        id = mesh.positions.length / 3;
        mesh.positions.push(point.x, point.y, point.z);
        vertices.set(key, id);
      }
      return id;
    });
    // Upward winding in the X/Z plane.
    mesh.indices.push(ids[0]!, ids[area < 0 ? 1 : 2]!, ids[area < 0 ? 2 : 1]!);
  }
}
