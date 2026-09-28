import type { BuildingPlan, RoadPlan } from "@osm3d/worldgen";
import * as THREE from "three";
import type { CombatEffects } from "./combat.js";
import {
  ROBOT_STRIDE,
  RobotKit,
  createRobot,
  disposeRobot,
  poseAttack,
  poseWalk,
  type RobotRig,
} from "./robot.js";

export const DEFENSE_WAVES = [
  { robots: 2, health: 10, speed: 5.6 },
  { robots: 3, health: 13, speed: 6.3 },
  { robots: 4, health: 17, speed: 7 },
] as const;
const COUNTDOWN_SECONDS = 6;
const SPAWN_INTERVAL_SECONDS = 2.8;
const HOUSE_HEALTH = 100;
const HELICOPTER_HEALTH = 100;
const ATTACK_DAMAGE_PER_SECOND = 4.5;
const BOLT_SPEED = 75;
const BOLT_DAMAGE = 5;
const BOLT_RANGE = 190;
const FALL_SECONDS = 2.4;
const FLASH_SECONDS = 5;
const SINK_SECONDS = 1.4;

export type DefensePhase = "countdown" | "wave" | "won" | "lost";
export type RobotState =
  "walking" | "attacking" | "falling" | "down" | "sinking" | "gone";

export interface DefenseRobotStats {
  id: number;
  health: number;
  maxHealth: number;
  distanceToHouse: number;
  state: RobotState;
}

export interface DefenseStats {
  phase: DefensePhase;
  wave: number;
  waves: number;
  countdown: number;
  message?: string;
  houseHealth: number;
  houseMaxHealth: number;
  helicopterHealth: number;
  helicopterMaxHealth: number;
  robots: DefenseRobotStats[];
  destroyed: number;
  headshots: number;
  hits: number;
  score: number;
}

export interface DefenseHost {
  scene: THREE.Scene;
  combat: CombatEffects;
  roads: RoadPlan[];
  buildings: BuildingPlan[];
  groundHeight(x: number, z: number): number;
  /** Playable area in local metres. */
  bounds: {
    centerX: number;
    centerZ: number;
    halfWidth: number;
    halfDepth: number;
  };
  /** The helicopter while airborne, for robots to shoot at. */
  helicopter():
    { position: THREE.Vector3; velocity: THREE.Vector3 } | undefined;
  onHelicopterHit(health: number): void;
  onHelicopterDestroyed(): void;
  destroyBuilding(sourceId: string, point: THREE.Vector3): void;
  overlayParent: HTMLElement;
}

// ---------------------------------------------------------------------------
// Road graph

export interface RoadGraph {
  nodes: THREE.Vector3[];
  edges: { to: number; cost: number }[][];
}

/** Joins road polylines into one graph; points within 1.5 m are one node. */
export function buildRoadGraph(
  roads: Pick<RoadPlan, "points" | "tunnel">[],
): RoadGraph {
  const nodes: THREE.Vector3[] = [];
  const edges: { to: number; cost: number }[][] = [];
  const grid = new Map<string, number[]>();
  const cell = 3;
  const nodeFor = (x: number, y: number, z: number) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dz = -1; dz <= 1; dz += 1)
        for (const id of grid.get(`${gx + dx}:${gz + dz}`) ?? []) {
          const node = nodes[id]!;
          if ((node.x - x) ** 2 + (node.z - z) ** 2 < 2.25) return id;
        }
    const id = nodes.length;
    nodes.push(new THREE.Vector3(x, y, z));
    edges.push([]);
    const key = `${gx}:${gz}`;
    grid.set(key, [...(grid.get(key) ?? []), id]);
    return id;
  };
  for (const road of roads) {
    if (road.tunnel) continue;
    let previous: number | undefined;
    for (const point of road.points) {
      const id = nodeFor(point.x, point.y, point.z);
      if (previous !== undefined && previous !== id) {
        const cost = nodes[previous]!.distanceTo(nodes[id]!);
        edges[previous]!.push({ to: id, cost });
        edges[id]!.push({ to: previous, cost });
      }
      previous = id;
    }
  }
  return { nodes, edges };
}

export function nearestNode(graph: RoadGraph, x: number, z: number): number {
  let best = -1;
  let bestDistance = Infinity;
  graph.nodes.forEach((node, id) => {
    if (!graph.edges[id]!.length) return;
    const distance = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  });
  return best;
}

