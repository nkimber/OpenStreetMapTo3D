import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import {
  deterministicHash,
  type LandPlan,
  type LocalPoint2,
  type TerrainChunkPlan,
  type WorldPlan,
} from "@osm3d/worldgen";

function insideRing(x: number, z: number, ring: LocalPoint2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (
      a.z > z !== b.z > z &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}

export function terrainGeometry(
  chunk: TerrainChunkPlan,
  land: LandPlan[] = [],
  night = false,
): THREE.BufferGeometry {
  const positions: number[] = chunk.mesh?.positions ?? [];
  const indices: number[] = chunk.mesh?.indices ?? [];
  if (!chunk.mesh) {
    for (let x = 0; x < chunk.columns; x++)
      for (let z = 0; z < chunk.rows; z++) {
        positions.push(
          chunk.bounds.minX +
            (x / (chunk.columns - 1)) * (chunk.bounds.maxX - chunk.bounds.minX),
          chunk.heights[x * chunk.rows + z] ?? 0,
          chunk.bounds.minZ +
            (z / (chunk.rows - 1)) * (chunk.bounds.maxZ - chunk.bounds.minZ),
        );
      }
    for (let x = 0; x < chunk.columns - 1; x++)
      for (let z = 0; z < chunk.rows - 1; z++) {
        const a = x * chunk.rows + z,
          b = a + chunk.rows,
          c = a + 1,
          d = b + 1;
        indices.push(a, c, b, b, c, d);
      }
  }
  const colors: number[] = [];
  const base = new THREE.Color(night ? 0x18251c : 0x88a66b);
  const palette = land.map((area) => ({
    area,
    color: new THREE.Color(
      area.kind === "water"
        ? 0x4f9ec4
        : area.classification === "park"
          ? 0x6fa75f
          : 0x839d69,
    ).multiplyScalar(night ? 0.35 : 1),
  }));
  for (let i = 0; i < positions.length; i += 3) {
    let color = base;
    for (const entry of palette) {
      if (
        insideRing(
          positions[i]!,
          positions[i + 2]!,
          entry.area.rings[0] ?? [],
        ) &&
        !entry.area.rings
          .slice(1)
          .some((ring) => insideRing(positions[i]!, positions[i + 2]!, ring))
      )
        color = entry.color;
    }
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function terrainCollider(chunk: TerrainChunkPlan): RAPIER.ColliderDesc {
  if (chunk.mesh)
    return RAPIER.ColliderDesc.trimesh(
      new Float32Array(chunk.mesh.positions),
      new Uint32Array(chunk.mesh.indices),
    ).setFriction(1.1);
  return RAPIER.ColliderDesc.heightfield(
    chunk.columns - 1,
    chunk.rows - 1,
    new Float32Array(chunk.heights),
    {
      x: chunk.bounds.maxX - chunk.bounds.minX,
      y: 1,
      z: chunk.bounds.maxZ - chunk.bounds.minZ,
    },
  )
    .setTranslation(
      (chunk.bounds.minX + chunk.bounds.maxX) / 2,
      0,
      (chunk.bounds.minZ + chunk.bounds.maxZ) / 2,
    )
    .setFriction(1.1);
}

interface TerrainEntry {
  signature: string;
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
}

/** Stages complete replacements before synchronously swapping scene and physics. */
export class TerrainRuntime {
  private readonly entries = new Map<string, TerrainEntry>();
  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: RAPIER.World,
  ) {}

  sync(plan: WorldPlan, night: boolean): string[] {
    const pending = new Map<string, TerrainEntry>();
    const retained = new Set<string>();
    try {
      for (const chunk of plan.terrain?.chunks ?? []) {
        retained.add(chunk.id);
        const land = plan.land.filter((area) => {
          const points = area.rings[0] ?? [];
          return (
            points.length &&
            Math.min(...points.map((p) => p.x)) <= chunk.bounds.maxX &&
            Math.max(...points.map((p) => p.x)) >= chunk.bounds.minX &&
            Math.min(...points.map((p) => p.z)) <= chunk.bounds.maxZ &&
            Math.max(...points.map((p) => p.z)) >= chunk.bounds.minZ
          );
        });
        const signature = deterministicHash({
          chunk: chunk.contentHash ?? chunk,
          land,
          night,
        });
        if (this.entries.get(chunk.id)?.signature === signature) continue;
        const mesh = new THREE.Mesh(
          terrainGeometry(chunk, land, night),
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.96,
          }),
        );
        mesh.name = chunk.id;
        mesh.receiveShadow = true;
        const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        const entry = { signature, mesh, body };
        pending.set(chunk.id, entry);
        if (!chunk.mesh || chunk.mesh.indices.length)
          this.physics.createCollider(terrainCollider(chunk), body);
      }
    } catch (error) {
      for (const entry of pending.values()) this.release(entry);
      throw error;
    }
    const changed: string[] = [];
    for (const [id, entry] of this.entries) {
      if (!retained.has(id) || pending.has(id)) {
        this.release(entry);
        this.entries.delete(id);
        changed.push(id);
      }
    }
    for (const [id, entry] of pending) {
      this.entries.set(id, entry);
      this.scene.add(entry.mesh);
      if (!changed.includes(id)) changed.push(id);
    }
    return changed.sort();
  }
  private release(entry: TerrainEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    const materials = Array.isArray(entry.mesh.material)
      ? entry.mesh.material
      : [entry.mesh.material];
    for (const material of materials) material.dispose();
    this.physics.removeRigidBody(entry.body);
  }
}
