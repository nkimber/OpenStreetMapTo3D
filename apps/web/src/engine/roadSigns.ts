import type { WorldPlan } from "@osm3d/worldgen";
import { sampleTerrainPlan } from "@osm3d/worldgen";
import * as THREE from "three";

export function roadSignLocations(plan: WorldPlan) {
  const roads = new Map<string, WorldPlan["roads"]>();
  for (const road of plan.roads) {
    const parts = roads.get(road.sourceId) ?? [];
    parts.push(road);
    roads.set(road.sourceId, parts);
  }
  return plan.junctions.flatMap((junction) => {
    if (junction.kind !== "intersection" || junction.sourceIds.length < 2)
      return [];
    const connected = junction.sourceIds.flatMap((id) =>
      (roads.get(id) ?? []).filter((road) => road.layer === junction.layer),
    );
    const names = [
      ...new Set(
        connected
          .map((road) => road.name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ].sort();
    // A split in one named street is not a meeting of different roads.
    if (
      names.length === 0 ||
      (names.length === 1 &&
        connected.every((road) => road.name?.trim() === names[0]))
    )
      return [];
    // Put the post between approaches, including rotated and T junctions.
    const angles = connected
      .flatMap((road) =>
        road.points.flatMap((point, index) => {
          if (
            Math.hypot(
              point.x - junction.center.x,
              point.z - junction.center.z,
            ) > 0.1
          )
            return [];
          return [road.points[index - 1], road.points[index + 1]].flatMap(
            (neighbor) => {
              if (
                !neighbor ||
                Math.hypot(neighbor.x - point.x, neighbor.z - point.z) < 0.01
              )
                return [];
              return [Math.atan2(neighbor.z - point.z, neighbor.x - point.x)];
            },
          );
        }),
      )
      .sort((a, b) => a - b);
    let direction = Math.PI / 4;
    let largestGap = 0;
    angles.forEach((angle, index) => {
      const next = angles[index + 1] ?? angles[0]! + Math.PI * 2;
      if (next - angle > largestGap) {
        largestGap = next - angle;
        direction = angle + largestGap / 2;
      }
    });
    const distance =
      (junction.radius + 1) /
      Math.max(0.3, Math.sin(Math.min(Math.PI, largestGap) / 2));
    const x = junction.center.x + Math.cos(direction) * distance;
    const z = junction.center.z + Math.sin(direction) * distance;
    const y = connected.some((road) => road.bridge || road.tunnel)
      ? junction.center.y
      : sampleTerrainPlan(plan.terrain, x, z);
    return [{ id: junction.planId, x, y, z, names }];
  });
}

/** Camera-facing name boards remain readable from either approach. */
export function createRoadSigns(plan: WorldPlan): THREE.Group {
  const group = new THREE.Group();
  group.name = "Road name signs";
  for (const sign of roadSignLocations(plan)) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.font = "600 48px sans-serif";
    canvas.width = Math.min(
      2048,
      Math.max(
        256,
        Math.ceil(
          Math.max(
            ...sign.names.map((name) => context.measureText(name).width),
          ),
        ) + 48,
      ),
    );
    canvas.height = 72 * sign.names.length;
    context.font = "600 48px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    sign.names.forEach((name, index) => {
      context.fillStyle = "#146340";
      context.fillRect(0, index * 72, canvas.width, 68);
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.strokeRect(3, index * 72 + 3, canvas.width - 6, 62);
      context.fillStyle = "#ffffff";
      context.fillText(
        name,
        canvas.width / 2,
        index * 72 + 34,
        canvas.width - 32,
      );
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        toneMapped: false,
      }),
    );
    const height = sign.names.length * 0.65;
    board.scale.set((canvas.width / 72) * 0.65, height, 1);
    board.position.set(sign.x, sign.y + 3 + height / 2, sign.z);
    board.name = sign.names.join(" / ");
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0xaab4b8, roughness: 0.65 }),
    );
    pole.position.set(sign.x, sign.y + 1.5, sign.z);
    group.add(pole, board);
  }
  return group;
}

export function disposeRoadSigns(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    } else if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) material.dispose();
    }
  });
  group.removeFromParent();
}
