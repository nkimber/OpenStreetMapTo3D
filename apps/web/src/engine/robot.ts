import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Standing height in metres (about 100 feet). */
export const ROBOT_HEIGHT = 30;
const HIP_HEIGHT = 15.6;
/** Metres covered per footstep: long strides make slow limbs cover ground fast. */
export const ROBOT_STRIDE = 9.5;

export interface RobotRig {
  root: THREE.Group;
  hips: THREE.Group;
  waist: THREE.Group;
  head: THREE.Group;
  legs: { pivot: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[];
  arms: { shoulder: THREE.Group; elbow: THREE.Group }[];
  /** Per-robot armour, so a hit flash only lights this robot. */
  armor: THREE.MeshStandardMaterial;
  /** Local chest-core and eye positions, for beams and bolts. */
  coreOffset: THREE.Vector3;
  eyeOffset: THREE.Vector3;
}

/** Materials and unit shapes shared by every robot in a session. */
export class RobotKit {
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly hex = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  readonly taper = new THREE.CylinderGeometry(0.36, 0.5, 1, 6);
  readonly cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  readonly cone = new THREE.ConeGeometry(0.5, 1, 6);
  readonly sphere = new THREE.SphereGeometry(0.5, 14, 10);
  readonly armor = new THREE.MeshStandardMaterial({
    color: 0x4d545e,
    metalness: 0.45,
    roughness: 0.42,
  });
  readonly plate = new THREE.MeshStandardMaterial({
    color: 0x747b85,
    metalness: 0.4,
    roughness: 0.5,
  });
  readonly frame = new THREE.MeshStandardMaterial({
    color: 0x1e2228,
    metalness: 0.5,
    roughness: 0.62,
  });
  readonly rust = new THREE.MeshStandardMaterial({
    color: 0x8c2a1a,
    metalness: 0.3,
    roughness: 0.55,
  });
  readonly chrome = new THREE.MeshStandardMaterial({
    color: 0xc3c9cf,
    metalness: 0.6,
    roughness: 0.28,
  });
  /** Shared so every robot's eyes, core and vents pulse together. */
  readonly glow = new THREE.MeshBasicMaterial({
    color: 0xff2a12,
    toneMapped: false,
  });

  pulse(time: number): void {
    const heat = 0.72 + 0.28 * Math.sin(time * 3.1);
    this.glow.color.setRGB(1.6 * heat, 0.1 * heat, 0.04 * heat);
  }