/** Dijkstra outward from `goal`; `next[id]` is the step from id toward goal. */
export function routesToGoal(
  graph: RoadGraph,
  goal: number,
): { distance: Float64Array; next: Int32Array } {
  const distance = new Float64Array(graph.nodes.length).fill(Infinity);
  const next = new Int32Array(graph.nodes.length).fill(-1);
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]![0] <= heap[index]![0]) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left]![0] < heap[smallest]![0])
          smallest = left;
        if (right < heap.length && heap[right]![0] < heap[smallest]![0])
          smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
        index = smallest;
      }
    }
    return top;
  };
  distance[goal] = 0;
  push([0, goal]);
  while (heap.length) {
    const [cost, id] = pop();
    if (cost > distance[id]!) continue;
    for (const edge of graph.edges[id]!) {
      const candidate = cost + edge.cost;
      if (candidate < distance[edge.to]!) {
        distance[edge.to] = candidate;
        next[edge.to] = id;
        push([candidate, edge.to]);
      }
    }
  }
  return { distance, next };
}

export function pathToGoal(start: number, next: Int32Array): number[] {
  const path = [start];
  let current = start;
  while (next[current]! >= 0 && path.length < 100_000) {
    current = next[current]!;
    path.push(current);
  }
  return path;
}

/** The building whose footprint centre is closest to the middle of the map. */
export function chooseTargetBuilding(
  buildings: BuildingPlan[],
  centerX: number,
  centerZ: number,
): { building: BuildingPlan; center: THREE.Vector3 } | undefined {
  let best: { building: BuildingPlan; center: THREE.Vector3 } | undefined;
  let bestDistance = Infinity;
  for (const building of buildings) {
    const ring = building.rings[0] ?? [];
    if (ring.length < 3) continue;
    const x = ring.reduce((sum, point) => sum + point.x, 0) / ring.length;
    const z = ring.reduce((sum, point) => sum + point.z, 0) / ring.length;
    const distance = (x - centerX) ** 2 + (z - centerZ) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        building,
        center: new THREE.Vector3(x, building.baseHeight, z),
      };
    }
  }
  return best;
}

/**
 * Reachable road points near the edge of the map, spread around the target
 * so robots converge from different directions.
 */
export function chooseSpawnNodes(
  graph: RoadGraph,
  routes: { distance: Float64Array },
  bounds: DefenseHost["bounds"],
  target: THREE.Vector3,
): number[] {
  const inside: { id: number; edge: number; angle: number; far: number }[] = [];
  graph.nodes.forEach((node, id) => {
    const far = routes.distance[id]!;
    if (!Number.isFinite(far) || far < 150) return;
    const dx = Math.abs(node.x - bounds.centerX);
    const dz = Math.abs(node.z - bounds.centerZ);
    if (dx > bounds.halfWidth || dz > bounds.halfDepth) return;
    inside.push({
      id,
      edge: Math.min(bounds.halfWidth - dx, bounds.halfDepth - dz),
      angle: Math.atan2(node.z - target.z, node.x - target.x),
      far,
    });
  });
  const nearEdge = inside.filter((candidate) => candidate.edge < 70);
  const pool = (nearEdge.length >= 2 ? nearEdge : inside).sort(
    (a, b) => b.far - a.far,
  );
  const chosen: typeof pool = [];
  for (const separation of [1.2, 0.7, 0.35, 0]) {
    for (const candidate of pool) {
      if (chosen.length >= 6) break;
      if (chosen.includes(candidate)) continue;
      const clear = chosen.every((other) => {
        const gap = Math.abs(
          Math.atan2(
            Math.sin(candidate.angle - other.angle),
            Math.cos(candidate.angle - other.angle),
          ),
        );
        return gap >= separation;
      });
      if (clear) chosen.push(candidate);
    }
    if (chosen.length >= 6) break;
  }
  return chosen.map((candidate) => candidate.id);
}

// ---------------------------------------------------------------------------
// Session

interface Robot {
  id: number;
  rig: RobotRig;
  health: number;
  maxHealth: number;
  speed: number;
  path: THREE.Vector3[];
  lengths: number[];
  travelled: number;
  stopAt: number;
  yaw: number;
  phase: number;
  state: RobotState;
  stateTime: number;
  stagger: number;
  staggerCooldown: number;
  flash: number;
  fireCooldown: number;
  fallDirection: number;
  healthBar: THREE.Group;
  healthFill: THREE.Mesh;
  arrow: HTMLDivElement;
  beam?: THREE.Mesh;
}

