import * as THREE from "three";

/** Seconds for the car ⇄ helicopter transformation, kept short so play resumes quickly. */
export const TRANSFORM_SECONDS = 1.6;
export const MAX_FLIGHT_ALTITUDE = 320;
const MAX_FORWARD_SPEED = 42;
const MAX_REVERSE_SPEED = 14;
const MAX_CLIMB_SPEED = 9;
const MAX_YAW_RATE = 1.5;

export type FlightForm = "car" | "rising" | "flying" | "landing";

export interface FlightInput {
  /** -1 (back) … 1 (forward). */
  forward: number;
  /** -1 (right) … 1 (left). */
  yaw: number;
  /** -1 (descend) … 1 (climb). */
  lift: number;
}

export interface FlightState {
  velocity: { x: number; y: number; z: number };
  yaw: number;
  yawRate: number;
  pitch: number;
  roll: number;
}

export const neutralFlightInput: FlightInput = { forward: 0, yaw: 0, lift: 0 };

export function createFlightState(yaw = 0): FlightState {
  return { velocity: { x: 0, y: 0, z: 0 }, yaw, yawRate: 0, pitch: 0, roll: 0 };
}

const approach = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));

/**
 * Arcade flight: the helicopter hovers by itself, levels out when no keys are
 * held, and tilts into movement purely for show. Forward is -Z at yaw 0.
 */
export function stepFlight(
  state: FlightState,
  input: FlightInput,
  dt: number,
): FlightState {
  const forward = clamp(input.forward);
  const yawInput = clamp(input.yaw);
  const lift = clamp(input.lift);
  const yawRate = approach(state.yawRate, yawInput * MAX_YAW_RATE, 4, dt);
  const yaw = state.yaw + yawRate * dt;
  const heading = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const targetSpeed =
    forward >= 0 ? forward * MAX_FORWARD_SPEED : forward * MAX_REVERSE_SPEED;
  const velocity = {
    x: approach(state.velocity.x, heading.x * targetSpeed, 1.1, dt),
    y: approach(state.velocity.y, lift * MAX_CLIMB_SPEED, 2.4, dt),
    z: approach(state.velocity.z, heading.z * targetSpeed, 1.1, dt),
  };
  return {
    velocity,
    yaw,
    yawRate,
    pitch: approach(state.pitch, -forward * 0.26, 3, dt),
    roll: approach(state.roll, yawRate * 0.2, 3, dt),
  };
}

export function flightAirspeedKph(state: FlightState): number {
  const { x, y, z } = state.velocity;
  return Math.hypot(x, y, z) * 3.6;
}

export function headingDegrees(yaw: number): number {
  // Yaw 0 faces -Z, which the map treats as north.
  return Math.round((((-yaw * 180) / Math.PI) % 360) + 360) % 360;
}

