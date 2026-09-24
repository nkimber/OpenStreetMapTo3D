import RAPIER from "@dimforge/rapier3d-compat";
import type {
  BuildingCustomization,
  Diagnostic,
  WorldBuildProgress,
  WorldDefinition,
} from "@osm3d/contracts";
import { footprintSignature } from "@osm3d/contracts";
import { localToWgs84, wgs84ToLocal } from "@osm3d/geo";
import {
  defaultVehicleConfig,
  generateRaceCourseCandidates,
  isVehiclePoseSafe,
  nearestRaceProgress,
  neutralVehicleInput,
  racerProximityBrake,
  sampleRaceRoute,
  shouldRecoverVehicle,
  smoothVehicleInput,
  speedAdjustedSteeringAngle,
  speedLimitedEngineForce,
  standardGamepadInput,
  type RaceCourse,
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
  type WorldChunkPlan,
  type WorldPlan,
} from "@osm3d/worldgen";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { vehicleMapPose, type VehicleMapPose } from "./driveMapPose.js";
import { WorldBuilderClient } from "./worldBuilder.js";
import { TerrainRuntime } from "./terrainRuntime.js";
import { createBuildingVisual } from "./buildingVisual.js";
import { buildingCollider } from "./buildingPhysics.js";
import { hasCustomization, openingOnBuilding } from "./buildingEdits.js";
import {
  customizedPlan,
  createCustomizationVisual,
  openingPanels,
} from "./buildingEditVisuals.js";
import { createRoadSigns, disposeRoadSigns } from "./roadSigns.js";
import {
  createRaceScene,
  disposeRaceScene,
  updateRaceScene,
  type RaceScene,
} from "./raceScene.js";
import {
  defaultVehicleChoice,
  loadVehicleModel,
  disposeVehicleModel,
  rivalVehicleChoices,
  type VehicleChoice,
  type ModelVisual,
} from "./vehicleModels.js";

const FIXED_STEP = 1 / 60;
const RACE_COUNTDOWN_SECONDS = 3.3;

export type RacePhase = "countdown" | "racing" | "finished";
export type RaceDifficulty = "casual" | "competitive" | "expert";

export interface RaceCoursePreview {
  id: string;
  title: string;
  lengthMeters: number;
  lapLengthMeters: number;
  laps: number;
  kind: RaceCourse["kind"];
  difficulty: RaceCourse["difficulty"];
  elevationGainMeters: number;
  maxGradePercent: number;
  averageRoadWidthMeters: number;
  turnCount: number;
  qualityScore: number;
  route: Array<[number, number]>;
}

export interface RaceStartOptions {
  courseId?: string;
  targetLength?: number;
  difficulty?: RaceDifficulty;
  roadClosures?: boolean;
}

export interface RaceStats {
  phase: RacePhase;
  countdownLights: number;
  elapsedSeconds: number;
  position: number;
  progressMeters: number;
  lengthMeters: number;
  courseKind: RaceCourse["kind"];
  route: Array<[number, number]>;
  rivals: VehicleMapPose[];
}

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
  vehicleMapPose: VehicleMapPose;
  buildHash: string;
  buildDurationMs: number;
  diagnosticCount: number;
  longFrameCount: number;
  recoveryCount: number;
  lastRebuiltChunks: number;
  inputSource: "keyboard" | "gamepad";
  race?: RaceStats;
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

export type EngineMode = "inspect" | "edit" | "drive";

export interface EditPointer {
  phase: "click" | "move" | "end";
  point: { x: number; y: number; z: number };
  sourceId?: string;
  openingId?: string;
  routeIndex?: number;
  boundaryId?: string;
  boundaryIndex?: number;
}

interface VehicleVisual {
  root: THREE.Group;
  wheels: THREE.Object3D[];
}

interface RaceVehicle {
  chassis: RAPIER.RigidBody;
  controller: RAPIER.DynamicRayCastVehicleController;
  visual: ModelVisual;
  input: VehicleInput;
  progress: number;
  skill: number;
}

interface GridPose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
}

interface RaceSession {
  course: RaceCourse;
  scene: RaceScene;
  phase: RacePhase;
  countdownElapsed: number;
  elapsedSeconds: number;
  countdownLights: number;
  playerProgress: number;
  checkpointIndex: number;
  finishPosition: number;
  gridPoses: GridPose[];
  rivals: RaceVehicle[];
}

const wheelConnections = [
  { x: -0.92, y: -0.36, z: -1.42 },
  { x: 0.92, y: -0.36, z: -1.42 },
  { x: -0.92, y: -0.36, z: 1.38 },
  { x: 0.92, y: -0.36, z: 1.38 },
];