interface Bolt {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  age: number;
}

export class DefenseSession {
  phase: DefensePhase = "countdown";
  private wave = 0;
  private countdown = COUNTDOWN_SECONDS;
  private message: string | undefined = "Robots are coming";
  private spawnTimer = 0;
  private spawnedThisWave = 0;
  private readonly robots: Robot[] = [];
  private readonly bolts: Bolt[] = [];
  private nextId = 1;
  private time = 0;
  private houseHealth = HOUSE_HEALTH;
  private helicopterHealth = HELICOPTER_HEALTH;
  private destroyed = 0;
  private headshots = 0;
  private hits = 0;
  private readonly kit = new RobotKit();
  private readonly beacon: THREE.Group;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly markerMaterial: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly boltMaterial: THREE.MeshBasicMaterial;
  private readonly barBack: THREE.MeshBasicMaterial;
  private readonly barFill: THREE.MeshBasicMaterial;
  private readonly beamGeometry = new THREE.CylinderGeometry(
    0.5,
    0.5,
    1,
    10,
    1,
    true,
  );
  private readonly boltGeometry = new THREE.CapsuleGeometry(0.45, 3.2, 4, 8);
  private readonly barGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly markers: THREE.Mesh[] = [];
  private readonly overlay: HTMLDivElement;
  private readonly houseArrow: HTMLDivElement;
  private readonly spawnNodes: number[];
  private readonly routes: { distance: Float64Array; next: Int32Array };
  private readonly target: { building: BuildingPlan; center: THREE.Vector3 };
  private readonly houseAim: THREE.Vector3;

  private constructor(
    private readonly host: DefenseHost,
    private readonly graph: RoadGraph,
    target: { building: BuildingPlan; center: THREE.Vector3 },
    spawnNodes: number[],
    routes: { distance: Float64Array; next: Int32Array },
  ) {
    this.target = target;
    this.spawnNodes = spawnNodes;
    this.routes = routes;
    this.houseAim = target.center
      .clone()
      .setY(target.building.baseHeight + target.building.height * 0.6);

    this.beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0x7fe7ff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.ringMaterial = this.beaconMaterial.clone();
    this.markerMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3020,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3a1a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.boltMaterial = new THREE.MeshBasicMaterial({ color: 0xff5530 });
    this.barBack = new THREE.MeshBasicMaterial({
      color: 0x1a0d0b,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
    });
    this.barFill = new THREE.MeshBasicMaterial({
      color: 0xff4a2a,
      depthTest: false,
    });

    this.beacon = new THREE.Group();
    const pillar = new THREE.Mesh(this.beamGeometry, this.beaconMaterial);
    pillar.scale.set(5, 160, 5);
    pillar.position.y = 80;
    this.beacon.add(pillar);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(9, 11, 48),
      this.ringMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.6;
    this.beacon.add(ring);
    this.beacon.position.copy(target.center);
    host.scene.add(this.beacon);

    this.overlay = document.createElement("div");
    this.overlay.className = "defense-overlay";
    host.overlayParent.appendChild(this.overlay);
    this.houseArrow = this.createArrow("house");
    this.showMarkers();
  }

  /** Sets up an attack, or explains why this map cannot host one. */
  static create(host: DefenseHost): DefenseSession | string {
    const graph = buildRoadGraph(host.roads);
    if (graph.nodes.length < 2)
      return "This map has no roads for robots to walk.";
    const target = chooseTargetBuilding(
      host.buildings,
      host.bounds.centerX,
      host.bounds.centerZ,
    );
    if (!target) return "This map has no house to defend.";
    const goal = nearestNode(graph, target.center.x, target.center.z);
    if (goal < 0) return "No road reaches the house in the middle of the map.";
    const routes = routesToGoal(graph, goal);
    const spawns = chooseSpawnNodes(graph, routes, host.bounds, target.center);
    if (!spawns.length)
      return "No road leads from the edge of the map to the central house.";
    return new DefenseSession(host, graph, target, spawns, routes);
  }

  /** One of each robot part, so shaders compile before the first spawn. */
  prewarmObjects(): THREE.Object3D {
    const group = new THREE.Group();
    const rig = createRobot(this.kit);
    group.add(rig.root);
    group.userData.dispose = () => disposeRobot(rig);
    return group;
  }

  get active(): boolean {
    return this.phase === "countdown" || this.phase === "wave";
  }

