import RAPIER from "@dimforge/rapier3d-compat";
import type {
  Diagnostic,
  WorldBuildProgress,
  WorldDefinition,
} from "@osm3d/contracts";
import { wgs84ToLocal } from "@osm3d/geo";
import {
  defaultVehicleConfig,
  isVehiclePoseSafe,
  neutralVehicleInput,
  shouldRecoverVehicle,
  smoothVehicleInput,
  speedLimitedEngineForce,
  standardGamepadInput,
  type VehicleInput,
} from "@osm3d/simulation";
import {
  affectedChunkIds,
  changedOverrideTargetIds,
  closestPointOnRoad,
  deterministicHash,
  resolveSpawnPose,
  sampleTerrainPlan,
  type BuildingPlan,
  type LocalPoint2,
  type SurfaceMeshPlan,
  type TerrainChunkPlan,
  type WorldChunkPlan,
  type WorldPlan,
} from "@osm3d/worldgen";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { WorldBuilderClient } from "./worldBuilder.js";

const FIXED_STEP = 1 / 60;

export interface EngineStats {
  roads: number;
  buildings: number;
  features: number;
  speedKph: number;
  fps: number;
  chunks: number;
  triangles: number;
  terrainTriangles: number;
  terrainChunks: number;
  elevationProvider: string;
  elevationRange: number;
  vehicleElevation: number;
  buildHash: string;
  buildDurationMs: number;
  diagnosticCount: number;
  longFrameCount: number;
  recoveryCount: number;
  lastRebuiltChunks: number;
  inputSource: "keyboard" | "gamepad";
}

export interface EngineSelection {
  sourceId?: string;
  point?: LocalPoint2;
}

export interface EngineCallbacks {
  onSelect: (selection: EngineSelection) => void;
  onStats: (stats: EngineStats) => void;
  onBuildProgress: (progress: WorldBuildProgress) => void;
  onDiagnostics: (diagnostics: Diagnostic[]) => void;
}

export interface DriveInputPreferences {
  gamepadEnabled: boolean;
  steeringSensitivity: number;
}

export interface DefinitionUpdateResult {
  buildHash: string;
  rebuiltChunkIds: string[];
  durationMs: number;
}

export type EngineMode = "inspect" | "drive";

interface VehicleVisual {
  root: THREE.Group;
  wheels: THREE.Mesh[];
}

function colorFromId(
  id: string,
  style: WorldDefinition["world"]["settings"]["visualStyle"],
): THREE.Color {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  if (style === "night")
    return new THREE.Color().setHSL(
      0.58 + (Math.abs(hash) % 12) / 100,
      0.3,
      0.3,
    );
  if (style === "colorful")
    return new THREE.Color().setHSL((Math.abs(hash) % 360) / 360, 0.38, 0.62);
  return new THREE.Color().setHSL(
    0.08 + (Math.abs(hash) % 14) / 100,
    0.2,
    0.68,
  );
}

function shapeFromRings(rings: LocalPoint2[][]): THREE.Shape | undefined {
  const outer = rings[0];
  if (!outer || outer.length < 4) return undefined;
  const shape = new THREE.Shape();
  outer.forEach((point, index) => {
    const y = -point.z;
    if (index === 0) shape.moveTo(point.x, y);
    else shape.lineTo(point.x, y);
  });
  for (const holeRing of rings.slice(1)) {
    if (holeRing.length < 4) continue;
    const hole = new THREE.Path();
    holeRing.forEach((point, index) => {
      const y = -point.z;
      if (index === 0) hole.moveTo(point.x, y);
      else hole.lineTo(point.x, y);
    });
    shape.holes.push(hole);
  }
  return shape;
}