  dispose(): void {
    for (const geometry of [
      this.box,
      this.hex,
      this.taper,
      this.cylinder,
      this.cone,
      this.sphere,
    ])
      geometry.dispose();
    for (const material of [
      this.armor,
      this.plate,
      this.frame,
      this.rust,
      this.chrome,
      this.glow,
    ])
      material.dispose();
  }
}

type Vec = [number, number, number];

function part(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  scale: Vec,
  position: Vec,
  rotation: Vec = [0, 0, 0],
): void {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  parent.add(mesh);
}

/**
 * Collapses a joint's static pieces into one mesh per material so a
 * ninety-part robot costs a few dozen draw calls instead of hundreds.
 */
function mergeParts(group: THREE.Group): void {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...group.children]) {
    if (!(child instanceof THREE.Mesh)) continue;
    child.updateMatrix();
    const geometry = (child.geometry as THREE.BufferGeometry).clone();
    geometry.applyMatrix4(child.matrix);
    const material = child.material as THREE.Material;
    byMaterial.set(material, [...(byMaterial.get(material) ?? []), geometry]);
    group.remove(child);
  }
  for (const [material, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/** A hulking, heavily armoured walker with a glowing visor and chest core. */
export function createRobot(kit: RobotKit): RobotRig {
  const armor = kit.armor.clone();
  const { box, hex, taper, cylinder, cone, sphere, plate, frame, rust } = kit;
  const { chrome, glow } = kit;
  const groups: THREE.Group[] = [];
  const group = (parent: THREE.Object3D, position: Vec) => {
    const item = new THREE.Group();
    item.position.set(...position);
    parent.add(item);
    groups.push(item);
    return item;
  };

  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const hips = group(root, [0, HIP_HEIGHT, 0]);
  part(hips, box, plate, [5.8, 2.3, 3.8], [0, 0, 0]);
  part(hips, hex, frame, [2.2, 2, 2.2], [0, -1.1, 0]);
  for (const side of [-1, 1])
    part(
      hips,
      box,
      armor,
      [2.3, 2.6, 0.45],
      [side * 1.45, -1.5, -2],
      [0.18, 0, 0],
    );
  part(hips, box, rust, [5.9, 0.35, 3.9], [0, 0.9, 0]);

  const legs = [-1, 1].map((side) => {
    const pivot = group(hips, [side * 3.2, -0.6, 0]);
    part(pivot, sphere, frame, [2.5, 2.5, 2.5], [0, 0, 0]);
    part(pivot, taper, armor, [2.8, 6.8, 3], [0, -3.7, 0], [Math.PI, 0, 0]);
    part(pivot, box, plate, [2.3, 4.4, 0.5], [0, -3.3, -1.6], [-0.08, 0, 0]);
    part(pivot, box, plate, [0.5, 4, 2], [side * 1.45, -3.6, 0]);
    part(pivot, cylinder, chrome, [0.38, 5.6, 0.38], [0, -3.7, 1.7]);
    const knee = group(pivot, [0, -7.4, 0]);
    part(knee, sphere, frame, [2.3, 2.3, 2.3], [0, 0, 0]);
    part(knee, box, plate, [1.9, 1.9, 1.1], [0, 0.2, -1.35], [0.3, 0, 0]);
    part(
      knee,
      cone,
      rust,
      [0.75, 1.8, 0.75],
      [0, 0.45, -2.2],
      [-Math.PI / 2, 0, 0],
    );
    part(knee, taper, armor, [2.5, 6.3, 2.7], [0, -3.3, 0]);
    part(knee, box, plate, [2.1, 4.6, 0.5], [0, -3.1, -1.4]);
    part(knee, cylinder, chrome, [0.36, 4.9, 0.36], [0, -3.2, 1.55]);
    part(knee, box, glow, [0.22, 3.2, 0.18], [side * 1.3, -3.2, -1.1]);
    const ankle = group(knee, [0, -6.6, 0]);
    part(ankle, sphere, frame, [1.7, 1.7, 1.7], [0, 0, 0]);
    part(ankle, box, armor, [3.4, 1.15, 5.4], [0, -0.72, -0.9]);
    part(ankle, box, plate, [2.6, 0.5, 3.2], [0, -0.05, -1.4], [0.12, 0, 0]);
    for (const toe of [-1.05, 0, 1.05])
      part(
        ankle,
        cone,
        rust,
        [0.72, 1.7, 0.72],
        [toe, -0.85, -4.1],
        [-Math.PI / 2, 0, 0],
      );
    part(ankle, box, frame, [1.5, 0.85, 1.5], [0, -0.7, 2]);
    return { pivot, knee, ankle };
  });

  const waist = group(hips, [0, 1.4, 0]);
  part(waist, hex, frame, [2.4, 2.6, 2.4], [0, 0.8, 0]);
  part(waist, box, plate, [4.6, 0.9, 3.2], [0, 0.35, 0]);
  part(waist, box, plate, [4.1, 0.9, 3], [0, 1.35, 0]);
  const chest = group(waist, [0, 2.2, 0]);
  part(chest, box, armor, [9.4, 6.6, 5.4], [0, 3.6, 0]);
  part(chest, box, armor, [7.6, 2.4, 4.6], [0, 0.6, 0]);
  for (const side of [-1, 1]) {
    part(
      chest,
      box,
      plate,
      [4.3, 4.7, 0.7],
      [side * 2.35, 4.2, -2.85],
      [0.08, side * -0.16, 0],
    );
    part(chest, box, glow, [0.26, 3.6, 0.2], [side * 4.5, 3.4, -2.3]);
    part(chest, box, rust, [0.9, 0.35, 5.5], [side * 4.3, 6.4, 0]);
    part(chest, cylinder, frame, [1.15, 5.2, 1.15], [side * 2.1, 7.6, 2.7]);
    part(chest, cylinder, glow, [0.75, 0.3, 0.75], [side * 2.1, 10.2, 2.7]);
    part(chest, box, frame, [0.3, 2.6, 2.6], [side * 4.75, 3.4, 0.9]);
  }
  part(
    chest,
    cylinder,
    frame,
    [3, 0.6, 3],
    [0, 3.4, -3.35],
    [Math.PI / 2, 0, 0],
  );
  part(
    chest,
    cylinder,
    glow,
    [2.1, 0.6, 2.1],
    [0, 3.4, -3.6],
    [Math.PI / 2, 0, 0],
  );
  part(chest, box, frame, [6.2, 1.3, 4.2], [0, 7.2, 0]);
  for (let index = 0; index < 3; index += 1)
    part(
      chest,
      cone,
      rust,
      [0.85, 2.2, 0.85],
      [0, 1.8 + index * 1.7, 3.1],
      [Math.PI / 2, 0, 0],
    );

  // Chest grille, side ribs and a back power pack with cables to the arms.
  for (let slat = 0; slat < 4; slat += 1)
    part(chest, box, glow, [5.2, 0.16, 0.2], [0, -0.1 + slat * 0.42, -2.35]);
  for (const side of [-1, 1]) {
    for (let rib = 0; rib < 3; rib += 1)
      part(
        chest,
        box,
        plate,
        [0.45, 0.8, 3.8],
        [side * 4.85, 1.6 + rib * 1.35, 0.2],
        [0, 0, side * 0.12],
      );
    part(
      chest,
      cylinder,
      frame,
      [0.4, 6.4, 0.4],
      [side * 3.9, 6.6, 3],
      [0, 0, side * 1.05],
    );
  }
  part(chest, box, frame, [6.4, 5.2, 2.4], [0, 4.4, 3.6]);
  part(chest, box, plate, [5.4, 0.5, 2.6], [0, 7.1, 3.6]);
  for (let vent = 0; vent < 3; vent += 1)
    part(chest, box, glow, [4.2, 0.18, 0.2], [0, 3 + vent * 0.9, 4.85]);

  const head = group(chest, [0, 7.1, -0.9]);
  part(head, hex, frame, [1.7, 1.6, 1.7], [0, 0.6, 0]);
  part(head, box, armor, [3.7, 3.1, 4.1], [0, 2.45, 0]);
  for (const side of [-1, 1]) {
    // Angled brow plates form a scowling V over the visor.
    part(
      head,
      box,
      plate,
      [2.3, 0.8, 1.5],
      [side * 1, 3.25, -1.85],
      [0.38, 0, side * 0.32],
    );
    part(
      head,
      cone,
      chrome,
      [0.42, 1.5, 0.42],
      [side * 0.95, 0.45, -1.95],
      [Math.PI, 0, 0],
    );
  }
  part(head, box, glow, [3.1, 0.36, 0.3], [0, 2.6, -2.08]);
  for (const side of [-1, 1]) {
    part(head, box, glow, [0.72, 0.5, 0.36], [side * 0.9, 2.64, -2.13]);
    part(
      head,
      cone,
      rust,
      [0.55, 3.1, 0.55],
      [side * 1.45, 4.6, 0.6],
      [0, 0, side * -0.38],
    );
    part(head, box, plate, [0.4, 2.2, 3.2], [side * 1.95, 2.3, 0.2]);
  }
  part(head, box, frame, [2.9, 1.15, 2.9], [0, 1, -0.6]);
  for (let index = -1; index <= 1; index += 1)
    part(head, box, glow, [0.18, 0.7, 0.12], [index * 0.55, 0.95, -2.08]);
  part(head, cylinder, chrome, [0.13, 3.6, 0.13], [1.2, 5.1, 1.2]);
  part(head, sphere, glow, [0.4, 0.4, 0.4], [1.2, 6.95, 1.2]);

  const arms = [-1, 1].map((side) => {
    const shoulder = group(chest, [side * 6.3, 6.2, 0]);
    part(shoulder, sphere, frame, [2.7, 2.7, 2.7], [0, 0, 0]);
    part(
      shoulder,
      box,
      armor,
      [3.9, 2.5, 4.6],
      [side * 0.6, 1.25, 0],
      [0, 0, side * -0.25],
    );
    part(
      shoulder,
      box,
      rust,
      [4, 0.3, 4.7],
      [side * 0.75, 2.45, 0],
      [0, 0, side * -0.25],
    );
    for (const z of [-1.1, 1.1])
      part(
        shoulder,
        cone,
        rust,
        [0.85, 2.8, 0.85],
        [side * 1.3, 2.9, z],
        [0, 0, side * -0.5],
      );
    part(
      shoulder,
      taper,
      armor,
      [2.1, 5.8, 2.1],
      [0, -3.3, 0],
      [Math.PI, 0, 0],
    );
    part(shoulder, cylinder, chrome, [0.32, 4.6, 0.32], [side * 1.25, -3.1, 0]);
    part(
      shoulder,
      box,
      plate,
      [3.2, 1.6, 3.9],
      [side * 1.3, 0.2, 0],
      [0, 0, side * -0.55],
    );
    const elbow = group(shoulder, [0, -6.4, 0]);
    part(elbow, sphere, frame, [1.9, 1.9, 1.9], [0, 0, 0]);
    part(elbow, taper, armor, [2.5, 5.4, 2.5], [0, -2.9, 0]);
    part(elbow, box, plate, [0.45, 5, 1.7], [side * 1.35, -2.9, 0.4]);
    part(elbow, box, glow, [0.2, 3.4, 0.2], [side * -1.2, -2.9, -0.6]);
    for (let ridge = 0; ridge < 3; ridge += 1)
      part(
        elbow,
        box,
        armor,
        [2.7, 0.35, 2.7],
        [0, -1.4 - ridge * 1.3, 0],
        [0, Math.PI / 4, 0],
      );
    part(elbow, box, frame, [1.9, 1.5, 1.7], [0, -6, 0]);
    for (const finger of [-0.62, 0, 0.62])
      part(
        elbow,
        box,
        rust,
        [0.36, 2.4, 0.36],
        [finger, -7.6, -0.45],
        [-0.35, 0, 0],
      );
    part(
      elbow,
      box,
      rust,
      [0.4, 1.8, 0.4],
      [side * -0.85, -7, 0.1],
      [0, 0, side * 0.55],
    );
    if (side === 1) {
      // Arm cannon: the source of the laser that fires at the helicopter.
      part(elbow, cylinder, frame, [1, 3.6, 1], [0, -4.4, -1.6], [0.2, 0, 0]);
      part(
        elbow,
        cylinder,
        glow,
        [0.55, 0.3, 0.55],
        [0, -6.2, -1.95],
        [0.2, 0, 0],
      );
    }
    return { shoulder, elbow };
  });

  groups.forEach(mergeParts);
  return {
    root,
    hips,
    waist,
    head,
    legs,
    arms,
    armor,
    // Measured with the walking hunch applied (about 0.2 rad at the waist).
    coreOffset: new THREE.Vector3(0, HIP_HEIGHT + 6.9, -4.3),
    eyeOffset: new THREE.Vector3(0, HIP_HEIGHT + 13, -5.3),
  };
}

/**
 * Poses a walking robot. `phase` advances one full cycle per two strides,
 * so the limbs swing slowly while the body covers ground quickly.
 */
export function poseWalk(rig: RobotRig, phase: number, blend: number): void {
  rig.legs.forEach(({ pivot, knee, ankle }, index) => {
    const leg = phase + index * Math.PI;
    const swing = Math.sin(leg) * 0.42 * blend;
    const lift = Math.max(0, Math.cos(leg)) * 0.75 * blend;
    pivot.rotation.x = swing;
    knee.rotation.x = -lift;
    ankle.rotation.x = -swing + lift * 0.55;
  });
  rig.arms.forEach(({ shoulder, elbow }, index) => {
    const arm = phase + (index + 1) * Math.PI;
    shoulder.rotation.x = Math.sin(arm) * 0.32 * blend;
    shoulder.rotation.z = (index ? -1 : 1) * 0.12;
    elbow.rotation.x = -0.35 - Math.max(0, Math.sin(arm)) * 0.35 * blend;
  });
  rig.hips.position.y = HIP_HEIGHT - Math.abs(Math.sin(phase)) * 0.9 * blend;
  rig.waist.rotation.y = Math.sin(phase) * 0.1 * blend;
  rig.waist.rotation.z = Math.sin(phase) * 0.035 * blend;
  // A permanent forward hunch reads as menacing at this scale.
  rig.waist.rotation.x = 0.16 + 0.04 * blend;
}

/** Arms raised toward the target, chest thrust forward, while attacking. */
export function poseAttack(rig: RobotRig, time: number): void {
  rig.legs.forEach(({ pivot, knee, ankle }, index) => {
    pivot.rotation.x = index ? -0.18 : 0.22;
    knee.rotation.x = -0.25;
    ankle.rotation.x = index ? 0.3 : -0.1;
  });
  rig.arms.forEach(({ shoulder, elbow }, index) => {
    shoulder.rotation.x = -1.25 + Math.sin(time * 2 + index) * 0.08;
    shoulder.rotation.z = (index ? -1 : 1) * 0.3;
    elbow.rotation.x = -0.5;
  });
  rig.hips.position.y = HIP_HEIGHT - 0.8;
  rig.waist.rotation.set(0.22 + Math.sin(time * 5) * 0.02, 0, 0);
}

export function disposeRobot(rig: RobotRig): void {
  rig.root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  rig.armor.dispose();
}