  /** Called when a rocket moves; returns true if it struck a robot. */
  rocketHit(point: THREE.Vector3): boolean {
    for (const robot of this.robots) {
      if (robot.state !== "walking" && robot.state !== "attacking") continue;
      const zone = this.hitZone(robot, point);
      if (!zone) continue;
      const damage = zone === "head" ? 2 : 1;
      this.hits += 1;
      if (zone === "head") this.headshots += 1;
      robot.health = Math.max(0, robot.health - damage);
      robot.flash = 0.18;
      this.host.combat.sparks(point);
      if (robot.staggerCooldown <= 0) {
        robot.stagger = zone === "head" ? 0.7 : 0.35;
        robot.staggerCooldown = 1.4;
      }
      if (robot.health === 0) this.kill(robot);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    this.time += dt;
    this.kit.pulse(this.time);
    this.ringMaterial.opacity = 0.25 + 0.2 * Math.sin(this.time * 4);
    this.beaconMaterial.opacity =
      this.houseHealth < 35 ? 0.2 + 0.15 * Math.sin(this.time * 12) : 0.22;
    this.markerMaterial.opacity = 0.25 + 0.2 * Math.sin(this.time * 6);

    if (this.phase === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = "wave";
        this.message = undefined;
        this.spawnTimer = 0;
        this.spawnedThisWave = 0;
        this.hideMarkers();
      }
    } else if (this.phase === "wave") {
      const wave = DEFENSE_WAVES[this.wave]!;
      this.spawnTimer -= dt;
      if (this.spawnedThisWave < wave.robots && this.spawnTimer <= 0) {
        this.spawn(this.spawnedThisWave);
        this.spawnedThisWave += 1;
        this.spawnTimer = SPAWN_INTERVAL_SECONDS;
      }
      const cleared =
        this.spawnedThisWave >= wave.robots &&
        this.robots.every((robot) => robot.health === 0);
      if (cleared) {
        if (this.wave + 1 >= DEFENSE_WAVES.length) {
          this.phase = "won";
          this.message = "The neighbourhood is safe";
        } else {
          this.wave += 1;
          this.phase = "countdown";
          this.countdown = COUNTDOWN_SECONDS + 2;
          this.message = `Wave ${this.wave} cleared. Wave ${this.wave + 1} incoming`;
          this.showMarkers();
        }
      }
    }

    for (const robot of [...this.robots]) this.updateRobot(robot, dt);
    this.updateBolts(dt);
  }