function proceduralVehicleVisual(color: number): VehicleVisual {
  const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
  const root = new THREE.Group();
  const bodyMesh = new THREE.Mesh(
    new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2 }),
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
  return { root, wheels };
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
    if (
      !(object instanceof THREE.Mesh) &&
      !(object instanceof THREE.LineSegments)
    )
      return;
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
  private readonly terrainRuntime = new TerrainRuntime(
    this.scene,
    this.physics,
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly selectable: THREE.Object3D[] = [];
  private readonly keys = new Set<string>();
  private readonly chunkGroups = new Map<string, THREE.Group>();
  private readonly chunkBodies = new Map<string, RAPIER.RigidBody[]>();
  private legacyGround: THREE.Mesh | undefined;
  private roadSigns: THREE.Group | undefined;
  private roadSignsEnabled = false;
  private editPointerHandler: ((event: EditPointer) => void) | undefined;
  private draggingEdit: EditPointer | undefined;
  private highlightCustomizations = false;
  private readonly customizationBodies = new Map<string, RAPIER.RigidBody>();
  private legacyGroundBody: RAPIER.RigidBody | undefined;
  private readonly chassis: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private vehicleVisual: VehicleVisual;
  private loadedVehicle?: ModelVisual;
  private vehicleChoice: VehicleChoice = { ...defaultVehicleChoice };
  private vehicleLoadRevision = 0;
  private raceLoadRevision = 0;
  private garageOpen = false;
  private raceSetupOpen = false;
  private readonly raceCourseCandidates = new Map<string, RaceCourse>();
  private readonly spawnPosition = new THREE.Vector3();
  private readonly spawnRotation = new THREE.Quaternion();
  private readonly safePosition = new THREE.Vector3();
  private readonly safeRotation = new THREE.Quaternion();
  private race: RaceSession | undefined;
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
    this.syncCustomizationPhysics();
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
    this.renderer.domElement.addEventListener(
      "pointermove",
      this.editPointerMove,
    );
    this.renderer.domElement.addEventListener("pointerup", this.editPointerUp);
    this.renderer.domElement.addEventListener(
      "pointercancel",
      this.editPointerUp,
    );
    this.resize();
    this.callbacks.onDiagnostics(this.plan.diagnostics);
    this.emitStats();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setGarageOpen(open: boolean): void {
    this.garageOpen = open;
    this.keys.clear();
    this.currentInput = { ...neutralVehicleInput };
    if (!open && this.mode === "drive") this.renderer.domElement.focus();
  }

  setRaceSetupOpen(open: boolean): void {
    this.raceSetupOpen = open;
    this.keys.clear();
    this.currentInput = { ...neutralVehicleInput };
    if (!open && this.mode === "drive") this.renderer.domElement.focus();
  }

  setRoadSignsEnabled(enabled: boolean): void {
    this.roadSignsEnabled = enabled;
    if (enabled && !this.roadSigns) {
      this.roadSigns = createRoadSigns(this.plan);
      this.scene.add(this.roadSigns);
    }
    if (this.roadSigns) this.roadSigns.visible = enabled;
  }

  async setVehicle(choice: VehicleChoice): Promise<void> {
    const revision = ++this.vehicleLoadRevision;
    const model = await loadVehicleModel(choice);
    if (this.disposed || revision !== this.vehicleLoadRevision) {
      disposeVehicleModel(model.root);
      return;
    }
    this.cancelRace();
    const previous = this.vehicleVisual.root;
    model.root.position.copy(previous.position);
    model.root.quaternion.copy(previous.quaternion);
    this.scene.remove(previous);
    disposeVehicleModel(previous);
    this.vehicleVisual = model;
    this.loadedVehicle = model;
    this.vehicleChoice = { ...choice };
    model.connections.forEach((connection, index) =>
      this.vehicle.setWheelChassisConnectionPointCs(index, connection),
    );
    this.scene.add(model.root);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  setMode(mode: EngineMode): void {
    const previousMode = this.mode;
    if (mode !== "drive") this.cancelRace();
    if (mode !== "drive") this.raceSetupOpen = false;
    this.mode = mode;
    this.controls.enabled = mode !== "drive";
    this.refreshBuildingVisuals();
    if (mode === "drive") this.renderer.domElement.focus();
    else if (previousMode === "drive") this.frameOverview();
  }

  getEditContext() {
    return { plan: this.plan, definition: this.definition };
  }

  setEditPointerHandler(handler?: (event: EditPointer) => void): void {
    this.editPointerHandler = handler;
  }

  setCustomizationPreview(
    values: BuildingCustomization[],
    highlight = this.highlightCustomizations,
  ): void {
    if (this.disposed) return;
    const previous = new Map(
      this.definition.buildingCustomizations?.map((item) => [
        item.sourceId,
        item,
      ]),
    );
    const changed = new Set(
      values
        .filter(
          (item) =>
            deterministicHash(previous.get(item.sourceId) ?? null) !==
            deterministicHash(item),
        )
        .map((item) => item.sourceId),
    );
    for (const id of previous.keys())
      if (!values.some((item) => item.sourceId === id)) changed.add(id);
    const all = highlight !== this.highlightCustomizations;
    this.definition = { ...this.definition, buildingCustomizations: values };
    this.highlightCustomizations = highlight;
    this.refreshBuildingVisuals(all ? undefined : changed);
    this.syncCustomizationPhysics(all ? undefined : changed);
  }

  focusBuilding(sourceId: string): void {
    const building = this.plan.buildings.find(
      (item) => item.sourceId === sourceId,
    );
    if (!building) return;
    const ring = building.rings[0]!;
    const x = ring.reduce((sum, point) => sum + point.x, 0) / ring.length;
    const z = ring.reduce((sum, point) => sum + point.z, 0) / ring.length;
    this.controls.target.set(x, building.baseHeight + 2, z);
    const size = Math.max(
      15,
      ...ring.map((point) => Math.hypot(point.x - x, point.z - z) * 2),
    );
    this.camera.position.set(
      x + size,
      building.baseHeight + size * 0.8,
      z + size,
    );
    this.controls.update();
  }

  private refreshBuildingVisuals(changed?: Set<string>): void {
    for (const chunk of this.plan.chunks) {
      const group = this.chunkGroups.get(chunk.id);
      if (!group) continue;
      for (const child of [...group.children]) {
        if (!child.userData.buildingVisual) continue;
        if (changed && !changed.has(child.userData.buildingSourceId as string))
          continue;
        const index = this.selectable.indexOf(child);
        if (index >= 0) this.selectable.splice(index, 1);
        child.removeFromParent();
        disposeObject(child);
      }
      for (const index of chunk.buildingIndexes) {
        const building = this.plan.buildings[index];
        if (building && changed && !changed.has(building.sourceId)) continue;
        const mesh = building && this.createBuildingMesh(building);
        if (mesh) {
          group.add(mesh);
          this.selectable.push(mesh);
        }
      }
    }
  }

  private syncCustomizationPhysics(changed?: Set<string>): void {
    for (const [id, body] of this.customizationBodies) {
      if (changed && !changed.has(id)) continue;
      this.physics.removeRigidBody(body);
      this.customizationBodies.delete(id);
    }
    for (const group of this.chunkGroups.values()) {
      for (const building of group.children) {
        const id = building.userData.buildingSourceId as string | undefined;
        if (!id || (changed && !changed.has(id))) continue;
        let body = this.customizationBodies.get(id);
        building.traverse((object) => {
          if (!(object instanceof THREE.Mesh) || !object.userData.route) return;
          const positions = object.geometry.getAttribute("position");
          if (!positions.count) return;
          body ??= this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
          this.physics.createCollider(
            RAPIER.ColliderDesc.trimesh(
              new Float32Array(positions.array),
              Uint32Array.from(
                { length: positions.count },
                (_, index) => index,
              ),
            ).setFriction(1.1),
            body,
          );
        });
        if (body) this.customizationBodies.set(id, body);
      }
    }
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
    if (this.race) this.cancelRace();
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

    this.terrainRuntime.sync(
      result.plan,
      definition.world.settings.visualStyle === "night",
    );
    this.definition = definition;
    this.plan = result.plan;
    if (this.roadSigns) disposeRoadSigns(this.roadSigns);
    this.roadSigns = undefined;
    this.setRoadSignsEnabled(this.roadSignsEnabled);
    this.removeLegacyGround();
    if (!this.plan.terrain) {
      this.buildGround();
      this.buildPhysicsGround();
    }
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
    this.refreshBuildingVisuals();
    this.syncCustomizationPhysics();
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
    if (this.race && toOriginalSpawn) this.cancelRace();
    const position = toOriginalSpawn ? this.spawnPosition : this.safePosition;
    const rotation = toOriginalSpawn ? this.spawnRotation : this.safeRotation;
    this.chassis.setTranslation(position, true);
    this.chassis.setRotation(rotation, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentInput = { ...neutralVehicleInput };
    this.unsafeElapsed = 0;
  }

  previewRaceCourses(targetLength = 1_000, variation = 0): RaceCoursePreview[] {
    const position = this.chassis.translation();
    const rotation = this.chassis.rotation();
    const heading = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    );
    heading.applyAxisAngle(new THREE.Vector3(0, 1, 0), variation * 0.37);
    const courses = generateRaceCourseCandidates(
      this.raceRoads(),
      position,
      heading,
      { targetLength, candidateCount: 3 },
    );
    this.raceCourseCandidates.clear();
    return courses.map((course, index) => {
      const id = `${variation}-${index}-${Math.round(course.length)}-${course.qualityScore}`;
      this.raceCourseCandidates.set(id, course);
      const route = this.raceRouteCoordinates(course);
      const descriptor =
        course.kind === "loop"
          ? course.difficulty === "Easy"
            ? "Flowing Circuit"
            : course.difficulty === "Technical"
              ? "Technical Circuit"
              : "Challenge Circuit"
          : "Road Sprint";
      return {
        id,
        title: `${descriptor} ${index + 1}`,
        lengthMeters: course.length,
        lapLengthMeters: course.lapLength,
        laps: course.laps,
        kind: course.kind,
        difficulty: course.difficulty,
        elevationGainMeters: course.elevationGain,
        maxGradePercent: course.maxGrade * 100,
        averageRoadWidthMeters: course.averageRoadWidth,
        turnCount: course.turnDistances.length,
        qualityScore: course.qualityScore,
        route,
      };
    });
  }

  async startRace(options: RaceStartOptions = {}): Promise<string | undefined> {
    if (this.mode !== "drive")
      return "Enter Drive mode before starting a race.";
    this.cancelRace();
    const revision = ++this.raceLoadRevision;
    const course =
      (options.courseId
        ? this.raceCourseCandidates.get(options.courseId)
        : undefined) ??
      (() => {
        const previews = this.previewRaceCourses(options.targetLength ?? 1_000);
        return previews[0]
          ? this.raceCourseCandidates.get(previews[0].id)
          : undefined;
      })();
    if (!course)
      return `This road network cannot support the selected ${((options.targetLength ?? 1_000) / 1_000).toFixed(0)} km race.`;

    const modelResults = await Promise.allSettled(
      rivalVehicleChoices(this.vehicleChoice).map(loadVehicleModel),
    );
    const models: ModelVisual[] = [];
    let modelLoadFailed = false;
    for (const result of modelResults) {
      if (result.status === "fulfilled") models.push(result.value);
      else modelLoadFailed = true;
    }
    if (
      this.disposed ||
      revision !== this.raceLoadRevision ||
      this.mode !== "drive"
    ) {
      models.forEach((model) => disposeVehicleModel(model.root));
      return undefined;
    }
    if (modelLoadFailed || models.length !== 3) {
      models.forEach((model) => disposeVehicleModel(model.root));
      return "The matching race cars could not load. Please try again.";
    }

    const scene = createRaceScene(course, {
      roadClosures: options.roadClosures ?? true,
    });
    this.scene.add(scene.root);
    const gridPoses = this.raceGridPoses(course);
    const playerPose = gridPoses[0]!;
    this.placeRigidBody(this.chassis, playerPose);
    this.safePosition.copy(playerPose.position);
    this.safeRotation.copy(playerPose.rotation);
    const skills = [0.88, 0.82, 0.76];
    const rivals = models.map((model, index) => {
      const pose = gridPoses[index + 1]!;
      const rival = this.createRaceVehicle(pose, model, skills[index]!);
      this.scene.add(rival.visual.root);
      return rival;
    });
    this.currentInput = { ...neutralVehicleInput };
    this.race = {
      course,
      scene,
      phase: "countdown",
      countdownElapsed: 0,
      elapsedSeconds: 0,
      countdownLights: 1,
      playerProgress: 0,
      checkpointIndex: 0,
      finishPosition: 1,
      gridPoses,
      rivals,
    };
    this.raceSetupOpen = false;
    updateRaceScene(scene, 1, 0, 0);
    this.emitStats();
    return undefined;
  }

  cancelRace(): void {
    this.raceLoadRevision += 1;
    const race = this.race;
    if (!race) return;
    for (const rival of race.rivals) {
      this.scene.remove(rival.visual.root);
      disposeVehicleModel(rival.visual.root);
      this.physics.removeVehicleController(rival.controller);
      this.physics.removeRigidBody(rival.chassis);
    }
    this.scene.remove(race.scene.root);
    disposeRaceScene(race.scene);
    this.race = undefined;
    this.emitStats();
  }

  private raceRoads() {
    const roadFeatures = new Map(
      this.definition.features
        .filter((feature) => feature.kind === "road")
        .map((feature) => [feature.sourceId, feature]),
    );
    const excludedHighways = new Set([
      "cycleway",
      "footway",
      "path",
      "pedestrian",
      "steps",
      "track",
    ]);
    return this.plan.roads.flatMap((road) => {
      const tags = roadFeatures.get(road.sourceId)?.tags ?? {};
      if (
        road.width < 4.2 ||
        excludedHighways.has(tags.highway ?? "") ||
        ["no", "private"].includes(tags.access ?? "") ||
        ["no", "private"].includes(tags.motor_vehicle ?? "") ||
        ["driveway", "parking_aisle"].includes(tags.service ?? "") ||
        tags.area === "yes"
      )
        return [];
      return [
        {
          id: road.sourceId,
          width: road.width,
          layer: road.layer,
          points: road.points,
        },
      ];
    });
  }

  private raceRouteCoordinates(course: RaceCourse): Array<[number, number]> {
    return course.points
      .filter(
        (_, index) => index % 3 === 0 || index === course.points.length - 1,
      )
      .map((point): [number, number] => {
        const location = localToWgs84(
          { east: point.x, north: -point.z, up: point.y },
          this.definition.world.anchor,
        );
        return [location.longitude, location.latitude];
      });
  }

  dispose(): void {
    this.cancelRace();
    if (this.roadSigns) disposeRoadSigns(this.roadSigns);
    this.scene.remove(this.vehicleVisual.root);
    disposeVehicleModel(this.vehicleVisual.root);
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
    this.renderer.domElement.removeEventListener(
      "pointermove",
      this.editPointerMove,
    );
    this.renderer.domElement.removeEventListener(
      "pointerup",
      this.editPointerUp,
    );
    this.renderer.domElement.removeEventListener(
      "pointercancel",
      this.editPointerUp,
    );
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
    sun.shadow.normalBias = 0.2;
    sun.shadow.bias = -0.0005;
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
      this.terrainRuntime.sync(
        this.plan,
        this.definition.world.settings.visualStyle === "night",
      );
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
    this.legacyGround = ground;
    this.scene.add(ground);
  }

  private removeLegacyGround(): void {
    if (this.legacyGround) {
      this.scene.remove(this.legacyGround);
      disposeObject(this.legacyGround);
      this.legacyGround = undefined;
    }
    if (this.legacyGroundBody) {
      this.physics.removeRigidBody(this.legacyGroundBody);
      this.legacyGroundBody = undefined;
    }
  }

  private buildChunk(chunk: WorldChunkPlan): void {
    const group = new THREE.Group();
    group.name = `chunk:${chunk.id}`;
    group.userData.chunkId = chunk.id;

    for (const index of chunk.landIndexes) {
      // Terrain worlds paint land use onto the terrain itself; no large overlay
      // triangles can span a road cutting. Legacy flat worlds retain overlays.
      if (this.plan.terrain) continue;
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

  private createBuildingMesh(building: BuildingPlan): THREE.Group | undefined {
    const feature = this.definition.features.find(
      (item) => item.sourceId === building.sourceId,
    );
    const saved = this.definition.buildingCustomizations?.find(
      (item) => item.sourceId === building.sourceId,
    );
    const custom =
      feature && saved?.footprint === footprintSignature(feature.geometry)
        ? {
            ...saved,
            openings: saved.openings.filter((opening) =>
              openingOnBuilding(opening, building, this.definition),
            ),
            boundaries:
              this.plan.buildings.find(
                (item) => item.sourceId === building.sourceId,
              ) === building
                ? saved.boundaries
                : [],
          }
        : undefined;
    const updated = customizedPlan(building, custom);
    const house = createBuildingVisual(
      updated,
      this.definition.world.settings.visualStyle === "colorful",
      openingPanels(custom, this.definition),
    );
    if (!house) return undefined;
    const group = new THREE.Group();
    group.userData.buildingVisual = true;
    group.userData.buildingSourceId = building.sourceId;
    group.add(house);
    if (custom)
      group.add(
        createCustomizationVisual(
          updated,
          custom,
          this.definition,
          this.plan,
          this.mode === "edit",
        ),
      );
    if (this.highlightCustomizations && hasCustomization(saved)) {
      const box = new THREE.BoxHelper(house, custom ? 0x4ce0a1 : 0xffab40);
      group.add(box);
    }
    return group;
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
      // TerrainRuntime installed matching colliders with the visible ground.
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
    this.legacyGroundBody = groundBody;
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
        if (!building) continue;
        const collider = buildingCollider(building);
        if (!collider) continue;
        const body = this.physics.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            0,
            building.baseHeight,
            0,
          ),
        );
        this.physics.createCollider(collider, body);
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
    return this.createPhysicsVehicle(
      this.spawnPosition,
      this.spawnRotation,
      proceduralVehicleVisual(0xef6c2f),
    );
  }

  private createPhysicsVehicle(
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    visual: VehicleVisual,
  ): {
    chassis: RAPIER.RigidBody;
    controller: RAPIER.DynamicRayCastVehicleController;
    visual: VehicleVisual;
  } {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setCanSleep(false)
      .setCcdEnabled(true);
    const chassis = this.physics.createRigidBody(bodyDesc);
    const [halfX, halfY, halfZ] = defaultVehicleConfig.chassisHalfExtents;
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
        .setTranslation(0, defaultVehicleConfig.chassisCenterOfMassOffsetY, 0)
        .setMass(defaultVehicleConfig.chassisMass)
        .setFriction(0.6),
      chassis,
    );
    const controller = this.physics.createVehicleController(chassis);
    controller.indexUpAxis = 1;
    controller.setIndexForwardAxis = 2;
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

    return { chassis, controller, visual };
  }

  private createRaceVehicle(
    pose: GridPose,
    model: ModelVisual,
    skill: number,
  ): RaceVehicle {
    const vehicle = this.createPhysicsVehicle(
      pose.position,
      pose.rotation,
      model,
    );
    model.connections.forEach((connection, index) =>
      vehicle.controller.setWheelChassisConnectionPointCs(index, connection),
    );
    return {
      ...vehicle,
      visual: model,
      input: { ...neutralVehicleInput },
      progress: 0,
      skill,
    };
  }

  private raceGridPoses(course: RaceCourse): GridPose[] {
    const start = course.points[0]!;
    const next = sampleRaceRoute(course, 8);
    const direction = new THREE.Vector3(
      next.x - start.x,
      0,
      next.z - start.z,
    ).normalize();
    const right = new THREE.Vector3(-direction.z, 0, direction.x);
    const yaw = Math.atan2(-direction.x, -direction.z);
    const pitch = Math.atan2(
      next.y - start.y,
      Math.hypot(next.x - start.x, next.z - start.z),
    );
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitch, yaw, 0, "YXZ"),
    );
    const slots =
      course.roadWidth >= 6.5
        ? [
            { back: 2.5, side: -1.25 },
            { back: 2.5, side: 1.25 },
            { back: 8, side: -1.25 },
            { back: 8, side: 1.25 },
          ]
        : [2.5, 8, 13.5, 19].map((back) => ({ back, side: 0 }));
    return slots.map(({ back, side }) => ({
      position: new THREE.Vector3(
        start.x - direction.x * back + right.x * side,
        start.y + 1.4,
        start.z - direction.z * back + right.z * side,
      ),
      rotation: rotation.clone(),
    }));
  }

  private placeRigidBody(body: RAPIER.RigidBody, pose: GridPose): void {
    body.setTranslation(pose.position, true);
    body.setRotation(pose.rotation, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (
      this.garageOpen ||
      (event.target instanceof Element &&
        event.target.closest("input, select, textarea, dialog"))
    )
      return;
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
    if (this.mode === "edit" && this.editPointerHandler) {
      const hit = this.editHit(event);
      if (hit) {
        if (hit.openingId || hit.boundaryId) {
          this.draggingEdit = hit;
          this.controls.enabled = false;
          this.renderer.domElement.setPointerCapture(event.pointerId);
        }
        this.editPointerHandler(hit);
      }
      return;
    }
    if (this.mode !== "inspect") return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersection = this.raycaster.intersectObjects(
      this.selectable,
      true,
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

  private editHit(
    event: PointerEvent,
    dragging = false,
  ): EditPointer | undefined {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster
      .intersectObjects(this.scene.children, true)
      .filter(
        (hit) =>
          hit.object instanceof THREE.Mesh &&
          !hit.object.userData.route &&
          !this.vehicleVisual.root.getObjectById(hit.object.id),
      );
    const hit = dragging
      ? hits.find(
          (candidate) =>
            !candidate.object.userData.openingId &&
            !candidate.object.userData.boundaryId,
        )
      : (hits.find(
          (candidate) =>
            candidate.object.userData.openingId ||
            candidate.object.userData.boundaryId,
        ) ?? hits[0]);
    if (!hit) return undefined;
    const data = hit.object.userData;
    return {
      phase: "click",
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      sourceId: data.sourceId,
      openingId: data.openingId,
      routeIndex: data.routeIndex,
      boundaryId: data.boundaryId,
      boundaryIndex: data.boundaryIndex,
    };
  }

  private readonly editPointerMove = (event: PointerEvent): void => {
    if (!this.draggingEdit) return;
    const hit = this.editHit(event, true);
    if (hit)
      this.editPointerHandler?.({
        ...this.draggingEdit,
        phase: "move",
        point: hit.point,
      });
  };
  private readonly editPointerUp = (event: PointerEvent): void => {
    if (!this.draggingEdit) return;
    this.editPointerHandler?.({ ...this.draggingEdit, phase: "end" });
    this.draggingEdit = undefined;
    this.controls.enabled = this.mode !== "drive";
    if (this.renderer.domElement.hasPointerCapture(event.pointerId))
      this.renderer.domElement.releasePointerCapture(event.pointerId);
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
    if (
      this.mode !== "drive" ||
      this.garageOpen ||
      this.raceSetupOpen ||
      (this.race && this.race.phase !== "racing")
    ) {
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
    this.applyVehicleInput(this.vehicle, this.currentInput);
    if (this.race) {
      for (const rival of this.race.rivals) {
        const target =
          this.race.phase === "racing"
            ? this.raceAiInput(this.race, rival)
            : { throttle: 0, brake: 1, steering: 0, handbrake: true };
        rival.input =
          target.brake >= 0.95 && target.throttle === 0
            ? { ...target }
            : smoothVehicleInput(rival.input, target, FIXED_STEP);
        this.applyVehicleInput(rival.controller, rival.input);
      }
    }
    this.physics.step();
    if (this.race) this.advanceRace(this.race);
    this.updateSafeVehicleState(FIXED_STEP);
  }

  private applyVehicleInput(
    vehicle: RAPIER.DynamicRayCastVehicleController,
    input: VehicleInput,
  ): void {
    const engineForce = speedLimitedEngineForce(
      input.throttle,
      vehicle.currentVehicleSpeed() * 3.6,
    );
    const steering = speedAdjustedSteeringAngle(
      input.steering,
      vehicle.currentVehicleSpeed() * 3.6,
    );
    for (const wheel of [0, 1]) {
      vehicle.setWheelSteering(wheel, steering);
      vehicle.setWheelBrake(
        wheel,
        input.brake * defaultVehicleConfig.brakeForce,
      );
    }
    for (const wheel of [2, 3]) {
      vehicle.setWheelEngineForce(wheel, engineForce);
      vehicle.setWheelBrake(
        wheel,
        input.handbrake
          ? defaultVehicleConfig.handbrakeForce
          : input.brake * defaultVehicleConfig.brakeForce,
      );
    }
    vehicle.updateVehicle(FIXED_STEP, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  }

  private raceAiInput(race: RaceSession, rival: RaceVehicle): VehicleInput {
    const position = rival.chassis.translation();
    rival.progress = nearestRaceProgress(race.course, position, rival.progress);
    const speedKph = Math.abs(rival.controller.currentVehicleSpeed()) * 3.6;
    const lookAhead = 10 + Math.min(14, speedKph * 0.16);
    const target = sampleRaceRoute(
      race.course,
      Math.min(race.course.length, rival.progress + lookAhead),
    );
    const rotation = rival.chassis.rotation();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    );
    const desired = new THREE.Vector3(
      target.x - position.x,
      0,
      target.z - position.z,
    ).normalize();
    const cross = forward.z * desired.x - forward.x * desired.z;
    const dot = Math.max(
      -1,
      Math.min(1, forward.x * desired.x + forward.z * desired.z),
    );
    const angle = Math.atan2(cross, dot);
    const steering = Math.max(-1, Math.min(1, angle * 1.55));
    const targetSpeed =
      (24 + (1 - Math.min(1, Math.abs(angle))) * 42) * rival.skill;
    let proximityBrake = 0;
    for (const other of [
      this.chassis,
      ...race.rivals
        .filter((candidate) => candidate !== rival)
        .map((candidate) => candidate.chassis),
    ]) {
      const otherPosition = other.translation();
      proximityBrake = Math.max(
        proximityBrake,
        racerProximityBrake({
          forwardX: forward.x,
          forwardZ: forward.z,
          offsetX: otherPosition.x - position.x,
          offsetZ: otherPosition.z - position.z,
        }),
      );
    }
    const routeBrake = speedKph > targetSpeed + 5 ? 0.55 : 0;
    return {
      throttle:
        proximityBrake > 0.05 ? 0 : speedKph < targetSpeed ? rival.skill : 0,
      brake: Math.max(routeBrake, proximityBrake),
      steering,
      handbrake:
        proximityBrake === 0 && Math.abs(angle) > 1.15 && speedKph > 28,
    };
  }

  private advanceRace(race: RaceSession): void {
    if (race.phase === "countdown") {
      race.countdownElapsed += FIXED_STEP;
      race.countdownLights = Math.min(3, Math.floor(race.countdownElapsed) + 1);
      this.placeRigidBody(this.chassis, race.gridPoses[0]!);
      race.rivals.forEach((rival, index) =>
        this.placeRigidBody(rival.chassis, race.gridPoses[index + 1]!),
      );
      if (race.countdownElapsed >= RACE_COUNTDOWN_SECONDS) {
        race.phase = "racing";
        race.countdownLights = 0;
        this.currentInput = { ...neutralVehicleInput };
        for (const rival of race.rivals)
          rival.input = { ...neutralVehicleInput };
      }
    } else if (race.phase === "racing") {
      race.elapsedSeconds += FIXED_STEP;
      const position = this.chassis.translation();
      race.playerProgress = nearestRaceProgress(
        race.course,
        position,
        race.playerProgress,
      );
      const checkpointDistance =
        race.course.checkpointDistances[race.checkpointIndex];
      if (checkpointDistance !== undefined) {
        const checkpoint = sampleRaceRoute(race.course, checkpointDistance);
        const separation = Math.hypot(
          position.x - checkpoint.x,
          position.z - checkpoint.z,
        );
        if (
          race.playerProgress >= checkpointDistance - 12 &&
          separation <= Math.max(3.5, race.course.roadWidth * 0.62)
        )
          race.checkpointIndex += 1;
      }
      if (
        race.checkpointIndex >= race.course.checkpointDistances.length &&
        race.elapsedSeconds > 5
      ) {
        race.finishPosition = this.racePosition(race);
        race.phase = "finished";
      }
    }
    updateRaceScene(
      race.scene,
      race.countdownLights,
      race.playerProgress,
      race.checkpointIndex,
    );
  }

  private racePosition(race: RaceSession): number {
    return (
      1 +
      race.rivals.filter((rival) => rival.progress > race.playerProgress).length
    );
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
    this.vehicleVisual.wheels.forEach((wheel, index) => {
      wheel.rotation.order = "YXZ";
      wheel.rotation.x += wheelSpin;
      wheel.rotation.y = this.vehicle.wheelSteering(index) ?? 0;
      const connection = this.loadedVehicle?.connections[index];
      if (connection)
        wheel.position.y =
          connection.y -
          (this.vehicle.wheelSuspensionLength(index) ??
            defaultVehicleConfig.suspensionRestLength);
    });
    if (this.loadedVehicle)
      this.loadedVehicle.brake.value =
        this.currentInput.brake > 0.2 || this.currentInput.handbrake ? 1 : 0;
    for (const rival of this.race?.rivals ?? [])
      this.syncRaceVehicle(rival, deltaSeconds);
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

  private syncRaceVehicle(rival: RaceVehicle, deltaSeconds: number): void {
    const position = rival.chassis.translation();
    const rotation = rival.chassis.rotation();
    rival.visual.root.position.set(position.x, position.y, position.z);
    rival.visual.root.quaternion.set(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    const spin =
      (rival.controller.currentVehicleSpeed() * deltaSeconds) /
      defaultVehicleConfig.wheelRadius;
    rival.visual.wheels.forEach((wheel, index) => {
      wheel.rotation.order = "YXZ";
      wheel.rotation.x += spin;
      wheel.rotation.y = rival.controller.wheelSteering(index) ?? 0;
      const connection = rival.visual.connections[index];
      if (connection)
        wheel.position.y =
          connection.y -
          (rival.controller.wheelSuspensionLength(index) ??
            defaultVehicleConfig.suspensionRestLength);
    });
    rival.visual.brake.value =
      rival.input.brake > 0.2 || rival.input.handbrake ? 1 : 0;
  }

  private raceStats(race: RaceSession): RaceStats {
    const route = this.raceRouteCoordinates(race.course);
    const rivals = race.rivals.map((rival) =>
      vehicleMapPose(
        rival.chassis.translation(),
        rival.chassis.rotation(),
        this.definition.world.anchor,
      ),
    );
    return {
      phase: race.phase,
      countdownLights: race.countdownLights,
      elapsedSeconds: race.elapsedSeconds,
      position:
        race.phase === "finished"
          ? race.finishPosition
          : this.racePosition(race),
      progressMeters: race.playerProgress,
      lengthMeters: race.course.length,
      courseKind: race.course.kind,
      route,
      rivals,
    };
  }

  private emitStats(): void {
    const vehiclePosition = this.chassis.translation();
    const vehicleRotation = this.chassis.rotation();
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
        this.plan.terrain?.chunks.reduce(
          (sum, chunk) =>
            sum +
            (chunk.mesh
              ? chunk.mesh.indices.length / 3
              : (chunk.rows - 1) * (chunk.columns - 1) * 2),
          0,
        ) ?? 0,
      terrainChunks: this.plan.terrain?.chunks.length ?? 0,
      elevationProvider: this.plan.terrain?.provider ?? "flat legacy ground",
      elevationRange: this.plan.terrain
        ? this.plan.terrain.sourceMaxHeight - this.plan.terrain.sourceMinHeight
        : 0,
      vehicleElevation: Number(vehiclePosition.y.toFixed(1)),
      vehicleMapPose: vehicleMapPose(
        vehiclePosition,
        vehicleRotation,
        this.definition.world.anchor,
      ),
      buildHash: this.plan.buildHash,
      buildDurationMs: Math.round(this.buildDurationMs),
      diagnosticCount: this.plan.diagnostics.length,
      longFrameCount: this.longFrameCount,
      recoveryCount: this.recoveryCount,
      lastRebuiltChunks: this.lastRebuiltChunks,
      inputSource: this.inputSource,
      ...(this.race ? { race: this.raceStats(this.race) } : {}),
    });
  }

  private readonly animate = (time: number): void => {
    if (this.disposed) return;
    if (this.garageOpen) {
      // Keep the world frozen behind the modal instead of rendering two scenes.
      this.previousTime = time;
      this.accumulator = 0;
      this.animationFrame = requestAnimationFrame(this.animate);
      return;
    }
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
    if (this.mode !== "drive") this.controls.update();
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
