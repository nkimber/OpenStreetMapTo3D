import type { RaceCourse } from "@osm3d/simulation";
import { sampleRaceRoute } from "@osm3d/simulation";
import * as THREE from "three";

interface RaceGate {
  distance: number;
  root: THREE.Object3D;
}

export interface RaceScene {
  root: THREE.Group;
  lightMaterials: THREE.MeshStandardMaterial[];
  gates: RaceGate[];
  arrows: Array<{ distance: number; root: THREE.Object3D }>;
}

export interface RaceSceneOptions {
  roadClosures?: boolean;
}

function routeDirection(course: RaceCourse, distance: number): THREE.Vector3 {
  const before = sampleRaceRoute(course, Math.max(0, distance - 2));
  const after = sampleRaceRoute(course, Math.min(course.length, distance + 2));
  return new THREE.Vector3(
    after.x - before.x,
    0,
    after.z - before.z,
  ).normalize();
}

function routeYaw(course: RaceCourse, distance: number): number {
  const direction = routeDirection(course, distance);
  return Math.atan2(-direction.x, -direction.z);
}

function routePitch(course: RaceCourse, distance: number): number {
  const before = sampleRaceRoute(course, Math.max(0, distance - 2));
  const after = sampleRaceRoute(course, Math.min(course.length, distance + 2));
  return Math.atan2(
    after.y - before.y,
    Math.hypot(after.x - before.x, after.z - before.z),
  );
}

function checkerTexture(): THREE.DataTexture {
  const width = 8;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = (x + y) % 2 === 0 ? 245 : 12;
      const offset = (y * width + x) * 4;
      data[offset] = color;
      data[offset + 1] = color;
      data[offset + 2] = color;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function addGantry(
  root: THREE.Group,
  course: RaceCourse,
): THREE.MeshStandardMaterial[] {
  const start = course.points[0]!;
  const width = Math.max(6.5, Math.min(10, course.roadWidth + 1.5));
  const gantry = new THREE.Group();
  gantry.position.set(start.x, start.y + 0.08, start.z);
  gantry.rotation.y = routeYaw(course, 0);
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x171a1e,
    metalness: 0.65,
    roughness: 0.3,
  });
  const postGeometry = new THREE.BoxGeometry(0.22, 4.3, 0.22);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeometry, frameMaterial);
    post.position.set((width / 2) * side, 2.15, 0);
    post.castShadow = true;
    gantry.add(post);
  }
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.4, 0.36, 0.36),
    frameMaterial,
  );
  bar.position.y = 4.18;
  bar.castShadow = true;
  gantry.add(bar);

  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(3.9, 1.25, 0.28),
    frameMaterial,
  );
  panel.position.set(0, 3.55, 0.05);
  gantry.add(panel);
  const lightMaterials = Array.from(
    { length: 3 },
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x401010,
        emissive: 0x160000,
        emissiveIntensity: 0.25,
        roughness: 0.25,
      }),
  );
  lightMaterials.forEach((material, index) => {
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 20, 14),
      material,
    );
    light.scale.z = 0.38;
    light.position.set((index - 1) * 1.12, 3.55, 0.24);
    gantry.add(light);
  });
  root.add(gantry);
  return lightMaterials;
}

function addStartGrid(root: THREE.Group, course: RaceCourse): void {
  const start = course.points[0]!;
  const direction = routeDirection(course, 0);
  const length = course.roadWidth >= 6.5 ? 14 : 24;
  const width = Math.max(3.8, Math.min(9, course.roadWidth * 0.94));
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.035, length),
    new THREE.MeshStandardMaterial({
      map: checkerTexture(),
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  floor.position.set(
    start.x - direction.x * (length / 2 - 0.25),
    start.y + 0.1,
    start.z - direction.z * (length / 2 - 0.25),
  );
  floor.rotation.set(routePitch(course, 0), routeYaw(course, 0), 0, "YXZ");
  floor.receiveShadow = true;
  root.add(floor);
}

function addGate(
  root: THREE.Group,
  course: RaceCourse,
  distance: number,
): RaceGate {
  const point = sampleRaceRoute(course, distance);
  const radius = Math.max(2.5, Math.min(5, course.roadWidth * 0.58));
  const material = new THREE.MeshStandardMaterial({
    color: 0x34e3c2,
    emissive: 0x087969,
    emissiveIntensity: 1.1,
    roughness: 0.3,
  });
  const arch = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.16, 10, 36, Math.PI),
    material,
  );
  arch.position.set(point.x, point.y + 0.08, point.z);
  arch.rotation.y = routeYaw(course, distance);
  arch.castShadow = true;
  root.add(arch);
  return { distance, root: arch };
}

function addRoadClosures(root: THREE.Group, course: RaceCourse): void {
  for (const barrier of course.barriers) {
    const group = new THREE.Group();
    group.position.set(barrier.x, barrier.y + 0.55, barrier.z);
    group.rotation.y = barrier.yaw;
    for (let index = -2; index <= 2; index += 1) {
      const segment = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.38, 0.16),
        new THREE.MeshStandardMaterial({
          color: index % 2 === 0 ? 0xf4f1e8 : 0xe13c32,
          roughness: 0.62,
        }),
      );
      segment.position.x = index * 0.9;
      segment.castShadow = true;
      group.add(segment);
    }
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 1.1, 0.16),
        new THREE.MeshStandardMaterial({ color: 0x2c3135 }),
      );
      foot.position.set(side * 1.8, -0.35, 0);
      group.add(foot);
    }
    root.add(group);
  }
}

export function createRaceScene(
  course: RaceCourse,
  options: RaceSceneOptions = {},
): RaceScene {
  const root = new THREE.Group();
  root.name = "race-scene";
  addStartGrid(root, course);
  const lightMaterials = addGantry(root, course);
  if (options.roadClosures ?? true) addRoadClosures(root, course);
  const gates = course.checkpointDistances
    .slice(0, -1)
    .map((distance) => addGate(root, course, distance));
  const arrows = course.turnDistances.map((distance) => {
    const point = sampleRaceRoute(course, distance);
    const direction = routeDirection(course, distance + 6);
    const arrow = new THREE.ArrowHelper(
      direction,
      new THREE.Vector3(point.x, point.y + 3.3, point.z),
      6,
      0xffc928,
      1.8,
      1.1,
    );
    root.add(arrow);
    return { distance, root: arrow };
  });
  return { root, lightMaterials, gates, arrows };
}

export function updateRaceScene(
  scene: RaceScene,
  lights: number,
  progress: number,
  checkpointIndex: number,
): void {
  scene.lightMaterials.forEach((material, index) => {
    const active = index < lights;
    material.color.setHex(active ? 0xff2929 : 0x401010);
    material.emissive.setHex(active ? 0xff0505 : 0x160000);
    material.emissiveIntensity = active ? 2.8 : 0.25;
  });
  scene.gates.forEach((gate, index) => {
    gate.root.visible = index >= checkpointIndex && index < checkpointIndex + 3;
  });
  scene.arrows.forEach((arrow) => {
    arrow.root.visible =
      arrow.distance > progress - 12 && arrow.distance < progress + 150;
  });
}

export function disposeRaceScene(scene: RaceScene): void {
  scene.root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    renderable.geometry?.dispose();
    if (!renderable.material) return;
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial)
        material.map?.dispose();
      material.dispose();
    }
  });
}
