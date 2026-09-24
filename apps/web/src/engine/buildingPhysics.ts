import RAPIER from "@dimforge/rapier3d-compat";
import type { BuildingPlan, LocalPoint2 } from "@osm3d/worldgen";
import * as THREE from "three";

export interface BuildingCollisionMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

function openRing(ring: LocalPoint2[]): LocalPoint2[] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring.at(-1)!;
  return first.x === last.x && first.z === last.z ? ring.slice(0, -1) : ring;
}

/** Build a closed mesh that follows the OSM footprint, including holes. */
export function buildingCollisionMesh(
  building: BuildingPlan,
): BuildingCollisionMesh | undefined {
  const rings = building.rings.map(openRing).filter((ring) => ring.length >= 3);
  const outer = rings[0];
  if (!outer) return undefined;

  const points = rings.flat();
  const vertices = new Float32Array(points.length * 2 * 3);
  points.forEach((point, index) => {
    const offset = index * 6;
    vertices[offset] = point.x;
    vertices[offset + 1] = 0;
    vertices[offset + 2] = point.z;
    vertices[offset + 3] = point.x;
    vertices[offset + 4] = building.height;
    vertices[offset + 5] = point.z;
  });

  const indices: number[] = [];
  const triangles = THREE.ShapeUtils.triangulateShape(
    outer.map((point) => new THREE.Vector2(point.x, point.z)),
    rings
      .slice(1)
      .map((ring) => ring.map((point) => new THREE.Vector2(point.x, point.z))),
  );
  for (const triangle of triangles) {
    const [a, b, c] = triangle as [number, number, number];
    indices.push(a * 2 + 1, b * 2 + 1, c * 2 + 1);
    indices.push(c * 2, b * 2, a * 2);
  }

  let pointOffset = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = (pointOffset + index) * 2;
      const b = (pointOffset + ((index + 1) % ring.length)) * 2;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
    pointOffset += ring.length;
  }

  return { vertices, indices: new Uint32Array(indices) };
}

export function buildingCollider(
  building: BuildingPlan,
): RAPIER.ColliderDesc | undefined {
  const mesh = buildingCollisionMesh(building);
  return (
    mesh &&
    RAPIER.ColliderDesc.trimesh(
      mesh.vertices,
      mesh.indices,
      RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
    ).setFriction(0.8)
  );
}