/** Steers back toward the map when outside it; returns true while doing so. */
export function boundaryPush(
  state: FlightState,
  position: { x: number; z: number },
  bounds: {
    centerX: number;
    centerZ: number;
    halfWidth: number;
    halfDepth: number;
  },
  dt: number,
): boolean {
  const dx = position.x - bounds.centerX;
  const dz = position.z - bounds.centerZ;
  const overX = Math.abs(dx) - bounds.halfWidth;
  const overZ = Math.abs(dz) - bounds.halfDepth;
  if (overX <= 0 && overZ <= 0) return false;
  if (overX > 0) state.velocity.x -= Math.sign(dx) * (6 + overX) * dt * 4;
  if (overZ > 0) state.velocity.z -= Math.sign(dz) * (6 + overZ) * dt * 4;
  return true;
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

const smooth = (from: number, to: number, t: number) =>
  THREE.MathUtils.smoothstep(t, from, to);

export interface HelicopterKit {
  root: THREE.Group;
  /** Left and right rocket launch points. */
  muzzles: THREE.Object3D[];
  setColor(color: string): void;
  /** progress: 0 = car, 1 = helicopter. rotorSpeed: 0…1. */
  update(progress: number, rotorSpeed: number, deltaSeconds: number): void;
  /** How far the wheels are folded away (0…1) for a given progress. */
  wheelFold(progress: number): number;
  dispose(): void;
}

/** Rotor, tail and skids built from simple shapes that unfold out of the car. */
export function createHelicopterKit(color: string): HelicopterKit {
  const root = new THREE.Group();
  root.name = "helicopter-kit";
  const paint = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.25,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0x2b2f35,
    roughness: 0.55,
    metalness: 0.6,
  });
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const item = new THREE.Mesh(geometry, material);
    item.castShadow = true;
    return item;
  };

  // Mast telescopes up from the roof.
  const mast = new THREE.Group();
  mast.position.set(0, 0.45, 0.1);
  const mastTube = mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.9, 10), metal);
  mastTube.position.y = 0.45;
  mast.add(mastTube);
  root.add(mast);

  const rotor = new THREE.Group();
  rotor.position.set(0, 1.38, 0.1);
  rotor.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 12), metal));
  const bladeGeometry = new THREE.BoxGeometry(4.6, 0.04, 0.3);
  bladeGeometry.translate(2.3, 0, 0);
  const blades = [0, 1, 2, 3].map((index) => {
    const pivot = new THREE.Group();
    pivot.userData.base = (index * Math.PI) / 2;
    pivot.add(mesh(bladeGeometry, metal));
    rotor.add(pivot);
    return pivot;
  });
  root.add(rotor);

  // Tail boom slides out of the back of the car.
  const boom = new THREE.Group();
  boom.position.set(0, 0.15, 1.7);
  const boomGeometry = new THREE.CylinderGeometry(0.12, 0.22, 3.6, 10);
  boomGeometry.rotateX(Math.PI / 2);
  boomGeometry.translate(0, 0, 1.8);
  boom.add(mesh(boomGeometry, paint));
  const fin = mesh(new THREE.BoxGeometry(0.06, 0.8, 0.5), paint);
  fin.position.set(0, 0.35, 3.45);
  boom.add(fin);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.16, 0.35, 3.45);
  const tailBladeGeometry = new THREE.BoxGeometry(0.03, 1.1, 0.12);
  tailRotor.add(mesh(tailBladeGeometry, metal));
  const crossBlade = mesh(tailBladeGeometry, metal);
  crossBlade.rotation.x = Math.PI / 2;
  tailRotor.add(crossBlade);
  boom.add(tailRotor);
  root.add(boom);

  // Skids drop from where the wheels tuck away.
  const skids = new THREE.Group();
  const skidGeometry = new THREE.CylinderGeometry(0.06, 0.06, 3.3, 8);
  skidGeometry.rotateX(Math.PI / 2);
  const strutGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6);
  for (const side of [-1, 1]) {
    const skid = mesh(skidGeometry, metal);
    skid.position.set(side * 0.85, -0.55, 0);
    skids.add(skid);
    for (const z of [-0.9, 0.9]) {
      const strut = mesh(strutGeometry, metal);
      strut.position.set(side * 0.82, -0.42, z);
      skids.add(strut);
    }
  }
  root.add(skids);

  // Rocket pods ride on the skid struts; rockets leave from their muzzles.
  const podGeometry = new THREE.CylinderGeometry(0.16, 0.16, 1.2, 10);
  podGeometry.rotateX(Math.PI / 2);
  const muzzles = [-1, 1].map((side) => {
    const pod = mesh(podGeometry, metal);
    pod.position.set(side * 1.15, -0.2, -0.2);
    skids.add(pod);
    const pylon = mesh(new THREE.BoxGeometry(0.3, 0.06, 0.4), metal);
    pylon.position.set(side * 0.98, -0.15, -0.2);
    skids.add(pylon);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(side * 1.15, -0.2, -0.9);
    skids.add(muzzle);
    return muzzle;
  });

  let rotorAngle = 0;
  const kit: HelicopterKit = {
    root,
    muzzles,
    setColor(next) {
      paint.color.set(next);
    },
    wheelFold: (progress) => smooth(0, 0.25, progress),
    update(progress, rotorSpeed, deltaSeconds) {
      root.visible = progress > 0.001;
      if (!root.visible) return;
      const extend = smooth(0.2, 0.55, progress);
      const unfold = smooth(0.5, 0.8, progress);
      mast.scale.set(1, Math.max(0.001, extend), 1);
      rotor.position.y = 0.48 + 0.9 * extend;
      rotor.visible = extend > 0.05;
      boom.scale.set(1, 1, Math.max(0.001, extend));
      skids.visible = progress > 0.2;
      skids.position.y = 0.25 * (1 - extend);
      skids.scale.setScalar(Math.max(0.001, extend));
      for (const blade of blades)
        blade.rotation.y = THREE.MathUtils.lerp(
          -Math.PI / 2,
          blade.userData.base as number,
          unfold,
        );
      tailRotor.scale.setScalar(Math.max(0.001, unfold));
      rotorAngle += rotorSpeed * 28 * deltaSeconds;
      rotor.rotation.y = rotorAngle;
      tailRotor.rotation.x = rotorAngle * 1.6;
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      paint.dispose();
      metal.dispose();
    },
  };
  kit.update(0, 0, 0);
  return kit;
}
