import type { BuildingPlan } from "@osm3d/worldgen";
import * as THREE from "three";

export const ROCKET_SPEED = 115;
export const ROCKET_COOLDOWN_SECONDS = 0.3;
const ROCKET_LIFETIME = 3;
const DEBRIS_GRAVITY = 20;
const MAX_DEBRIS = 700;
const MAX_PUFFS = 320;

export interface Rocket {
  mesh: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  age: number;
  puffTimer: number;
}

interface Puff {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  velocity: THREE.Vector3;
  age: number;
  life: number;
  startScale: number;
  endScale: number;
  startOpacity: number;
  delay: number;
}

interface Debris {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  delay: number;
  age: number;
  life: number;
  resting: boolean;
}

interface Flash {
  light: THREE.PointLight;
  age: number;
  life: number;
  intensity: number;
}

export interface FootprintSample {
  x: number;
  z: number;
}

/** Even-odd test against the outer ring and any courtyard holes. */
export function insideFootprint(
  building: Pick<BuildingPlan, "rings">,
  point: FootprintSample,
): boolean {
  let inside = false;
  for (const ring of building.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (
        a.z > point.z !== b.z > point.z &&
        point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
      )
        inside = !inside;
    }
  }
  return inside;
}

/** Grid cells inside the footprint, stacked in floors, that become debris. */
export function debrisCells(
  building: Pick<BuildingPlan, "rings" | "height" | "baseHeight">,
  maxPieces = 150,
): { center: THREE.Vector3; size: THREE.Vector3; top: boolean }[] {
  const outer = building.rings[0] ?? [];
  if (outer.length < 3) return [];
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const point of outer) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const floors = THREE.MathUtils.clamp(Math.round(building.height / 3), 2, 7);
  const cellArea = Math.max(
    4,
    (width * depth * floors) / Math.max(8, maxPieces * 0.8),
  );
  const cell = Math.sqrt(cellArea);
  const columns = Math.max(1, Math.round(width / cell));
  const rows = Math.max(1, Math.round(depth / cell));
  const floorHeight = building.height / floors;
  const cells: { center: THREE.Vector3; size: THREE.Vector3; top: boolean }[] =
    [];
  for (let column = 0; column < columns; column += 1)
    for (let row = 0; row < rows; row += 1) {
      const x = minX + ((column + 0.5) * width) / columns;
      const z = minZ + ((row + 0.5) * depth) / rows;
      if (!insideFootprint(building, { x, z })) continue;
      for (let floor = 0; floor < floors; floor += 1)
        cells.push({
          center: new THREE.Vector3(
            x,
            building.baseHeight + (floor + 0.5) * floorHeight,
            z,
          ),
          size: new THREE.Vector3(
            (width / columns) * 0.92,
            floorHeight * 0.92,
            (depth / rows) * 0.92,
          ),
          top: floor === floors - 1,
        });
    }
  return cells.slice(0, maxPieces);
}