function geometryFromSurface(surface: SurfaceMeshPlan): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(surface.positions, 3),
  );
  geometry.setIndex(surface.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function geometryFromTerrain(chunk: TerrainChunkPlan): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let xIndex = 0; xIndex < chunk.columns; xIndex += 1) {
    const x =
      chunk.bounds.minX +
      (xIndex / (chunk.columns - 1)) * (chunk.bounds.maxX - chunk.bounds.minX);
    for (let zIndex = 0; zIndex < chunk.rows; zIndex += 1) {
      const z =
        chunk.bounds.minZ +
        (zIndex / (chunk.rows - 1)) * (chunk.bounds.maxZ - chunk.bounds.minZ);
      positions.push(x, chunk.heights[xIndex * chunk.rows + zIndex] ?? 0, z);
    }
  }
  for (let xIndex = 0; xIndex < chunk.columns - 1; xIndex += 1) {
    for (let zIndex = 0; zIndex < chunk.rows - 1; zIndex += 1) {
      const a = xIndex * chunk.rows + zIndex;
      const b = (xIndex + 1) * chunk.rows + zIndex;
      const c = a + 1;
      const d = b + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return geometryFromSurface({ positions, indices });
}

function conformGeometryToTerrain(
  geometry: THREE.BufferGeometry,
  plan: WorldPlan,
  offset: number,
): void {
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  for (let index = 0; index < positions.count; index += 1) {
    positions.setY(
      index,
      sampleTerrainPlan(
        plan.terrain,
        positions.getX(index),
        positions.getZ(index),
      ) + offset,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) material.dispose();
  });
}

function planTriangles(plan: WorldPlan): number {
  const roadTriangles = plan.roads.reduce(
    (sum, road) => sum + road.mesh.indices.length / 3,
    0,
  );
  const junctionTriangles = plan.junctions.reduce(
    (sum, junction) => sum + junction.mesh.indices.length / 3,
    0,
  );
  const shoulderTriangles = plan.roads.reduce(
    (sum, road) => sum + (road.shoulderMesh?.indices.length ?? 0) / 3,
    0,
  );
  return Math.round(roadTriangles + shoulderTriangles + junctionTriangles);
}

