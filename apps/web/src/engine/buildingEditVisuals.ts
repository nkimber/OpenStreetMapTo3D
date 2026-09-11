import * as THREE from "three";
import {
  openingWidth,
  type BuildingCustomization,
  type WorldDefinition,
} from "@osm3d/contracts";
import type { BuildingPlan, LocalPoint2, WorldPlan } from "@osm3d/worldgen";
import { openingPosition, routeHeight, toLocal } from "./buildingEdits.js";

export function customizedPlan(
  building: BuildingPlan,
  value?: BuildingCustomization,
): BuildingPlan {
  if (!value) return building;
  const tags = { ...building.appearanceTags };
  if (value.appearance.roof) tags["roof:shape"] = value.appearance.roof;
  if (value.appearance.wallColor)
    tags["building:colour"] = value.appearance.wallColor;
  if (value.appearance.roofColor)
    tags["roof:colour"] = value.appearance.roofColor;
  if (value.appearance.material)
    tags["building:material"] = value.appearance.material;
  return { ...building, appearanceTags: tags };
}

export function openingPanels(
  value: BuildingCustomization | undefined,
  definition: WorldDefinition,
) {
  return (value?.openings ?? []).map((opening) => ({
    ...openingPosition(opening, definition),
    kind: opening.kind,
    width: openingWidth(opening),
    height:
      opening.kind === "window" ? 1.3 : opening.kind === "garage" ? 2.3 : 2.1,
    sill: opening.kind === "window" ? opening.sill : 0,
  }));
}

export function createCustomizationVisual(
  building: BuildingPlan,
  value: BuildingCustomization,
  definition: WorldDefinition,
  plan: WorldPlan,
  editing: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "Building customizations";
  const addMesh = (geometry: THREE.BufferGeometry, color: number) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    mesh.userData.sourceId = building.sourceId;
    mesh.userData.featureKind = "building";
    group.add(mesh);
    return mesh;
  };
  const handle = (
    point: LocalPoint2,
    y: number,
    data: Record<string, unknown>,
  ) => {
    if (!editing) return;
    const mesh = addMesh(new THREE.SphereGeometry(0.3, 12, 8), 0xffc04a);
    mesh.position.set(point.x, y, point.z);
    mesh.material.depthTest = false;
    mesh.material.emissive.setHex(0xffc04a);
    mesh.renderOrder = 10;
    Object.assign(mesh.userData, data);
  };
  openingPanels(value, definition).forEach((panel, index) => {
    const opening = value.openings[index]!;
    const y = building.baseHeight + 0.04 + panel.sill + panel.height / 2;
    const normal = { x: -panel.dz, z: panel.dx };
    // A thin panel on each face avoids winding-dependent placement.
    for (const side of [-1, 1]) {
      const frame = addMesh(
        new THREE.PlaneGeometry(panel.width + 0.12, panel.height + 0.12),
        0xf0e9da,
      );
      frame.rotation.y = Math.atan2(normal.x, normal.z);
      frame.position.set(
        panel.x + normal.x * 0.065 * side,
        y,
        panel.z + normal.z * 0.065 * side,
      );
      const face = addMesh(
        new THREE.PlaneGeometry(panel.width, panel.height),
        opening.kind === "garage"
          ? 0xa9aaa2
          : opening.kind === "window"
            ? 0x3f6c83
            : 0x614b37,
      );
      face.rotation.y = frame.rotation.y;
      face.position.set(
        panel.x + normal.x * 0.08 * side,
        y,
        panel.z + normal.z * 0.08 * side,
      );
      face.userData.openingId = opening.id;
      if (opening.kind === "garage") {
        for (let row = 1; row <= 4; row++) {
          const seam = addMesh(
            new THREE.PlaneGeometry(panel.width - 0.05, 0.025),
            0x727870,
          );
          seam.rotation.copy(face.rotation);
          seam.position
            .copy(face.position)
            .add(
              new THREE.Vector3(
                normal.x * 0.003 * side,
                -panel.height / 2 + (panel.height * row) / 5,
                normal.z * 0.003 * side,
              ),
            );
        }
      }
    }
    handle(panel, y, { openingId: opening.id });
    if (opening.path.length >= 2) {
      const points = [
        panel,
        ...opening.path.slice(1).map((point) => toLocal(point, definition)),
      ];
      const width = opening.kind === "garage" ? openingWidth(opening) : 1.2;
      const vertices: number[] = [];
      points.slice(1).forEach((b, index) => {
        const a = points[index]!;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 0.01) return;
        const nx = ((-(b.z - a.z) / length) * width) / 2,
          nz = (((b.x - a.x) / length) * width) / 2;
        const steps = Math.ceil(length / 0.5);
        const station = (t: number, side: number) => {
          const p = {
            x: a.x + (b.x - a.x) * t + nx * side,
            z: a.z + (b.z - a.z) * t + nz * side,
          };
          const distanceFromDoor = Math.hypot(
            a.x + (b.x - a.x) * t - panel.x,
            a.z + (b.z - a.z) * t - panel.z,
          );
          const apronBlend = Math.max(
            0,
            1 - distanceFromDoor / Math.max(4, width),
          );
          const terrain = routeHeight(p, plan);
          return [
            p.x,
            Math.max(
              terrain,
              terrain + (building.baseHeight + 0.04 - terrain) * apronBlend,
            ),
            p.z,
          ];
        };
        for (let i = 0; i < steps; i++) {
          const aLeft = station(i / steps, -1),
            aRight = station(i / steps, 1),
            bLeft = station((i + 1) / steps, -1),
            bRight = station((i + 1) / steps, 1);
          vertices.push(
            ...aLeft,
            ...aRight,
            ...bRight,
            ...aLeft,
            ...bRight,
            ...bLeft,
          );
        }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.computeVertexNormals();
      const mesh = addMesh(
        geometry,
        opening.kind === "garage" ? 0xa7a59d : 0xc1b399,
      );
      mesh.receiveShadow = true;
      mesh.userData.route = true;
      points.slice(1).forEach((point, index) =>
        handle(point, routeHeight(point, plan) + 0.3, {
          openingId: opening.id,
          routeIndex: index + 1,
        }),
      );
    }
  });
  value.boundaries.forEach((boundary) => {
    const points = boundary.points.map((point) => toLocal(point, definition));
    const height = boundary.kind === "garden" ? 0.4 : 1.2;
    points.slice(1).forEach((b, index) => {
      const a = points[index]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length / 1.5));
      for (let i = 0; i < steps; i++) {
        const p = {
          x: a.x + ((b.x - a.x) * (i + 0.5)) / steps,
          z: a.z + ((b.z - a.z) * (i + 0.5)) / steps,
        };
        const mesh = addMesh(
          new THREE.BoxGeometry(
            length / steps,
            height,
            boundary.kind === "garden" ? 0.45 : 0.09,
          ),
          boundary.kind === "garden"
            ? 0x497343
            : boundary.kind === "gate"
              ? 0x697c7a
              : 0x987957,
        );
        mesh.position.set(p.x, routeHeight(p, plan) + height / 2, p.z);
        mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      }
    });
    points.forEach((point, index) =>
      handle(point, routeHeight(point, plan) + height, {
        boundaryId: boundary.id,
        boundaryIndex: index,
      }),
    );
  });
  return group;
}