/** Rockets, smoke, fireballs and flying rubble. Collision tests stay in the engine. */
export class CombatEffects {
  readonly rockets: Rocket[] = [];
  private readonly puffs: Puff[] = [];
  private readonly debris: Debris[] = [];
  private readonly flashes: Flash[] = [];
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly puffGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly rocketBody: THREE.CylinderGeometry;
  private readonly rocketFlame: THREE.ConeGeometry;
  private readonly rocketMaterial = new THREE.MeshStandardMaterial({
    color: 0xe9ecef,
    roughness: 0.4,
    metalness: 0.5,
  });
  private readonly flameMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb13b,
  });
  private readonly debrisMaterials = new Map<string, THREE.Material>();
  private shakeAmount = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    this.rocketBody = new THREE.CylinderGeometry(0.09, 0.09, 1.1, 8);
    this.rocketBody.rotateX(Math.PI / 2);
    this.rocketFlame = new THREE.ConeGeometry(0.12, 0.7, 8);
    this.rocketFlame.rotateX(Math.PI / 2);
    this.rocketFlame.translate(0, 0, 0.9);
  }

  /** Camera shake amplitude in metres; decays over time. */
  get shake(): number {
    return this.shakeAmount;
  }

  launch(origin: THREE.Vector3, velocity: THREE.Vector3): Rocket {
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(this.rocketBody, this.rocketMaterial));
    mesh.add(new THREE.Mesh(this.rocketFlame, this.flameMaterial));
    mesh.position.copy(origin);
    mesh.lookAt(origin.clone().sub(velocity));
    this.scene.add(mesh);
    const rocket = {
      mesh,
      position: origin.clone(),
      velocity: velocity.clone(),
      age: 0,
      puffTimer: 0,
    };
    this.rockets.push(rocket);
    this.puff(origin, new THREE.Vector3(), 0.3, 1.4, 0.5, 0.6, 0xd9d4cc);
    return rocket;
  }

  /** Advances a rocket; returns false once it has burned out. */
  moveRocket(rocket: Rocket, to: THREE.Vector3, dt: number): boolean {
    rocket.age += dt;
    rocket.position.copy(to);
    rocket.mesh.position.copy(to);
    rocket.puffTimer -= dt;
    if (rocket.puffTimer <= 0) {
      rocket.puffTimer = 0.025;
      this.puff(
        to,
        new THREE.Vector3(
          (Math.random() - 0.5) * 0.6,
          0.4,
          (Math.random() - 0.5) * 0.6,
        ),
        0.18,
        1.1,
        1.1,
        0.55,
        0xcfcac2,
      );
    }
    return rocket.age < ROCKET_LIFETIME;
  }

  removeRocket(rocket: Rocket): void {
    this.scene.remove(rocket.mesh);
    const index = this.rockets.indexOf(rocket);
    if (index >= 0) this.rockets.splice(index, 1);
  }

  /** Fireball, flash and lingering smoke. `size` ~1 for a rocket, ~3+ for a building. */
  explode(point: THREE.Vector3, size = 1, cameraDistance = 0): void {
    const light = new THREE.PointLight(0xff9a3c, 0, 40 * size, 2);
    light.position.copy(point);
    this.scene.add(light);
    this.flashes.push({ light, age: 0, life: 0.5, intensity: 90 * size });
    const fireballs = Math.round(5 + size * 5);
    for (let index = 0; index < fireballs; index += 1) {
      const direction = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() * 0.8,
        Math.random() - 0.5,
      ).normalize();
      this.puff(
        point.clone().addScaledVector(direction, Math.random() * size * 1.5),
        direction.multiplyScalar(2 + Math.random() * 4 * size),
        0.4 * size,
        (1.6 + Math.random()) * size,
        0.45 + Math.random() * 0.3,
        1,
        index % 3 === 0 ? 0xffe08a : index % 3 === 1 ? 0xff8a2b : 0xe2461c,
        index * 0.02,
      );
    }
    const smoke = Math.round(4 + size * 6);
    for (let index = 0; index < smoke; index += 1)
      this.puff(
        point
          .clone()
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * size * 3,
              Math.random() * size,
              (Math.random() - 0.5) * size * 3,
            ),
          ),
        new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          1.5 + Math.random() * 2,
          (Math.random() - 0.5) * 2,
        ),
        0.8 * size,
        (3 + Math.random() * 2) * size,
        2.5 + Math.random() * 2,
        0.7,
        0x3b3835,
        0.15 + Math.random() * 0.3,
      );
    const falloff = cameraDistance > 0 ? 60 / (60 + cameraDistance) : 1;
    this.shakeAmount = Math.min(1.6, this.shakeAmount + 0.25 * size * falloff);
  }

  /**
   * Breaks a building into floor-by-floor chunks that burst away from the
   * impact, nearest pieces first, then tumble and settle before fading.
   */
  shatter(
    building: Pick<BuildingPlan, "rings" | "height" | "baseHeight">,
    impact: THREE.Vector3,
    wallColor: string,
    roofColor: string,
  ): void {
    const cells = debrisCells(building);
    const wall = this.debrisMaterial(wallColor);
    const roof = this.debrisMaterial(roofColor);
    for (const cell of cells) {
      const mesh = new THREE.Mesh(this.unitBox, cell.top ? roof : wall);
      mesh.position.copy(cell.center);
      mesh.scale.copy(cell.size);
      mesh.castShadow = true;
      this.scene.add(mesh);
      const away = cell.center.clone().sub(impact);
      const distance = away.length();
      away.y = Math.max(away.y, 0);
      away.normalize();
      const blast = Math.max(4, 26 - distance * 1.2);
      this.debris.push({
        mesh,
        velocity: away
          .multiplyScalar(blast * (0.6 + Math.random() * 0.6))
          .add(
            new THREE.Vector3(
              (Math.random() - 0.5) * 6,
              4 + Math.random() * 10,
              (Math.random() - 0.5) * 6,
            ),
          ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
        ),
        delay: distance * 0.018 + Math.random() * 0.05,
        age: 0,
        life: 6 + Math.random() * 3,
        resting: false,
      });
    }
    while (this.debris.length > MAX_DEBRIS) this.removeDebris(0);
    // A few more blasts ripple across the footprint for the theatrics.
    const center = cells.length
      ? cells
          .reduce((sum, cell) => sum.add(cell.center), new THREE.Vector3())
          .divideScalar(cells.length)
      : impact.clone();
    const size = THREE.MathUtils.clamp(building.height / 8, 1.5, 4);
    this.explode(impact, size);
    this.delayedBlast(center, size * 0.8, 0.18);
    this.delayedBlast(
      center.clone().setY(building.baseHeight + 1),
      size * 1.1,
      0.4,
    );
  }

  private readonly pending: {
    point: THREE.Vector3;
    size: number;
    at: number;
  }[] = [];

  private delayedBlast(point: THREE.Vector3, size: number, delay: number) {
    this.pending.push({ point, size, at: delay });
  }

  update(dt: number): void {
    this.shakeAmount *= Math.exp(-dt * 3.5);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const blast = this.pending[index]!;
      blast.at -= dt;
      if (blast.at > 0) continue;
      this.pending.splice(index, 1);
      this.explode(blast.point, blast.size);
    }
    for (let index = this.flashes.length - 1; index >= 0; index -= 1) {
      const flash = this.flashes[index]!;
      flash.age += dt;
      const t = flash.age / flash.life;
      flash.light.intensity = flash.intensity * Math.max(0, 1 - t) ** 2;
      if (t >= 1) {
        this.scene.remove(flash.light);
        flash.light.dispose();
        this.flashes.splice(index, 1);
      }
    }
    for (let index = this.puffs.length - 1; index >= 0; index -= 1) {
      const puff = this.puffs[index]!;
      if (puff.delay > 0) {
        puff.delay -= dt;
        continue;
      }
      puff.mesh.visible = true;
      puff.age += dt;
      const t = Math.min(1, puff.age / puff.life);
      puff.mesh.position.addScaledVector(puff.velocity, dt);
      puff.velocity.multiplyScalar(Math.exp(-dt * 1.5));
      puff.mesh.scale.setScalar(
        THREE.MathUtils.lerp(puff.startScale, puff.endScale, 1 - (1 - t) ** 2),
      );
      puff.mesh.material.opacity = puff.startOpacity * (1 - t);
      if (t >= 1) this.removePuff(index);
    }
    for (let index = this.debris.length - 1; index >= 0; index -= 1) {
      const piece = this.debris[index]!;
      if (piece.delay > 0) {
        piece.delay -= dt;
        continue;
      }
      piece.age += dt;
      if (!piece.resting) {
        piece.velocity.y -= DEBRIS_GRAVITY * dt;
        piece.mesh.position.addScaledVector(piece.velocity, dt);
        piece.mesh.rotation.x += piece.spin.x * dt;
        piece.mesh.rotation.y += piece.spin.y * dt;
        piece.mesh.rotation.z += piece.spin.z * dt;
        const floor =
          this.groundHeight(piece.mesh.position.x, piece.mesh.position.z) +
          piece.mesh.scale.y * 0.3;
        if (piece.mesh.position.y < floor) {
          piece.mesh.position.y = floor;
          if (Math.abs(piece.velocity.y) < 2.5) {
            piece.resting = true;
          } else {
            piece.velocity.y *= -0.3;
            piece.velocity.x *= 0.55;
            piece.velocity.z *= 0.55;
            piece.spin.multiplyScalar(0.5);
          }
        }
      }
      const fade = piece.life - piece.age;
      if (fade < 1)
        piece.mesh.scale.multiplyScalar(Math.max(0.001, 1 - dt * 3));
      if (fade <= 0) this.removeDebris(index);
    }
  }

  dispose(): void {
    for (const rocket of [...this.rockets]) this.removeRocket(rocket);
    while (this.puffs.length) this.removePuff(this.puffs.length - 1);
    while (this.debris.length) this.removeDebris(this.debris.length - 1);
    for (const flash of this.flashes) {
      this.scene.remove(flash.light);
      flash.light.dispose();
    }
    this.flashes.length = 0;
    this.unitBox.dispose();
    this.puffGeometry.dispose();
    this.rocketBody.dispose();
    this.rocketFlame.dispose();
    this.rocketMaterial.dispose();
    this.flameMaterial.dispose();
    for (const material of this.debrisMaterials.values()) material.dispose();
  }

  private debrisMaterial(color: string): THREE.Material {
    let material = this.debrisMaterials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      this.debrisMaterials.set(color, material);
    }
    return material;
  }

  private puff(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    startScale: number,
    endScale: number,
    life: number,
    startOpacity: number,
    color: number,
    delay = 0,
  ): void {
    if (this.puffs.length >= MAX_PUFFS) this.removePuff(0);
    const mesh = new THREE.Mesh(
      this.puffGeometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: startOpacity,
        depthWrite: false,
      }),
    );
    mesh.position.copy(position);
    mesh.scale.setScalar(startScale);
    mesh.visible = delay <= 0;
    this.scene.add(mesh);
    this.puffs.push({
      mesh,
      velocity: velocity.clone(),
      age: 0,
      life,
      startScale,
      endScale,
      startOpacity,
      delay,
    });
  }

  private removePuff(index: number): void {
    const [puff] = this.puffs.splice(index, 1);
    if (!puff) return;
    this.scene.remove(puff.mesh);
    puff.mesh.material.dispose();
  }

  private removeDebris(index: number): void {
    const [piece] = this.debris.splice(index, 1);
    if (piece) this.scene.remove(piece.mesh);
  }
}