  /** Screen-edge arrows and billboarded health bars; runs every render frame. */
  updateOverlay(camera: THREE.Camera, width: number, height: number): void {
    const place = (
      arrow: HTMLDivElement,
      point: THREE.Vector3,
      label: string,
      visible: boolean,
    ) => {
      if (!visible) {
        arrow.hidden = true;
        return;
      }
      const projected = point.clone().project(camera);
      const behind = projected.z > 1;
      const onScreen =
        !behind && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.9;
      arrow.hidden = onScreen;
      if (onScreen) return;
      let x = projected.x;
      let y = projected.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      const scale = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.82, 1e-6);
      x *= scale;
      y *= scale;
      const angle = Math.atan2(-y, x);
      arrow.style.left = `${((x + 1) / 2) * width}px`;
      arrow.style.top = `${((1 - y) / 2) * height}px`;
      arrow.style.setProperty("--angle", `${angle}rad`);
      arrow.dataset.label = label;
    };
    const eye = camera.position;
    for (const robot of this.robots) {
      const alive = robot.state === "walking" || robot.state === "attacking";
      const top = robot.rig.root.position
        .clone()
        .setY(robot.rig.root.position.y + 34);
      robot.healthBar.visible = alive;
      if (alive) {
        robot.healthBar.position.copy(top);
        robot.healthBar.quaternion.copy(camera.quaternion);
        const scale = Math.max(1, eye.distanceTo(top) / 90);
        robot.healthBar.scale.setScalar(scale);
        const fraction = robot.health / robot.maxHealth;
        robot.healthFill.scale.x = Math.max(0.001, fraction * 11);
        robot.healthFill.position.x = -5.5 + fraction * 5.5;
      }
      place(
        robot.arrow,
        top.setY(top.y - 12),
        `${Math.round(eye.distanceTo(robot.rig.root.position))} m`,
        alive,
      );
    }
    place(
      this.houseArrow,
      this.houseAim,
      "House",
      this.phase !== "won" && this.phase !== "lost",
    );
  }

  stats(): DefenseStats {
    const houseScore = Math.round(this.houseHealth) * 20;
    return {
      phase: this.phase,
      wave: this.wave + 1,
      waves: DEFENSE_WAVES.length,
      countdown: Math.max(0, Math.ceil(this.countdown)),
      ...(this.message ? { message: this.message } : {}),
      houseHealth: Math.round(this.houseHealth),
      houseMaxHealth: HOUSE_HEALTH,
      helicopterHealth: Math.round(this.helicopterHealth),
      helicopterMaxHealth: HELICOPTER_HEALTH,
      robots: this.robots
        .filter((robot) => robot.state !== "gone")
        .map((robot) => ({
          id: robot.id,
          health: robot.health,
          maxHealth: robot.maxHealth,
          distanceToHouse: Math.round(
            Math.max(0, robot.lengths.at(-1)! - robot.travelled),
          ),
          state: robot.state,
        })),
      destroyed: this.destroyed,
      headshots: this.headshots,
      hits: this.hits,
      score:
        this.destroyed * 1000 +
        this.headshots * 150 +
        (this.phase === "won"
          ? houseScore + Math.round(this.helicopterHealth) * 10
          : 0),
    };
  }

  /** Ends the attack as lost, e.g. when the helicopter is shot down. */
  lose(message: string): void {
    if (!this.active) return;
    this.phase = "lost";
    this.message = message;
    this.hideMarkers();
    for (const robot of this.robots) this.stopBeam(robot);
  }

  dispose(): void {
    for (const robot of this.robots) this.removeRobot(robot);
    for (const bolt of this.bolts) this.host.scene.remove(bolt.mesh);
    for (const marker of this.markers) this.host.scene.remove(marker);
    this.host.scene.remove(this.beacon);
    this.beacon.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry !== this.beamGeometry)
        object.geometry.dispose();
    });
    this.overlay.remove();
    this.kit.dispose();
    for (const item of [
      this.beaconMaterial,
      this.ringMaterial,
      this.markerMaterial,
      this.beamMaterial,
      this.boltMaterial,
      this.barBack,
      this.barFill,
      this.beamGeometry,
      this.boltGeometry,
      this.barGeometry,
    ])
      item.dispose();
  }

  // -------------------------------------------------------------------------

  private createArrow(kind: "robot" | "house"): HTMLDivElement {
    const arrow = document.createElement("div");
    arrow.className = `defense-arrow ${kind}`;
    arrow.hidden = true;
    this.overlay.appendChild(arrow);
    return arrow;
  }

  private showMarkers(): void {
    this.hideMarkers();
    const count = DEFENSE_WAVES[this.wave]!.robots;
    for (let index = 0; index < count; index += 1) {
      const node = this.graph.nodes[this.spawnNode(index)]!;
      const marker = new THREE.Mesh(this.beamGeometry, this.markerMaterial);
      marker.scale.set(14, 90, 14);
      marker.position.set(
        node.x,
        this.host.groundHeight(node.x, node.z) + 45,
        node.z,
      );
      this.host.scene.add(marker);
      this.markers.push(marker);
    }
  }

  private hideMarkers(): void {
    for (const marker of this.markers) this.host.scene.remove(marker);
    this.markers.length = 0;
  }

  private spawnNode(index: number): number {
    const offset = this.wave * 2;
    return this.spawnNodes[(index + offset) % this.spawnNodes.length]!;
  }

  private spawn(index: number): void {
    const wave = DEFENSE_WAVES[this.wave]!;
    const ids = pathToGoal(this.spawnNode(index), this.routes.next);
    const path = ids.map((id) => this.graph.nodes[id]!.clone());
    // Approach the house itself for the final few metres.
    path.push(this.target.center.clone());
    const lengths = [0];
    for (let step = 1; step < path.length; step += 1)
      lengths.push(
        lengths[step - 1]! + path[step - 1]!.distanceTo(path[step]!),
      );
    const total = lengths.at(-1)!;
    const slot = this.robots.filter((robot) => robot.health > 0).length;
    const rig = createRobot(this.kit);
    const healthBar = new THREE.Group();
    const back = new THREE.Mesh(this.barGeometry, this.barBack);
    back.scale.set(11.6, 1.5, 1);
    back.renderOrder = 40;
    const fill = new THREE.Mesh(this.barGeometry, this.barFill);
    fill.scale.set(11, 1, 1);
    fill.position.z = 0.01;
    fill.renderOrder = 41;
    healthBar.add(back, fill);
    this.host.scene.add(rig.root, healthBar);
    const robot: Robot = {
      id: this.nextId++,
      rig,
      health: wave.health,
      maxHealth: wave.health,
      speed: wave.speed,
      path,
      lengths,
      travelled: 0,
      stopAt: Math.max(0, total - (24 + (slot % 4) * 11)),
      yaw: 0,
      phase: Math.random() * Math.PI * 2,
      state: "walking",
      stateTime: 0,
      stagger: 0,
      staggerCooldown: 0,
      flash: 0,
      fireCooldown: 3 + Math.random() * 2,
      fallDirection: 1,
      healthBar,
      healthFill: fill,
      arrow: this.createArrow("robot"),
    };
    const start = this.sample(robot, 0);
    const ahead = this.sample(robot, 8);
    robot.yaw = Math.atan2(-(ahead.x - start.x), -(ahead.z - start.z));
    this.robots.push(robot);
    this.placeRobot(robot, start);
    this.host.combat.dust(rig.root.position, 3);
    this.host.combat.addShake(0.3);
  }

  private sample(robot: Robot, distance: number): THREE.Vector3 {
    const { path, lengths } = robot;
    const clamped = THREE.MathUtils.clamp(distance, 0, lengths.at(-1)!);
    let index = 1;
    while (index < lengths.length - 1 && lengths[index]! < clamped) index += 1;
    const from = path[index - 1]!;
    const to = path[index] ?? from;
    const span = lengths[index]! - lengths[index - 1]! || 1;
    return from.clone().lerp(to, (clamped - lengths[index - 1]!) / span);
  }

  private placeRobot(robot: Robot, point: THREE.Vector3): void {
    robot.rig.root.position.set(
      point.x,
      this.host.groundHeight(point.x, point.z),
      point.z,
    );
    robot.rig.root.rotation.y = robot.yaw;
  }

  private updateRobot(robot: Robot, dt: number): void {
    robot.stateTime += dt;
    robot.staggerCooldown -= dt;
    robot.flash = Math.max(0, robot.flash - dt);
    robot.rig.armor.emissive.setRGB(robot.flash * 5, robot.flash * 2, 0);

    if (robot.state === "walking") {
      const blocked = !this.active || robot.stagger > 0;
      robot.stagger = Math.max(0, robot.stagger - dt);
      const step = blocked ? 0 : robot.speed * dt;
      robot.travelled = Math.min(robot.stopAt, robot.travelled + step);
      const here = this.sample(robot, robot.travelled);
      const ahead = this.sample(robot, robot.travelled + 10);
      if (ahead.distanceToSquared(here) > 0.01) {
        const desired = Math.atan2(-(ahead.x - here.x), -(ahead.z - here.z));
        const turn = Math.atan2(
          Math.sin(desired - robot.yaw),
          Math.cos(desired - robot.yaw),
        );
        robot.yaw += turn * Math.min(1, dt * 1.6);
      }
      this.placeRobot(robot, here);
      const before = robot.phase;
      robot.phase += (step / (ROBOT_STRIDE * 2)) * Math.PI * 2;
      poseWalk(robot.rig, robot.phase, 1);
      robot.rig.waist.rotation.x += robot.stagger * 0.35;
      this.footsteps(robot, before, robot.phase);
      this.trackHelicopter(robot, dt);
      if (robot.travelled >= robot.stopAt - 0.01 && this.active) {
        robot.state = "attacking";
        robot.stateTime = 0;
      }
    } else if (robot.state === "attacking") {
      const desired = Math.atan2(
        -(this.target.center.x - robot.rig.root.position.x),
        -(this.target.center.z - robot.rig.root.position.z),
      );
      const turn = Math.atan2(
        Math.sin(desired - robot.yaw),
        Math.cos(desired - robot.yaw),
      );
      robot.yaw += turn * Math.min(1, dt * 2);
      robot.rig.root.rotation.y = robot.yaw;
      poseAttack(robot.rig, this.time);
      this.trackHelicopter(robot, dt);
      if (this.active && robot.stateTime > 1.2) this.attackHouse(robot, dt);
      else this.stopBeam(robot);
    } else if (robot.state === "falling") {
      const t = Math.min(1, robot.stateTime / FALL_SECONDS);
      robot.rig.root.rotation.x = robot.fallDirection * (Math.PI / 2) * t * t;
      if (t >= 1) {
        robot.state = "down";
        robot.stateTime = 0;
        this.impact(robot);
      }
    } else if (robot.state === "down") {
      const blink = Math.floor(robot.stateTime / 0.14) % 2 === 0;
      robot.rig.root.visible = blink || robot.stateTime < 0.3;
      robot.rig.armor.emissive.setRGB(blink ? 0.9 : 0, blink ? 0.12 : 0, 0);
      if (robot.stateTime >= FLASH_SECONDS) {
        robot.state = "sinking";
        robot.stateTime = 0;
        robot.rig.root.visible = true;
      }
    } else if (robot.state === "sinking") {
      robot.rig.root.position.y -= dt * 7;
      if (robot.stateTime >= SINK_SECONDS) {
        robot.state = "gone";
        this.removeRobot(robot);
      }
    }
  }

  private footsteps(robot: Robot, before: number, after: number): void {
    const quarter = Math.PI / 2;
    const crossings = Math.floor((after - quarter) / Math.PI);
    if (crossings === Math.floor((before - quarter) / Math.PI)) return;
    const side = crossings % 2 === 0 ? 0 : 1;
    const ankle = robot.rig.legs[side]!.ankle;
    robot.rig.root.updateMatrixWorld(true);
    const point = ankle.getWorldPosition(new THREE.Vector3());
    point.y = this.host.groundHeight(point.x, point.z);
    this.host.combat.dust(point, 1.4);
    const helicopter = this.host.helicopter();
    const distance = helicopter ? helicopter.position.distanceTo(point) : 200;
    this.host.combat.addShake(0.22 * Math.max(0, 1 - distance / 220));
  }

  private trackHelicopter(robot: Robot, dt: number): void {
    const helicopter = this.host.helicopter();
    const head = robot.rig.head;
    robot.fireCooldown -= dt;
    if (!helicopter || !this.active) {
      head.rotation.y = Math.sin(this.time * 0.4 + robot.id) * 0.35;
      head.rotation.x = 0;
      return;
    }
    const eye = this.eyePosition(robot);
    const offset = helicopter.position.clone().sub(eye);
    const distance = offset.length();
    const lookYaw = Math.atan2(-offset.x, -offset.z) - robot.yaw;
    const wrapped = Math.atan2(Math.sin(lookYaw), Math.cos(lookYaw));
    head.rotation.y = THREE.MathUtils.clamp(wrapped, -0.9, 0.9);
    head.rotation.x = THREE.MathUtils.clamp(
      Math.atan2(offset.y, Math.hypot(offset.x, offset.z)),
      -0.3,
      0.6,
    );
    if (distance > BOLT_RANGE || robot.fireCooldown > 0) return;
    robot.fireCooldown = 4.5 + Math.random() * 2.5;
    // Partial lead plus scatter: a moving helicopter can dodge the shots.
    const lead = helicopter.position
      .clone()
      .addScaledVector(helicopter.velocity, (distance / BOLT_SPEED) * 0.35)
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 7,
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 7,
        ),
      );
    const velocity = lead.sub(eye).normalize().multiplyScalar(BOLT_SPEED);
    const mesh = new THREE.Mesh(this.boltGeometry, this.boltMaterial);
    mesh.position.copy(eye);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      velocity.clone().normalize(),
    );
    this.host.scene.add(mesh);
    this.bolts.push({ mesh, velocity, age: 0 });
  }

  private updateBolts(dt: number): void {
    const helicopter = this.host.helicopter();
    for (let index = this.bolts.length - 1; index >= 0; index -= 1) {
      const bolt = this.bolts[index]!;
      bolt.age += dt;
      bolt.mesh.position.addScaledVector(bolt.velocity, dt);
      const hit =
        helicopter && bolt.mesh.position.distanceTo(helicopter.position) < 3.6;
      const ground = this.host.groundHeight(
        bolt.mesh.position.x,
        bolt.mesh.position.z,
      );
      if (hit || bolt.age > 3.5 || bolt.mesh.position.y < ground) {
        this.host.scene.remove(bolt.mesh);
        this.bolts.splice(index, 1);
        if (hit && this.active) {
          this.host.combat.explode(bolt.mesh.position, 0.8);
          this.helicopterHealth = Math.max(
            0,
            this.helicopterHealth - BOLT_DAMAGE,
          );
          this.host.onHelicopterHit(this.helicopterHealth);
          if (this.helicopterHealth === 0) {
            this.host.onHelicopterDestroyed();
            this.lose("Your helicopter was shot down");
          }
        }
      }
    }
  }

  private attackHouse(robot: Robot, dt: number): void {
    const core = this.corePosition(robot);
    if (!robot.beam) {
      robot.beam = new THREE.Mesh(this.beamGeometry, this.beamMaterial);
      this.host.scene.add(robot.beam);
    }
    const flicker = 1.6 + Math.sin(this.time * 40 + robot.id) * 0.5;
    const span = this.houseAim.clone().sub(core);
    robot.beam.position.copy(core).addScaledVector(span, 0.5);
    robot.beam.scale.set(flicker, span.length(), flicker);
    robot.beam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      span.normalize(),
    );
    if (Math.random() < dt * 6) this.host.combat.sparks(this.houseAim);
    this.houseHealth = Math.max(
      0,
      this.houseHealth - ATTACK_DAMAGE_PER_SECOND * dt,
    );
    if (this.houseHealth === 0) {
      this.host.destroyBuilding(this.target.building.sourceId, this.houseAim);
      this.host.scene.remove(this.beacon);
      this.lose("The robots destroyed the house");
    }
  }

  private stopBeam(robot: Robot): void {
    if (!robot.beam) return;
    this.host.scene.remove(robot.beam);
    delete robot.beam;
  }

  private kill(robot: Robot): void {
    this.destroyed += 1;
    this.stopBeam(robot);
    robot.state = "falling";
    robot.stateTime = 0;
    robot.fallDirection = Math.random() < 0.5 ? -1 : 1;
    robot.healthBar.visible = false;
    robot.arrow.hidden = true;
    poseWalk(robot.rig, 0, 0.2);
    this.host.combat.explode(this.corePosition(robot), 2.2);
  }

  /** The body slams down: dust along its length, a blast and a big shake. */
  private impact(robot: Robot): void {
    const root = robot.rig.root.position;
    const along = new THREE.Vector3(0, 0, robot.fallDirection).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      robot.yaw,
    );
    for (let metres = 4; metres <= 30; metres += 6.5) {
      const point = root.clone().addScaledVector(along, metres);
      point.y = this.host.groundHeight(point.x, point.z);
      this.host.combat.dust(point, 2.2);
    }
    this.host.combat.explode(root.clone().addScaledVector(along, 18), 1.6);
    this.host.combat.addShake(0.9);
  }

  private removeRobot(robot: Robot): void {
    this.stopBeam(robot);
    this.host.scene.remove(robot.rig.root, robot.healthBar);
    disposeRobot(robot.rig);
    robot.arrow.remove();
    const index = this.robots.indexOf(robot);
    if (index >= 0) this.robots.splice(index, 1);
  }

  private localPoint(robot: Robot, point: THREE.Vector3): THREE.Vector3 {
    const root = robot.rig.root.position;
    const dx = point.x - root.x;
    const dz = point.z - root.z;
    const cos = Math.cos(robot.yaw);
    const sin = Math.sin(robot.yaw);
    return new THREE.Vector3(
      dx * cos - dz * sin,
      point.y - root.y,
      dx * sin + dz * cos,
    );
  }

  private hitZone(
    robot: Robot,
    point: THREE.Vector3,
  ): "head" | "body" | undefined {
    const local = this.localPoint(robot, point);
    // Zones follow the hunched pose: head and chest lean forward of the hips.
    const head = new THREE.Vector3(0, 28.4, -3.6);
    if (local.distanceTo(head) < 3.6) return "head";
    if (
      Math.abs(local.x) < 7.5 &&
      local.y > 15 &&
      local.y < 26.5 &&
      Math.abs(local.z + 1.3) < 4.6
    )
      return "body";
    if (
      Math.abs(local.x) < 5.2 &&
      local.y > -1 &&
      local.y <= 15 &&
      Math.abs(local.z) < 3.8
    )
      return "body";
    return undefined;
  }

  private worldOffset(robot: Robot, offset: THREE.Vector3): THREE.Vector3 {
    return offset
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), robot.yaw)
      .add(robot.rig.root.position);
  }

  private corePosition(robot: Robot): THREE.Vector3 {
    return this.worldOffset(robot, robot.rig.coreOffset);
  }

  private eyePosition(robot: Robot): THREE.Vector3 {
    return this.worldOffset(robot, robot.rig.eyeOffset);
  }
}