export class WorldEngine {
  static async create(
    container: HTMLElement,
    definition: WorldDefinition,
    callbacks: EngineCallbacks,
    signal?: AbortSignal,
  ): Promise<WorldEngine> {
    const builder = new WorldBuilderClient();
    try {
      const [, result] = await Promise.all([
        RAPIER.init(),
        builder.build(definition, callbacks.onBuildProgress, signal),
      ]);
      return new WorldEngine(
        container,
        definition,
        callbacks,
        builder,
        result.plan,
        result.durationMs,
      );
    } catch (error) {
      builder.dispose();
      throw error;
    }
  }

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10_000);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  private readonly controls: OrbitControls;
  private readonly physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly selectable: THREE.Object3D[] = [];
  private readonly keys = new Set<string>();
  private readonly chunkGroups = new Map<string, THREE.Group>();
  private readonly chunkBodies = new Map<string, RAPIER.RigidBody[]>();
  private readonly chassis: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly vehicleVisual: VehicleVisual;
  private readonly spawnPosition = new THREE.Vector3();
  private readonly spawnRotation = new THREE.Quaternion();
  private readonly safePosition = new THREE.Vector3();
  private readonly safeRotation = new THREE.Quaternion();
  private definition: WorldDefinition;
  private plan: WorldPlan;
  private animationFrame = 0;
  private previousTime = performance.now();
  private accumulator = 0;
  private currentInput: VehicleInput = { ...neutralVehicleInput };
  private inputPreferences: DriveInputPreferences = {
    gamepadEnabled: true,
    steeringSensitivity: 1,
  };
  private inputSource: EngineStats["inputSource"] = "keyboard";
  private mode: EngineMode = "inspect";
  private disposed = false;
  private statsElapsed = 0;
  private fpsElapsed = 0;
  private fpsFrames = 0;
  private fps = 0;
  private longFrameCount = 0;
  private recoveryCount = 0;
  private unsafeElapsed = 0;
  private safeElapsed = 0;
  private buildDurationMs: number;
  private lastRebuiltChunks: number;

  private constructor(
    private readonly container: HTMLElement,
    definition: WorldDefinition,
    private readonly callbacks: EngineCallbacks,
    private readonly builder: WorldBuilderClient,
    plan: WorldPlan,
    buildDurationMs: number,
  ) {
    this.definition = definition;
    this.plan = plan;
    this.buildDurationMs = buildDurationMs;
    this.lastRebuiltChunks = plan.chunks.length;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure =
      definition.world.settings.visualStyle === "night" ? 0.8 : 1.05;
    this.renderer.domElement.tabIndex = 0;
    this.container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.03;

    this.configureScene();
    this.buildGround();
    for (const chunk of this.plan.chunks) this.buildChunk(chunk);
    this.buildPhysicsGround();
    for (const chunk of this.plan.chunks) this.buildChunkPhysics(chunk);
    const vehicle = this.createVehicle();
    this.chassis = vehicle.chassis;
    this.vehicle = vehicle.controller;
    this.vehicleVisual = vehicle.visual;
    this.scene.add(this.vehicleVisual.root);
    this.frameOverview();

    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    this.resize();
    this.callbacks.onDiagnostics(this.plan.diagnostics);
    this.emitStats();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setMode(mode: EngineMode): void {
    const previousMode = this.mode;
    this.mode = mode;
    this.controls.enabled = mode === "inspect";
    if (mode === "drive") this.renderer.domElement.focus();
    else if (previousMode === "drive") this.frameOverview();
  }

  setInputPreferences(preferences: DriveInputPreferences): void {
    this.inputPreferences = {
      gamepadEnabled: preferences.gamepadEnabled,
      steeringSensitivity: Math.max(
        0.5,
        Math.min(1.5, preferences.steeringSensitivity),
      ),
    };
  }

  async updateDefinition(
    definition: WorldDefinition,
    signal?: AbortSignal,
  ): Promise<DefinitionUpdateResult> {
    const previousDefinition = this.definition;
    const previousPlan = this.plan;
    const changedTargets = changedOverrideTargetIds(
      previousDefinition.overrides,
      definition.overrides,
    );
    const settingsChanged =
      deterministicHash(previousDefinition.world.settings) !==
      deterministicHash(definition.world.settings);
    const spawnChanged = changedTargets.some(
      (targetId) =>
        previousDefinition.overrides.some(
          (override) =>
            override.targetId === targetId &&
            override.operation === "set-spawn",
        ) ||
        definition.overrides.some(
          (override) =>
            override.targetId === targetId &&
            override.operation === "set-spawn",
        ),
    );
    const result = await this.builder.build(
      definition,
      this.callbacks.onBuildProgress,
      signal,
    );
    const rebuiltChunkIds = settingsChanged
      ? [
          ...new Set([
            ...previousPlan.chunks.map((chunk) => chunk.id),
            ...result.plan.chunks.map((chunk) => chunk.id),
          ]),
        ].sort()
      : affectedChunkIds(previousPlan, result.plan, changedTargets);

    this.definition = definition;
    this.plan = result.plan;
    this.buildDurationMs = result.durationMs;
    this.lastRebuiltChunks = rebuiltChunkIds.length;
    for (const chunkId of rebuiltChunkIds) {
      this.removeChunk(chunkId);
      const chunk = this.plan.chunks.find((item) => item.id === chunkId);
      if (chunk) {
        this.buildChunk(chunk);
        this.buildChunkPhysics(chunk);
      }
    }
    if (spawnChanged) {
      this.applyConfiguredSpawn(true);
    }
    this.callbacks.onDiagnostics(this.plan.diagnostics);
    this.emitStats();
    return {
      buildHash: this.plan.buildHash,
      rebuiltChunkIds,
      durationMs: result.durationMs,
    };
  }

  cancelBuild(): void {
    this.builder.cancel();
  }

  resetVehicle(toOriginalSpawn = false): void {
    const position = toOriginalSpawn ? this.spawnPosition : this.safePosition;
    const rotation = toOriginalSpawn ? this.spawnRotation : this.safeRotation;
    this.chassis.setTranslation(position, true);
    this.chassis.setRotation(rotation, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentInput = { ...neutralVehicleInput };
    this.unsafeElapsed = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.builder.dispose();
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
    );
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.physics.free();
  }

  private configureScene(): void {
    const night = this.definition.world.settings.visualStyle === "night";
    const size = this.worldSize();
    const sceneScale = Math.max(size.width, size.depth);
    this.scene.background = new THREE.Color(night ? 0x07111f : 0xbad7e8);
    this.scene.fog = new THREE.Fog(
      night ? 0x07111f : 0xbad7e8,
      sceneScale * 1.15,
      sceneScale * 3,
    );
    const hemisphere = new THREE.HemisphereLight(
      night ? 0x7fa9ff : 0xeaf6ff,
      night ? 0x17202d : 0x6d7f57,
      night ? 0.8 : 1.5,
    );
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(
      night ? 0x9bb5e8 : 0xfff3d1,
      night ? 1.2 : 2.6,
    );
    sun.position.set(-180, 260, 110);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2_048, 2_048);
    sun.shadow.camera.left = -700;
    sun.shadow.camera.right = 700;
    sun.shadow.camera.top = 700;
    sun.shadow.camera.bottom = -700;
    this.scene.add(sun);
  }

  private frameOverview(): void {
    const size = this.worldSize();
    const overviewScale = Math.max(size.width, size.depth);
    this.camera.position.set(
      size.centerX + overviewScale * 0.62,
      overviewScale * 0.78,
      size.centerZ + overviewScale * 0.62,
    );
    this.controls.target.set(size.centerX, 0, size.centerZ);
    this.controls.update();
  }

  private worldSize(): {
    width: number;
    depth: number;
    centerX: number;
    centerZ: number;
  } {
    const bounds = this.definition.world.bounds;
    const anchor = this.definition.world.anchor;
    const southwest = wgs84ToLocal(
      { longitude: bounds.west, latitude: bounds.south, height: 0 },
      anchor,
    );
    const northeast = wgs84ToLocal(
      { longitude: bounds.east, latitude: bounds.north, height: 0 },
      anchor,
    );
    return {
      width: Math.max(100, Math.abs(northeast.east - southwest.east) + 80),
      depth: Math.max(100, Math.abs(northeast.north - southwest.north) + 80),
      centerX: (northeast.east + southwest.east) / 2,
      centerZ: -(northeast.north + southwest.north) / 2,
    };
  }

  private buildGround(): void {
    if (this.plan.terrain) {
      const material = new THREE.MeshStandardMaterial({
        color:
          this.definition.world.settings.visualStyle === "night"
            ? 0x18251c
            : 0x88a66b,
        roughness: 0.96,
      });
      for (const chunk of this.plan.terrain.chunks) {
        const ground = new THREE.Mesh(
          geometryFromTerrain(chunk),
          material.clone(),
        );
        ground.receiveShadow = true;
        ground.name = chunk.id;
        ground.userData.permanent = true;
        this.scene.add(ground);
      }
      material.dispose();
      return;
    }
    const size = this.worldSize();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size.width, size.depth),
      new THREE.MeshStandardMaterial({
        color:
          this.definition.world.settings.visualStyle === "night"
            ? 0x18251c
            : 0x88a66b,
        roughness: 0.96,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(size.centerX, 0, size.centerZ);
    ground.receiveShadow = true;
    ground.userData.permanent = true;
    this.scene.add(ground);
  }

  private buildChunk(chunk: WorldChunkPlan): void {
    const group = new THREE.Group();
    group.name = `chunk:${chunk.id}`;
    group.userData.chunkId = chunk.id;

    for (const index of chunk.landIndexes) {
      const area = this.plan.land[index];
      if (!area) continue;
      const shape = shapeFromRings(area.rings);
      if (!shape) continue;
      const color =
        area.kind === "water"
          ? 0x4f9ec4
          : area.classification === "park"
            ? 0x6fa75f
            : 0x839d69;
      const geometry = new THREE.ShapeGeometry(shape);
      conformGeometryToTerrain(geometry, this.plan, 0.018);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.9,
          transparent: area.kind === "water",
          opacity: 0.82,
        }),
      );
      mesh.receiveShadow = true;
      mesh.userData.sourceId = area.sourceId;
      mesh.userData.featureKind = area.kind;
      group.add(mesh);
      this.selectable.push(mesh);
    }

    for (const index of chunk.roadIndexes) {
      const road = this.plan.roads[index];
      if (!road) continue;
      if (road.shoulderMesh) {
        const shoulder = new THREE.Mesh(
          geometryFromSurface(road.shoulderMesh),
          new THREE.MeshStandardMaterial({
            color:
              this.definition.world.settings.visualStyle === "night"
                ? 0x263127
                : 0x758866,
            roughness: 0.98,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }),
        );
        shoulder.receiveShadow = true;
        group.add(shoulder);
      }
      const mesh = new THREE.Mesh(
        geometryFromSurface(road.mesh),
        new THREE.MeshStandardMaterial({
          color: road.tunnel ? 0x252b30 : road.bridge ? 0x48515a : 0x343b42,
          roughness: 0.88,
          metalness: 0.02,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      mesh.receiveShadow = true;
      mesh.userData.sourceId = road.sourceId;
      mesh.userData.featureKind = "road";
      group.add(mesh);
      this.selectable.push(mesh);
    }

    for (const index of chunk.junctionIndexes) {
      const junction = this.plan.junctions[index];
      if (!junction) continue;
      const mesh = new THREE.Mesh(
        geometryFromSurface(junction.mesh),
        new THREE.MeshStandardMaterial({
          color: 0x343b42,
          roughness: 0.88,
        }),
      );
      mesh.receiveShadow = true;
      mesh.userData.sourceId = junction.sourceIds[0];
      mesh.userData.featureKind = "road";
      group.add(mesh);
      this.selectable.push(mesh);
    }

    for (const index of chunk.buildingIndexes) {
      const building = this.plan.buildings[index];
      if (!building) continue;
      const mesh = this.createBuildingMesh(building);
      if (!mesh) continue;
      group.add(mesh);
      this.selectable.push(mesh);
    }
    this.chunkGroups.set(chunk.id, group);
    this.scene.add(group);
  }

  private createBuildingMesh(building: BuildingPlan): THREE.Mesh | undefined {
    const shape = shapeFromRings(building.rings);
    if (!shape) return undefined;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: building.height,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: colorFromId(
          building.sourceId,
          this.definition.world.settings.visualStyle,
        ),
        roughness: 0.82,
      }),
    );
    mesh.position.y = building.baseHeight + 0.02;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.sourceId = building.sourceId;
    mesh.userData.featureKind = "building";
    mesh.userData.heightSource = building.heightSource;
    return mesh;
  }

  private removeChunk(chunkId: string): void {
    const group = this.chunkGroups.get(chunkId);
    if (group) {
      const removed = new Set<THREE.Object3D>();
      group.traverse((object) => removed.add(object));
      for (let index = this.selectable.length - 1; index >= 0; index -= 1) {
        const object = this.selectable[index];
        if (object && removed.has(object)) this.selectable.splice(index, 1);
      }
      this.scene.remove(group);
      disposeObject(group);
      this.chunkGroups.delete(chunkId);
    }
    for (const body of this.chunkBodies.get(chunkId) ?? []) {
      this.physics.removeRigidBody(body);
    }
    this.chunkBodies.delete(chunkId);
  }

  private buildPhysicsGround(): void {
    this.physics.timestep = FIXED_STEP;
    if (this.plan.terrain) {
      for (const chunk of this.plan.terrain.chunks) {
        const body = this.physics.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            (chunk.bounds.minX + chunk.bounds.maxX) / 2,
            0,
            (chunk.bounds.minZ + chunk.bounds.maxZ) / 2,
          ),
        );
        this.physics.createCollider(
          RAPIER.ColliderDesc.heightfield(
            chunk.columns - 1,
            chunk.rows - 1,
            new Float32Array(chunk.heights),
            {
              x: chunk.bounds.maxX - chunk.bounds.minX,
              y: 1,
              z: chunk.bounds.maxZ - chunk.bounds.minZ,
            },
          ).setFriction(1.1),
          body,
        );
      }
      return;
    }
    const size = this.worldSize();
    const groundBody = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        size.centerX,
        -0.15,
        size.centerZ,
      ),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(
        size.width / 2,
        0.15,
        size.depth / 2,
      ).setFriction(1.1),
      groundBody,
    );
  }

  private buildChunkPhysics(chunk: WorldChunkPlan): void {
    const bodies: RAPIER.RigidBody[] = [];
    const addSurfaceCollider = (surface: SurfaceMeshPlan, friction: number) => {
      if (surface.positions.length === 0 || surface.indices.length === 0)
        return;
      const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.physics.createCollider(
        RAPIER.ColliderDesc.trimesh(
          new Float32Array(surface.positions),
          new Uint32Array(surface.indices),
        ).setFriction(friction),
        body,
      );
      bodies.push(body);
    };
    for (const index of chunk.roadIndexes) {
      const road = this.plan.roads[index];
      if (road) addSurfaceCollider(road.mesh, 1.18);
    }
    for (const index of chunk.junctionIndexes) {
      const junction = this.plan.junctions[index];
      if (junction) addSurfaceCollider(junction.mesh, 1.18);
    }
    if (this.definition.world.settings.buildingCollisions) {
      for (const index of chunk.buildingIndexes) {
        const building = this.plan.buildings[index];
        const outer = building?.rings[0];
        if (!building || !outer || outer.length === 0) continue;
        const xs = outer.map((point) => point.x);
        const zs = outer.map((point) => point.z);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);
        const halfX = Math.max(0.2, (maxX - minX) / 2);
        const halfZ = Math.max(0.2, (maxZ - minZ) / 2);
        const body = this.physics.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            (minX + maxX) / 2,
            building.baseHeight + building.height / 2,
            (minZ + maxZ) / 2,
          ),
        );
        this.physics.createCollider(
          RAPIER.ColliderDesc.cuboid(
            halfX,
            building.height / 2,
            halfZ,
          ).setFriction(0.8),
          body,
        );
        bodies.push(body);
      }
    }
    this.chunkBodies.set(chunk.id, bodies);
  }

  private applyConfiguredSpawn(reset: boolean): void {
    const pose = resolveSpawnPose(this.plan, this.definition.overrides);
    this.spawnPosition.set(pose.x, pose.y + 1.4, pose.z);
    this.spawnRotation.setFromEuler(
      new THREE.Euler(pose.pitch, pose.yaw, 0, "YXZ"),
    );
    this.safePosition.copy(this.spawnPosition);
    this.safeRotation.copy(this.spawnRotation);
    if (reset) this.resetVehicle(true);
  }

  private createVehicle(): {
    chassis: RAPIER.RigidBody;
    controller: RAPIER.DynamicRayCastVehicleController;
    visual: VehicleVisual;
  } {
    const pose = resolveSpawnPose(this.plan, this.definition.overrides);
    this.spawnPosition.set(pose.x, pose.y + 1.4, pose.z);
    this.spawnRotation.setFromEuler(
      new THREE.Euler(pose.pitch, pose.yaw, 0, "YXZ"),
    );
    this.safePosition.copy(this.spawnPosition);
    this.safeRotation.copy(this.spawnRotation);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(
        this.spawnPosition.x,
        this.spawnPosition.y,
        this.spawnPosition.z,
      )
      .setRotation(this.spawnRotation)
      .setCanSleep(false)
      .setCcdEnabled(true);
    const chassis = this.physics.createRigidBody(bodyDesc);
    const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
        .setMass(defaultVehicleConfig.chassisMass)
        .setFriction(0.6),
      chassis,
    );
    const controller = this.physics.createVehicleController(chassis);
    controller.indexUpAxis = 1;
    controller.setIndexForwardAxis = 2;
    const wheelConnections = [
      { x: -0.92, y: -0.36, z: -1.42 },
      { x: 0.92, y: -0.36, z: -1.42 },
      { x: -0.92, y: -0.36, z: 1.38 },
      { x: 0.92, y: -0.36, z: 1.38 },
    ];
    wheelConnections.forEach((connection, index) => {
      controller.addWheel(
        connection,
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        defaultVehicleConfig.suspensionRestLength,
        defaultVehicleConfig.wheelRadius,
      );
      controller.setWheelSuspensionStiffness(
        index,
        defaultVehicleConfig.suspensionStiffness,
      );
      controller.setWheelSuspensionCompression(
        index,
        defaultVehicleConfig.suspensionCompression,
      );
      controller.setWheelSuspensionRelaxation(
        index,
        defaultVehicleConfig.suspensionRelaxation,
      );
      controller.setWheelMaxSuspensionForce(
        index,
        defaultVehicleConfig.maxSuspensionForce,
      );
      controller.setWheelFrictionSlip(index, defaultVehicleConfig.frictionSlip);
    });

    const root = new THREE.Group();
    const bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2),
      new THREE.MeshStandardMaterial({
        color: 0xef6c2f,
        roughness: 0.45,
        metalness: 0.2,
      }),
    );
    bodyMesh.castShadow = true;
    root.add(bodyMesh);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.58, 1.75),
      new THREE.MeshStandardMaterial({
        color: 0x9dc7d8,
        roughness: 0.18,
        metalness: 0.22,
      }),
    );
    cabin.position.set(0, 0.62, 0.1);
    cabin.castShadow = true;
    root.add(cabin);
    const wheelGeometry = new THREE.CylinderGeometry(
      defaultVehicleConfig.wheelRadius,
      defaultVehicleConfig.wheelRadius,
      defaultVehicleConfig.wheelWidth,
      18,
    );
    wheelGeometry.rotateZ(Math.PI / 2);
    const wheelMaterial = new THREE.MeshStandardMaterial({
      color: 0x101214,
      roughness: 0.9,
    });
    const wheels = wheelConnections.map((connection) => {
      const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
      wheel.position.copy(connection);
      wheel.castShadow = true;
      root.add(wheel);
      return wheel;
    });
    return { chassis, controller, visual: { root, wheels } };
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(
        event.code,
      )
    )
      event.preventDefault();
    if (event.code === "KeyR") this.resetVehicle(event.shiftKey);
  };

  private readonly keyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    if (this.mode !== "inspect") return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersection = this.raycaster.intersectObjects(
      this.selectable,
      false,
    )[0];
    const match = intersection?.object;
    const sourceId =
      typeof match?.userData.sourceId === "string"
        ? match.userData.sourceId
        : undefined;
    if (!sourceId) {
      this.callbacks.onSelect({});
      return;
    }
    if (match?.userData.featureKind === "road" && intersection) {
      const road = this.plan.roads.find((item) => item.sourceId === sourceId);
      if (road) {
        const pose = closestPointOnRoad(road, {
          x: intersection.point.x,
          z: intersection.point.z,
        });
        this.callbacks.onSelect({
          sourceId,
          point: { x: pose.x, z: pose.z },
        });
        return;
      }
    }
    this.callbacks.onSelect({ sourceId });
  };

  private gamepadInput(): VehicleInput | undefined {
    if (!this.inputPreferences.gamepadEnabled || !navigator.getGamepads) return;
    const gamepad = [...navigator.getGamepads()].find(
      (candidate) => candidate?.connected && candidate.mapping === "standard",
    );
    if (!gamepad) return;
    return standardGamepadInput(
      {
        throttle: gamepad.buttons[7]?.value ?? 0,
        reverse: gamepad.buttons[6]?.value ?? 0,
        steeringAxis: gamepad.axes[0] ?? 0,
        handbrake: gamepad.buttons[0]?.pressed ?? false,
      },
      this.inputPreferences.steeringSensitivity,
    );
  }

  private targetInput(): VehicleInput {
    if (this.mode === "inspect") {
      return {
        throttle: 0,
        brake: 0.75,
        steering: 0,
        handbrake: true,
      };
    }
    const gamepad = this.gamepadInput();
    if (gamepad) {
      this.inputSource = "gamepad";
      return gamepad;
    }
    this.inputSource = "keyboard";
    const forward = this.keys.has("KeyW") || this.keys.has("ArrowUp");
    const reverse = this.keys.has("KeyS") || this.keys.has("ArrowDown");
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    return {
      throttle: forward ? 1 : reverse ? -0.65 : 0,
      brake:
        !forward && !reverse && Math.abs(this.vehicle.currentVehicleSpeed()) > 1
          ? 0.08
          : 0,
      steering:
        (left ? 1 : right ? -1 : 0) * this.inputPreferences.steeringSensitivity,
      handbrake: this.keys.has("Space"),
    };
  }

  private stepPhysics(): void {
    this.currentInput = smoothVehicleInput(
      this.currentInput,
      this.targetInput(),
      FIXED_STEP,
    );
    const engineForce = speedLimitedEngineForce(
      this.currentInput.throttle,
      this.vehicle.currentVehicleSpeed() * 3.6,
    );
    const steering =
      this.currentInput.steering * defaultVehicleConfig.maxSteeringAngle;
    for (const wheel of [0, 1]) {
      this.vehicle.setWheelSteering(wheel, steering);
      this.vehicle.setWheelBrake(
        wheel,
        this.currentInput.brake * defaultVehicleConfig.brakeForce,
      );
    }
    for (const wheel of [2, 3]) {
      this.vehicle.setWheelEngineForce(wheel, engineForce);
      this.vehicle.setWheelBrake(
        wheel,
        this.currentInput.handbrake
          ? defaultVehicleConfig.handbrakeForce
          : this.currentInput.brake * defaultVehicleConfig.brakeForce,
      );
    }
    this.vehicle.updateVehicle(
      FIXED_STEP,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
    );
    this.physics.step();
    this.updateSafeVehicleState(FIXED_STEP);
  }

  private updateSafeVehicleState(deltaSeconds: number): void {
    const position = this.chassis.translation();
    const rotation = this.chassis.rotation();
    const quaternion = new THREE.Quaternion(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    const uprightDot = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).y;
    const size = this.worldSize();
    const inside =
      Math.abs(position.x - size.centerX) < size.width / 2 + 20 &&
      Math.abs(position.z - size.centerZ) < size.depth / 2 + 20;
    const terrainHeight = sampleTerrainPlan(
      this.plan.terrain,
      position.x,
      position.z,
    );
    const relativeHeight = position.y - terrainHeight;
    if (
      isVehiclePoseSafe({
        uprightDot,
        height: relativeHeight,
        insideWorld: inside,
      })
    ) {
      this.unsafeElapsed = 0;
      this.safeElapsed += deltaSeconds;
      if (this.safeElapsed >= 0.6) {
        this.safeElapsed = 0;
        this.safePosition.set(
          position.x,
          Math.max(terrainHeight + 1.1, position.y),
          position.z,
        );
        this.safeRotation.copy(quaternion);
      }
    } else {
      this.safeElapsed = 0;
      this.unsafeElapsed += deltaSeconds;
      if (shouldRecoverVehicle(this.unsafeElapsed, relativeHeight)) {
        this.recoveryCount += 1;
        this.resetVehicle();
      }
    }
  }

  private syncVehicle(deltaSeconds: number): void {
    const position = this.chassis.translation();
    const rotation = this.chassis.rotation();
    this.vehicleVisual.root.position.set(position.x, position.y, position.z);
    this.vehicleVisual.root.quaternion.set(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    const wheelSpin =
      (this.vehicle.currentVehicleSpeed() * deltaSeconds) /
      defaultVehicleConfig.wheelRadius;
    for (const wheel of this.vehicleVisual.wheels)
      wheel.rotation.x += wheelSpin;
    if (this.mode === "drive") {
      const desiredOffset = new THREE.Vector3(0, 3.8, 8.8).applyQuaternion(
        this.vehicleVisual.root.quaternion,
      );
      const desiredPosition = this.vehicleVisual.root.position
        .clone()
        .add(desiredOffset);
      const smoothing = 1 - Math.exp(-deltaSeconds * 6);
      this.camera.position.lerp(desiredPosition, smoothing);
      const lookAt = this.vehicleVisual.root.position
        .clone()
        .add(new THREE.Vector3(0, 1, 0));
      this.camera.lookAt(lookAt);
    }
  }

  private emitStats(): void {
    this.callbacks.onStats({
      roads: this.plan.roads.length,
      buildings: this.plan.buildings.length,
      features: this.plan.featureCount,
      speedKph: Math.round(
        Math.abs(this.vehicle?.currentVehicleSpeed?.() ?? 0) * 3.6,
      ),
      fps: this.fps,
      chunks: this.plan.chunks.length,
      triangles: planTriangles(this.plan),
      terrainTriangles:
        (this.plan.terrain?.chunks.length ?? 0) *
        (this.plan.terrain?.cellsPerChunk ?? 0) ** 2 *
        2,
      terrainChunks: this.plan.terrain?.chunks.length ?? 0,
      elevationProvider: this.plan.terrain?.provider ?? "flat legacy ground",
      elevationRange: this.plan.terrain
        ? this.plan.terrain.sourceMaxHeight - this.plan.terrain.sourceMinHeight
        : 0,
      vehicleElevation: Number(
        (this.chassis?.translation?.().y ?? this.spawnPosition.y).toFixed(1),
      ),
      buildHash: this.plan.buildHash,
      buildDurationMs: Math.round(this.buildDurationMs),
      diagnosticCount: this.plan.diagnostics.length,
      longFrameCount: this.longFrameCount,
      recoveryCount: this.recoveryCount,
      lastRebuiltChunks: this.lastRebuiltChunks,
      inputSource: this.inputSource,
    });
  }

  private readonly animate = (time: number): void => {
    if (this.disposed) return;
    const rawDeltaSeconds = (time - this.previousTime) / 1_000;
    const deltaSeconds = Math.min(rawDeltaSeconds, 0.1);
    if (rawDeltaSeconds > 0.05) this.longFrameCount += 1;
    this.previousTime = time;
    this.accumulator += deltaSeconds;
    while (this.accumulator >= FIXED_STEP) {
      this.stepPhysics();
      this.accumulator -= FIXED_STEP;
    }
    this.syncVehicle(deltaSeconds);
    if (this.mode === "inspect") this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.statsElapsed += deltaSeconds;
    this.fpsElapsed += rawDeltaSeconds;
    this.fpsFrames += 1;
    if (this.fpsElapsed >= 1) {
      this.fps = Math.round(this.fpsFrames / this.fpsElapsed);
      this.fpsElapsed = 0;
      this.fpsFrames = 0;
    }
    if (this.statsElapsed >= 0.25) {
      this.statsElapsed = 0;
      this.emitStats();
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
