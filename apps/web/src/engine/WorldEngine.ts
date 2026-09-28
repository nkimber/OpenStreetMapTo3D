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
  vehicleHandling as vehicleHandlingProfile,
  type VehicleChoice,
  type VehicleHandling,
  type ModelVisual,
} from "./vehicleModels.js";
import {
  MAX_FLIGHT_ALTITUDE,
  TRANSFORM_SECONDS,
  boundaryPush,
  createFlightState,
  createHelicopterKit,
  flightAirspeedKph,
  headingDegrees,
  neutralFlightInput,
  stepFlight,
  type FlightForm,
  type FlightInput,
  type HelicopterKit,
} from "./helicopter.js";
import {
  CombatEffects,
  ROCKET_COOLDOWN_SECONDS,
  ROCKET_SPEED,
} from "./combat.js";

const FIXED_STEP = 1 / 60;
const RACE_COUNTDOWN_SECONDS = 3.3;
const RACE_MISSILE_COOLDOWN_SECONDS = 1;
const RACE_MISSILE_SPEED = 95;

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
  difficulty: RaceDifficulty;
  currentLap: number;
  laps: number;
  draftBoost: number;
  splitTimes: number[];
  lastSplitDelta?: number;
  warning?: string;
  positionChange?: { from: number; to: number };
  results?: RaceResult[];
  route: Array<[number, number]>;
  rivals: RaceRivalStats[];
}

export interface RaceRivalStats extends VehicleMapPose {
  name: string;
  color: string;
}

export interface RaceResult {
  position: number;
  name: string;
  color: string;
  player: boolean;
  finished: boolean;
  timeSeconds?: number;
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
  flight?: FlightStats;
  flightNotice?: string;
  destroyedBuildings: number;
}

export interface FlightStats {
  form: Exclude<FlightForm, "car">;
  altitudeMeters: number;
  airspeedKph: number;
  headingDegrees: number;
  grounded: boolean;
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
  name: string;
  color: string;
  personality: RivalPersonality;
  laneOffset: number;
  targetLaneOffset: number;
  stuckSeconds: number;
  powerMultiplier: number;
  checkpointTimes: number[];
  /** Set while a missile hit has the rival spinning or airborne. */
  hit?: { kind: "spin" | "flip"; elapsed: number; settled: number };
  finishTime?: number;
}

interface RivalPersonality {
  style: "cautious" | "balanced" | "aggressive";
  speedFactor: number;
  brakingMargin: number;
  passingBias: number;
  mistakeAmount: number;
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
  difficulty: RaceDifficulty;
  warning?: string;
  notice?: { text: string; expiresAt: number };
  wrongWaySeconds: number;
  offCourseSeconds: number;
  falseStart: boolean;
  splitTimes: number[];
  lastSplitDelta?: number;
  previousPosition: number;
  positionChange?: { from: number; to: number; expiresAt: number };
  playerFinishTime?: number;
  gridPoses: GridPose[];
  rivals: RaceVehicle[];
}

const difficultyProfiles: Record<
  RaceDifficulty,
  { skill: number; catchUp: number; mistakeScale: number }
> = {
  casual: { skill: 0.86, catchUp: 0.025, mistakeScale: 1.25 },
  competitive: { skill: 0.97, catchUp: 0.055, mistakeScale: 0.7 },
  expert: { skill: 1.06, catchUp: 0.075, mistakeScale: 0.35 },
};

const rivalPersonalities: RivalPersonality[] = [
  {
    style: "aggressive",
    speedFactor: 1.04,
    brakingMargin: 0.9,
    passingBias: 1,
    mistakeAmount: 0.025,
  },
  {
    style: "balanced",
    speedFactor: 1,
    brakingMargin: 1,
    passingBias: -1,
    mistakeAmount: 0.018,
  },
  {
    style: "cautious",
    speedFactor: 0.94,
    brakingMargin: 1.16,
    passingBias: 1,
    mistakeAmount: 0.012,
  },
];

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
  private selectedBuildingId: string | undefined;
  private readonly customizationBodies = new Map<string, RAPIER.RigidBody>();
  private legacyGroundBody: RAPIER.RigidBody | undefined;
  private readonly chassis: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private vehicleVisual: VehicleVisual;
  private loadedVehicle?: ModelVisual;
  private vehicleChoice: VehicleChoice = { ...defaultVehicleChoice };
  private vehicleHandling = vehicleHandlingProfile(defaultVehicleChoice.id);
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
  private flightForm: FlightForm = "car";
  private transformElapsed = 0;
  private flightState = createFlightState();
  private flightGrounded = true;
  private flightTouchdown = false;
  private flightClearance = 0;
  private flightNotice: { text: string; expiresAt: number } | undefined;
  private wheelsFolded = false;
  private readonly helicopterKit: HelicopterKit;
  private readonly flightController: RAPIER.KinematicCharacterController;
  private baseFog = { near: 0, far: 0 };
  private readonly combat: CombatEffects;
  private readonly aimReticle: THREE.Mesh;
  private rocketCooldown = 0;
  private rocketsFired = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private readonly destroyedBuildings = new Set<string>();
  /** Fixed building body handle → building source id, for rocket hits. */
  private readonly buildingBodies = new Map<number, string>();

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
    this.helicopterKit = createHelicopterKit(this.vehicleChoice.color);
    this.vehicleVisual.root.add(this.helicopterKit.root);
    this.flightController = this.physics.createCharacterController(0.05);
    this.flightController.setSlideEnabled(true);
    this.flightController.setApplyImpulsesToDynamicBodies(false);
    this.combat = new CombatEffects(this.scene, (x, z) =>
      sampleTerrainPlan(this.plan.terrain, x, z),
    );
    this.aimReticle = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.5, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffe27a,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      }),
    );
    this.aimReticle.renderOrder = 30;
    this.aimReticle.visible = false;
    this.scene.add(this.aimReticle);
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
    previous.remove(this.helicopterKit.root);
    this.scene.remove(previous);
    disposeVehicleModel(previous);
    model.root.add(this.helicopterKit.root);
    this.helicopterKit.setColor(choice.color);
    this.wheelsFolded = this.flightForm !== "car";
    this.vehicleVisual = model;
    this.loadedVehicle = model;
    this.vehicleChoice = { ...choice };
    this.vehicleHandling = vehicleHandlingProfile(choice.id);
    model.connections.forEach((connection, index) =>
      this.vehicle.setWheelChassisConnectionPointCs(index, connection),
    );
    for (let index = 0; index < 4; index += 1) {
      this.vehicle.setWheelSuspensionStiffness(
        index,
        defaultVehicleConfig.suspensionStiffness *
          this.vehicleHandling.suspensionStiffnessMultiplier,
      );
      this.vehicle.setWheelSuspensionCompression(
        index,
        defaultVehicleConfig.suspensionCompression *
          this.vehicleHandling.suspensionDampingMultiplier,
      );
      this.vehicle.setWheelSuspensionRelaxation(
        index,
        defaultVehicleConfig.suspensionRelaxation *
          this.vehicleHandling.suspensionDampingMultiplier,
      );
    }
    this.scene.add(model.root);
    if (this.flightForm === "car") {
      this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  setMode(mode: EngineMode): void {
    const previousMode = this.mode;
    if (mode !== "drive" && this.flightForm !== "car") this.revertToCar(true);
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

  setSelectedBuilding(sourceId?: string): void {
    if (sourceId === this.selectedBuildingId) return;
    const changed = new Set(
      [this.selectedBuildingId, sourceId].filter((value): value is string =>
        Boolean(value),
      ),
    );
    this.selectedBuildingId = sourceId;
    this.refreshBuildingVisuals(changed);
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
        if (this.destroyedBuildings.has(id)) continue;
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
    if (this.flightForm !== "car") this.revertToCar(true);
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
    if (this.flightForm !== "car")
      return "Land and transform back into a car before racing.";
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

    const rivalChoices = rivalVehicleChoices(this.vehicleChoice);
    const modelResults = await Promise.allSettled(
      rivalChoices.map(loadVehicleModel),
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
    const difficulty = options.difficulty ?? "competitive";
    const difficultyProfile = difficultyProfiles[difficulty];
    const skills = [0.88, 0.82, 0.76];
    const rivals = models.map((model, index) => {
      const pose = gridPoses[index + 1]!;
      const rival = this.createRaceVehicle(
        pose,
        model,
        skills[index]! * difficultyProfile.skill,
        ["Apex", "Nova", "Mako"][index]!,
        rivalChoices[index]!.color,
        rivalPersonalities[index]!,
      );
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
      difficulty,
      wrongWaySeconds: 0,
      offCourseSeconds: 0,
      falseStart: false,
      splitTimes: [],
      previousPosition: 1,
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
    this.combat.dispose();
    disposeObject(this.aimReticle);
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
    this.baseFog = { near: sceneScale * 1.15, far: sceneScale * 3 };
    this.scene.fog = new THREE.Fog(
      night ? 0x07111f : 0xbad7e8,
      this.baseFog.near,
      this.baseFog.far,
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
    if (this.destroyedBuildings.has(building.sourceId)) return undefined;
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
    if (this.selectedBuildingId === building.sourceId) {
      const selected = new THREE.BoxHelper(house, 0xffc247);
      selected.name = "Selected building outline";
      selected.material.depthTest = false;
      selected.material.transparent = true;
      selected.material.opacity = 0.95;
      selected.renderOrder = 20;
      group.add(selected);
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
      this.buildingBodies.delete(body.handle);
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
        if (this.destroyedBuildings.has(building.sourceId)) continue;
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
        this.buildingBodies.set(body.handle, building.sourceId);
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
    handling: VehicleHandling = this.vehicleHandling,
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
        .setTranslation(0, handling.centerOfMassOffsetY, 0)
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
        defaultVehicleConfig.suspensionStiffness *
          handling.suspensionStiffnessMultiplier,
      );
      controller.setWheelSuspensionCompression(
        index,
        defaultVehicleConfig.suspensionCompression *
          handling.suspensionDampingMultiplier,
      );
      controller.setWheelSuspensionRelaxation(
        index,
        defaultVehicleConfig.suspensionRelaxation *
          handling.suspensionDampingMultiplier,
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
    name: string,
    color: string,
    personality: RivalPersonality,
  ): RaceVehicle {
    const vehicle = this.createPhysicsVehicle(
      pose.position,
      pose.rotation,
      model,
      this.vehicleHandling,
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
      name,
      color,
      personality,
      laneOffset: 0,
      targetLaneOffset: 0,
      stuckSeconds: 0,
      powerMultiplier: 1,
      checkpointTimes: [],
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

  private racePoseAt(
    course: RaceCourse,
    distance: number,
    laneOffset = 0,
  ): GridPose {
    const point = sampleRaceRoute(course, distance);
    const direction = this.courseDirection(course, distance);
    const right = new THREE.Vector3(-direction.z, 0, direction.x);
    const nearby = sampleRaceRoute(
      course,
      Math.min(course.length, distance + 3),
    );
    const pitch = Math.atan2(
      nearby.y - point.y,
      Math.hypot(nearby.x - point.x, nearby.z - point.z),
    );
    return {
      position: new THREE.Vector3(
        point.x + right.x * laneOffset,
        point.y + 1.4,
        point.z + right.z * laneOffset,
      ),
      rotation: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          pitch,
          Math.atan2(-direction.x, -direction.z),
          0,
          "YXZ",
        ),
      ),
    };
  }

  private recoverRival(race: RaceSession, rival: RaceVehicle): void {
    this.placeRigidBody(
      rival.chassis,
      this.racePoseAt(
        race.course,
        Math.max(0, rival.progress - 7),
        rival.laneOffset,
      ),
    );
    rival.input = { ...neutralVehicleInput };
    rival.stuckSeconds = 0;
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
    if (event.code === "KeyT" && !event.repeat && this.mode === "drive")
      this.toggleHelicopter();
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
    if (this.mode !== "inspect" && this.mode !== "drive") return;
    if (this.mode === "drive" && (this.race || this.raceSetupOpen)) return;
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
    if (this.mode === "drive" && match?.userData.featureKind !== "building") {
      this.callbacks.onSelect({});
      return;
    }
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

  /** Instantly returns to the car, e.g. before a race. */
  leaveHelicopter(): void {
    if (this.flightForm !== "car") this.revertToCar(true);
  }

  /** Transforms between car and helicopter; returns a reason when it can't. */
  toggleHelicopter(): string | undefined {
    const reason = this.helicopterBlocker();
    if (reason) {
      this.showFlightNotice(reason);
      return reason;
    }
    if (this.flightForm === "car") this.beginRising();
    else {
      this.flightForm = "landing";
      this.transformElapsed = 0;
    }
    return undefined;
  }

  private helicopterBlocker(): string | undefined {
    if (this.mode !== "drive") return "Enter Drive mode first.";
    if (this.race || this.raceSetupOpen) return "Leave the race first.";
    if (this.flightForm === "rising" || this.flightForm === "landing")
      return "Already transforming.";
    if (this.flightForm === "flying")
      return this.flightGrounded ? undefined : "Land before transforming back.";
    if (Math.abs(this.vehicle.currentVehicleSpeed()) > 3)
      return "Slow down to transform.";
    const position = this.chassis.translation();
    const overhead = this.physics.castRay(
      new RAPIER.Ray(
        { x: position.x, y: position.y + 0.6, z: position.z },
        { x: 0, y: 1, z: 0 },
      ),
      14,
      true,
      undefined,
      undefined,
      undefined,
      this.chassis,
    );
    return overhead ? "Need clear sky above to transform." : undefined;
  }

  private showFlightNotice(text: string, seconds = 2.5): void {
    this.flightNotice = {
      text,
      expiresAt: performance.now() + seconds * 1_000,
    };
  }

  private beginRising(): void {
    const rotation = this.chassis.rotation();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    );
    this.flightState = createFlightState(Math.atan2(-forward.x, -forward.z));
    this.flightForm = "rising";
    this.transformElapsed = 0;
    this.flightGrounded = true;
    this.flightTouchdown = true;
    this.flightClearance = 0;
    this.wheelsFolded = true;
    this.keys.clear();
    this.currentInput = { ...neutralVehicleInput };
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.chassis.setRotation(this.flightQuaternion(true), true);
  }

  private revertToCar(instant = false): void {
    const airborne = !this.flightGrounded;
    this.chassis.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.chassis.setRotation(this.flightQuaternion(true), true);
    if (instant && airborne) {
      this.chassis.setTranslation(this.safePosition, true);
      this.chassis.setRotation(this.safeRotation, true);
    }
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flightForm = "car";
    this.transformElapsed = 0;
    this.flightState = createFlightState(this.flightState.yaw);
    this.flightGrounded = true;
    this.unsafeElapsed = 0;
    this.keys.clear();
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = this.baseFog.near;
      this.scene.fog.far = this.baseFog.far;
    }
  }

  private flightQuaternion(level = false): THREE.Quaternion {
    const { pitch, yaw, roll } = this.flightState;
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(level ? 0 : pitch, yaw, level ? 0 : roll, "YXZ"),
    );
  }

  private transformProgress(): number {
    if (this.flightForm === "car") return 0;
    if (this.flightForm === "flying") return 1;
    const fraction = Math.min(1, this.transformElapsed / TRANSFORM_SECONDS);
    return this.flightForm === "rising" ? fraction : 1 - fraction;
  }

  private rotorSpeed(): number {
    return THREE.MathUtils.smoothstep(this.transformProgress(), 0.65, 1);
  }

  private flightInput(): FlightInput {
    if (this.garageOpen) return neutralFlightInput;
    const deadzone = (value: number) => (Math.abs(value) < 0.15 ? 0 : value);
    const gamepad = this.inputPreferences.gamepadEnabled
      ? [...(navigator.getGamepads?.() ?? [])].find(
          (candidate) =>
            candidate?.connected && candidate.mapping === "standard",
        )
      : undefined;
    if (gamepad) {
      const input = {
        forward: -deadzone(gamepad.axes[1] ?? 0),
        yaw:
          -deadzone(gamepad.axes[0] ?? 0) *
          this.inputPreferences.steeringSensitivity,
        lift:
          (gamepad.buttons[7]?.value ?? 0) - (gamepad.buttons[6]?.value ?? 0),
      };
      if (input.forward || input.yaw || Math.abs(input.lift) > 0.05) {
        this.inputSource = "gamepad";
        return input;
      }
    }
    this.inputSource = "keyboard";
    const held = (...codes: string[]) =>
      codes.some((code) => this.keys.has(code)) ? 1 : 0;
    return {
      forward: held("KeyW", "ArrowUp") - held("KeyS", "ArrowDown"),
      yaw:
        (held("KeyA", "ArrowLeft") - held("KeyD", "ArrowRight")) *
        this.inputPreferences.steeringSensitivity,
      lift: held("Space", "KeyE") - held("ShiftLeft", "ShiftRight", "KeyQ"),
    };
  }

  private groundClearance(position: RAPIER.Vector): number {
    const bottom = 0.45 - this.vehicleHandling.centerOfMassOffsetY;
    const hit = this.physics.castRay(
      new RAPIER.Ray(position, { x: 0, y: -1, z: 0 }),
      bottom + 50,
      true,
      undefined,
      undefined,
      undefined,
      this.chassis,
    );
    return hit ? hit.timeOfImpact - bottom : 50;
  }

  private stepHelicopter(dt: number): void {
    const position = this.chassis.translation();
    let input = neutralFlightInput;
    if (this.flightForm === "flying") input = this.flightInput();
    else {
      this.transformElapsed += dt;
      if (this.transformElapsed >= TRANSFORM_SECONDS) {
        if (this.flightForm === "landing") {
          this.revertToCar();
          return;
        }
        this.flightForm = "flying";
        this.flightState.velocity.y = 4; // Lift-off hop.
      }
    }
    this.flightState = stepFlight(this.flightState, input, dt);
    const state = this.flightState;
    if (this.flightForm !== "flying") {
      state.velocity = { x: 0, y: 0, z: 0 };
      state.pitch = state.roll = 0;
    }
    const size = this.worldSize();
    if (
      boundaryPush(
        state,
        position,
        {
          centerX: size.centerX,
          centerZ: size.centerZ,
          halfWidth: size.width / 2,
          halfDepth: size.depth / 2,
        },
        dt,
      )
    )
      this.showFlightNotice("Edge of the map, turning back", 0.5);
    const altitude =
      position.y - sampleTerrainPlan(this.plan.terrain, position.x, position.z);
    if (altitude > MAX_FLIGHT_ALTITUDE && state.velocity.y > 0) {
      state.velocity.y = 0;
      this.showFlightNotice("Maximum altitude", 0.5);
    }
    // Auto-flare: descent slows near the ground so landings are always soft.
    state.velocity.y = Math.max(
      state.velocity.y,
      -1.2 - this.flightClearance * 0.9,
    );
    const desired = {
      x: state.velocity.x * dt,
      y: state.velocity.y * dt,
      z: state.velocity.z * dt,
    };
    this.flightController.computeColliderMovement(
      this.chassis.collider(0),
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const move = this.flightController.computedMovement();
    // Bump off anything we hit instead of crashing outright.
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const blockedX = Math.abs(move.x - desired.x) > 1e-3;
    const blockedZ = Math.abs(move.z - desired.z) > 1e-3;
    if ((blockedX || blockedZ) && horizontalSpeed > 12)
      this.showFlightNotice("Bump!", 1);
    if (blockedX) state.velocity.x *= -0.25;
    if (blockedZ) state.velocity.z *= -0.25;
    if (Math.abs(move.y - desired.y) > 1e-3) {
      if (desired.y < 0) this.flightTouchdown = true;
      state.velocity.y = 0;
    }
    if (move.y > 1e-3) this.flightTouchdown = false;
    const next = {
      x: position.x + move.x,
      y: position.y + move.y,
      z: position.z + move.z,
    };
    const clearance = this.groundClearance(next);
    this.flightClearance = clearance;
    // The centre ray can miss when resting on an edge, so contacts count too.
    this.flightGrounded =
      clearance < 0.2 ||
      this.flightTouchdown ||
      this.flightController.computedGrounded();
    // Level out near the ground so the tilt never digs the nose in.
    const tilt = Math.min(1, Math.max(0, clearance / 2));
    state.pitch *= tilt;
    state.roll *= tilt;
    this.chassis.setNextKinematicTranslation(next);
    this.chassis.setNextKinematicRotation(this.flightQuaternion());
  }

  /** Rebuilds every building destroyed by rockets. */
  restoreDestroyedBuildings(): void {
    const ids = new Set(this.destroyedBuildings);
    if (!ids.size) return;
    this.destroyedBuildings.clear();
    for (const chunk of this.plan.chunks) {
      if (
        !chunk.buildingIndexes.some((index) =>
          ids.has(this.plan.buildings[index]?.sourceId ?? ""),
        )
      )
        continue;
      for (const body of this.chunkBodies.get(chunk.id) ?? []) {
        this.buildingBodies.delete(body.handle);
        this.physics.removeRigidBody(body);
      }
      this.buildChunkPhysics(chunk);
    }
    this.refreshBuildingVisuals(ids);
    this.syncCustomizationPhysics(ids);
  }

  private aimDirection(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(
        this.flightState.pitch * 0.5 - 0.05,
        this.flightState.yaw,
        0,
        "YXZ",
      ),
    );
  }

  private wantsToFire(): boolean {
    const racing = this.flightForm === "car" && this.race?.phase === "racing";
    if (this.garageOpen || (this.flightForm !== "flying" && !racing))
      return false;
    if (this.keys.has("KeyF")) return true;
    if (!this.inputPreferences.gamepadEnabled) return false;
    const gamepad = [...(navigator.getGamepads?.() ?? [])].find(
      (candidate) => candidate?.connected && candidate.mapping === "standard",
    );
    return Boolean(
      gamepad?.buttons[0]?.pressed || gamepad?.buttons[5]?.pressed,
    );
  }

  private fireRocket(): void {
    const muzzle =
      this.helicopterKit.muzzles[
        this.rocketsFired % this.helicopterKit.muzzles.length
      ]!;
    this.rocketsFired += 1;
    this.vehicleVisual.root.updateMatrixWorld(true);
    const origin = muzzle.getWorldPosition(new THREE.Vector3());
    const { x, y, z } = this.flightState.velocity;
    const velocity = this.aimDirection()
      .multiplyScalar(ROCKET_SPEED)
      .add(new THREE.Vector3(x, y, z));
    this.combat.launch(origin, velocity);
  }

  private stepRockets(dt: number): void {
    this.rocketCooldown = Math.max(0, this.rocketCooldown - dt);
    if (this.rocketCooldown === 0 && this.wantsToFire()) {
      if (this.flightForm === "car") {
        this.fireRaceMissile();
        this.rocketCooldown = RACE_MISSILE_COOLDOWN_SECONDS;
      } else {
        this.fireRocket();
        this.rocketCooldown = ROCKET_COOLDOWN_SECONDS;
      }
    }
    for (const rocket of [...this.combat.rockets]) {
      if (rocket.homing) {
        const rival = this.steerMissile(rocket, dt);
        if (rival) {
          this.combat.removeRocket(rocket);
          this.missileHitRival(rival, rocket.position);
          continue;
        }
      }
      const step = rocket.velocity.clone().multiplyScalar(dt);
      const length = step.length();
      const direction = step.clone().divideScalar(length || 1);
      const hit = this.physics.castRay(
        new RAPIER.Ray(rocket.position, direction),
        length,
        true,
        undefined,
        undefined,
        undefined,
        this.chassis,
      );
      if (hit) {
        const point = rocket.position
          .clone()
          .addScaledVector(direction, hit.timeOfImpact);
        this.combat.removeRocket(rocket);
        this.rocketImpact(point, hit.collider);
        continue;
      }
      if (
        !this.combat.moveRocket(rocket, rocket.position.clone().add(step), dt)
      ) {
        this.combat.removeRocket(rocket);
        this.combat.explode(rocket.position, 0.6);
      }
    }
  }

  private rocketImpact(point: THREE.Vector3, collider: RAPIER.Collider): void {
    const body = collider.parent();
    const rival = this.race?.rivals.find(
      (candidate) => candidate.chassis.handle === body?.handle,
    );
    if (rival) {
      this.missileHitRival(rival, point);
      return;
    }
    let sourceId = body ? this.buildingBodies.get(body.handle) : undefined;
    if (!sourceId && body)
      for (const [id, candidate] of this.customizationBodies)
        if (candidate.handle === body.handle) sourceId = id;
    if (sourceId) this.destroyBuilding(sourceId, point);
    else this.combat.explode(point, 1, point.distanceTo(this.camera.position));
  }

  private destroyBuilding(sourceId: string, impact: THREE.Vector3): void {
    if (this.destroyedBuildings.has(sourceId)) return;
    this.destroyedBuildings.add(sourceId);
    let wallColor = "#c9c2b5";
    let roofColor = "#555049";
    for (const group of this.chunkGroups.values())
      for (const child of [...group.children]) {
        if (child.userData.buildingSourceId !== sourceId) continue;
        child.traverse((object) => {
          if (object.userData.wallColor) wallColor = object.userData.wallColor;
          if (object.userData.roofColor) roofColor = object.userData.roofColor;
        });
        const index = this.selectable.indexOf(child);
        if (index >= 0) this.selectable.splice(index, 1);
        child.removeFromParent();
        disposeObject(child);
      }
    for (const building of this.plan.buildings)
      if (building.sourceId === sourceId)
        this.combat.shatter(building, impact, wallColor, roofColor);
    for (const [chunkId, bodies] of this.chunkBodies) {
      const kept = bodies.filter((body) => {
        if (this.buildingBodies.get(body.handle) !== sourceId) return true;
        this.buildingBodies.delete(body.handle);
        this.physics.removeRigidBody(body);
        return false;
      });
      this.chunkBodies.set(chunkId, kept);
    }
    const custom = this.customizationBodies.get(sourceId);
    if (custom) {
      this.physics.removeRigidBody(custom);
      this.customizationBodies.delete(sourceId);
    }
    if (this.selectedBuildingId === sourceId) {
      this.selectedBuildingId = undefined;
      this.callbacks.onSelect({});
    }
  }

  private fireRaceMissile(): void {
    const rotation = this.chassis.rotation();
    const quaternion = new THREE.Quaternion(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const position = this.chassis.translation();
    const origin = new THREE.Vector3(position.x, position.y, position.z)
      .add(new THREE.Vector3(0, 0.45, 0).applyQuaternion(quaternion))
      .addScaledVector(forward, 2.6);
    const { x, y, z } = this.chassis.linvel();
    this.combat.launch(
      origin,
      forward
        .clone()
        .multiplyScalar(RACE_MISSILE_SPEED)
        .add(new THREE.Vector3(x, y, z)),
      true,
    );
  }

  /**
   * Turns a race missile toward the nearest rival inside a forward cone.
   * Returns that rival when the missile is close enough to detonate.
   */
  private steerMissile(
    rocket: { position: THREE.Vector3; velocity: THREE.Vector3 },
    dt: number,
  ): RaceVehicle | undefined {
    const speed = rocket.velocity.length();
    const heading = rocket.velocity.clone().divideScalar(speed || 1);
    let best:
      | { rival: RaceVehicle; offset: THREE.Vector3; distance: number }
      | undefined;
    for (const rival of this.race?.rivals ?? []) {
      if (rival.hit) continue;
      const p = rival.chassis.translation();
      const offset = new THREE.Vector3(p.x, p.y + 0.2, p.z).sub(
        rocket.position,
      );
      const distance = offset.length();
      if (distance < 2.3) return rival;
      if (distance > 160 || offset.dot(heading) < distance * Math.cos(0.5))
        continue;
      if (!best || distance < best.distance) best = { rival, offset, distance };
    }
    if (best) {
      const turn = Math.min(1, 2.6 * dt);
      heading.lerp(best.offset.normalize(), turn).normalize();
      rocket.velocity.copy(heading.multiplyScalar(speed));
    }
    return undefined;
  }

  /** Knocks a rival into a spin-out or an airborne flip. */
  private missileHitRival(rival: RaceVehicle, point: THREE.Vector3): void {
    this.combat.explode(point, 1.3, point.distanceTo(this.camera.position));
    if (rival.hit || !this.race) return;
    const kind = Math.random() < 0.5 ? "spin" : "flip";
    rival.hit = { kind, elapsed: 0, settled: 0 };
    const rotation = rival.chassis.rotation();
    const quaternion = new THREE.Quaternion(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const velocity = rival.chassis.linvel();
    const side = Math.random() < 0.5 ? -1 : 1;
    if (kind === "spin") {
      rival.chassis.setLinvel(
        { x: velocity.x * 0.6, y: velocity.y + 2.5, z: velocity.z * 0.6 },
        true,
      );
      rival.chassis.setAngvel({ x: 0, y: side * 8, z: 0 }, true);
    } else {
      const roll = forward.multiplyScalar(side * (6 + Math.random() * 3));
      rival.chassis.setLinvel(
        { x: velocity.x * 0.7, y: 10 + Math.random() * 3, z: velocity.z * 0.7 },
        true,
      );
      rival.chassis.setAngvel({ x: roll.x, y: side * 1.5, z: roll.z }, true);
    }
    this.race.notice = {
      text: `Direct hit! ${rival.name} ${kind === "spin" ? "spins out" : "flips"}`,
      expiresAt: this.race.elapsedSeconds + 2,
    };
  }

  /** Waits for a hit rival to come to rest, righting it if it landed badly. */
  private settleHitRival(
    race: RaceSession,
    rival: RaceVehicle,
    dt: number,
  ): void {
    const hit = rival.hit!;
    hit.elapsed += dt;
    const linear = rival.chassis.linvel();
    const angular = rival.chassis.angvel();
    const still =
      Math.hypot(linear.x, linear.y, linear.z) < 1.5 &&
      Math.hypot(angular.x, angular.y, angular.z) < 0.8;
    hit.settled = still ? hit.settled + dt : 0;
    if ((hit.elapsed > 1 && hit.settled > 0.5) || hit.elapsed > 6) {
      const rotation = rival.chassis.rotation();
      const upright =
        1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
      if (upright < 0.6 || hit.elapsed > 6) {
        rival.progress = nearestRaceProgress(
          race.course,
          rival.chassis.translation(),
          rival.progress,
        );
        this.recoverRival(race, rival);
      }
      rival.stuckSeconds = 0;
      delete rival.hit;
    }
  }

  private updateAimReticle(): void {
    this.aimReticle.visible =
      this.mode === "drive" && this.flightForm === "flying";
    if (!this.aimReticle.visible) return;
    this.aimReticle.position
      .copy(this.vehicleVisual.root.position)
      .addScaledVector(this.aimDirection(), 70);
    this.aimReticle.quaternion.copy(this.camera.quaternion);
  }

  private foldWheels(fold: number): void {
    this.vehicleVisual.wheels.forEach((wheel, index) => {
      const connection =
        this.loadedVehicle?.connections[index] ?? wheelConnections[index]!;
      const side = connection.x < 0 ? -1 : 1;
      wheel.rotation.order = "YXZ";
      wheel.rotation.y = 0;
      wheel.rotation.z = (side * fold * Math.PI) / 2;
      wheel.position.x = connection.x * (1 - 0.18 * fold);
      wheel.position.y =
        connection.y -
        (this.loadedVehicle ? defaultVehicleConfig.suspensionRestLength : 0) +
        fold * 0.3;
    });
    if (fold === 0 && this.flightForm === "car") this.wheelsFolded = false;
  }

  private updateFlightCamera(deltaSeconds: number, progress: number): void {
    const root = this.vehicleVisual.root;
    const flourish =
      this.flightForm === "flying"
        ? 0
        : Math.sin(
            Math.min(1, this.transformElapsed / TRANSFORM_SECONDS) * Math.PI,
          );
    const up = new THREE.Vector3(0, 1, 0);
    const offset = new THREE.Vector3(
      0,
      3.8 + 2.4 * progress,
      8.8 + 6 * progress,
    )
      .applyAxisAngle(up, flourish * 0.9)
      .multiplyScalar(1 + 0.25 * flourish)
      .applyAxisAngle(up, this.flightState.yaw);
    const smoothing = 1 - Math.exp(-deltaSeconds * 4);
    this.camera.position.sub(this.shakeOffset);
    this.camera.position.lerp(root.position.clone().add(offset), smoothing);
    this.camera.lookAt(root.position.clone().add(new THREE.Vector3(0, 1.2, 0)));
    const shake = this.combat.shake;
    this.shakeOffset.set(
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
    );
    this.camera.position.add(this.shakeOffset);
    if (this.scene.fog instanceof THREE.Fog) {
      const altitude = Math.max(
        0,
        root.position.y -
          sampleTerrainPlan(
            this.plan.terrain,
            root.position.x,
            root.position.z,
          ),
      );
      this.scene.fog.near = this.baseFog.near + altitude * 2;
      this.scene.fog.far = this.baseFog.far + altitude * 4;
    }
  }

  private flightStats(): FlightStats {
    const position = this.chassis.translation();
    return {
      form: this.flightForm as FlightStats["form"],
      altitudeMeters: Math.max(
        0,
        Math.round(
          position.y -
            sampleTerrainPlan(this.plan.terrain, position.x, position.z),
        ),
      ),
      airspeedKph: Math.round(flightAirspeedKph(this.flightState)),
      headingDegrees: headingDegrees(this.flightState.yaw),
      grounded: this.flightGrounded,
    };
  }

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
        !forward &&
        !reverse &&
        Math.abs(this.vehicle.currentVehicleSpeed()) > 0.15
          ? this.race
            ? 0.22
            : 0.08
          : 0,
      steering:
        (left ? 1 : right ? -1 : 0) * this.inputPreferences.steeringSensitivity,
      handbrake: this.keys.has("Space"),
    };
  }

  private stepPhysics(): void {
    this.stepRockets(FIXED_STEP);
    if (this.flightForm !== "car") {
      this.stepHelicopter(FIXED_STEP);
      this.physics.step();
      return;
    }
    this.currentInput = smoothVehicleInput(
      this.currentInput,
      this.targetInput(),
      FIXED_STEP,
    );
    this.applyVehicleInput(
      this.vehicle,
      this.currentInput,
      this.vehicleHandling,
      1 + (this.race ? this.raceDraftBoost(this.race) : 0),
    );
    if (this.race) {
      for (const rival of this.race.rivals) {
        const target = rival.hit
          ? {
              throttle: 0,
              brake: 0.25,
              steering: 0,
              handbrake: rival.hit.kind === "spin",
            }
          : this.race.phase === "racing"
            ? this.raceAiInput(this.race, rival)
            : { throttle: 0, brake: 1, steering: 0, handbrake: true };
        rival.input =
          target.brake >= 0.95 && target.throttle === 0
            ? { ...target }
            : smoothVehicleInput(rival.input, target, FIXED_STEP);
        this.applyVehicleInput(
          rival.controller,
          rival.input,
          this.vehicleHandling,
          rival.powerMultiplier,
        );
      }
    }
    this.physics.step();
    if (this.race) this.advanceRace(this.race);
    this.updateSafeVehicleState(FIXED_STEP);
  }

  private applyVehicleInput(
    vehicle: RAPIER.DynamicRayCastVehicleController,
    input: VehicleInput,
    handling = this.vehicleHandling,
    powerMultiplier = 1,
  ): void {
    const engineForce = speedLimitedEngineForce(
      input.throttle,
      vehicle.currentVehicleSpeed() * 3.6,
      {
        engineForce:
          defaultVehicleConfig.engineForce *
          handling.engineForceMultiplier *
          powerMultiplier,
        maxForwardSpeedKph:
          defaultVehicleConfig.maxForwardSpeedKph * handling.maxSpeedMultiplier,
        maxReverseSpeedKph:
          defaultVehicleConfig.maxReverseSpeedKph * handling.maxSpeedMultiplier,
      },
    );
    const steering = speedAdjustedSteeringAngle(
      input.steering,
      vehicle.currentVehicleSpeed() * 3.6,
      {
        maxSteeringAngle:
          defaultVehicleConfig.maxSteeringAngle * handling.steeringMultiplier,
        maxForwardSpeedKph:
          defaultVehicleConfig.maxForwardSpeedKph * handling.maxSpeedMultiplier,
        highSpeedSteeringFactor: defaultVehicleConfig.highSpeedSteeringFactor,
      },
    );
    for (const wheel of [0, 1]) {
      vehicle.setWheelSteering(wheel, steering);
      vehicle.setWheelBrake(
        wheel,
        input.brake *
          defaultVehicleConfig.brakeForce *
          handling.brakeMultiplier,
      );
    }
    for (const wheel of [2, 3]) {
      vehicle.setWheelEngineForce(wheel, engineForce);
      vehicle.setWheelBrake(
        wheel,
        input.handbrake
          ? defaultVehicleConfig.handbrakeForce * handling.brakeMultiplier
          : input.brake *
              defaultVehicleConfig.brakeForce *
              handling.brakeMultiplier,
      );
    }
    vehicle.updateVehicle(FIXED_STEP, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  }

  private courseDirection(course: RaceCourse, distance: number): THREE.Vector3 {
    const before = sampleRaceRoute(course, Math.max(0, distance - 2));
    const after = sampleRaceRoute(
      course,
      Math.min(course.length, distance + 2),
    );
    return new THREE.Vector3(
      after.x - before.x,
      0,
      after.z - before.z,
    ).normalize();
  }

  private raceDraftBoost(race: RaceSession): number {
    if (race.phase !== "racing") return 0;
    const position = this.chassis.translation();
    const rotation = this.chassis.rotation();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    );
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    for (const rival of race.rivals) {
      const other = rival.chassis.translation();
      const offset = new THREE.Vector3(
        other.x - position.x,
        0,
        other.z - position.z,
      );
      const longitudinal = offset.dot(forward);
      if (
        longitudinal > 5 &&
        longitudinal < 18 &&
        Math.abs(offset.dot(right)) < 2.1
      )
        return 0.12 * (1 - (longitudinal - 5) / 20);
    }
    return 0;
  }

  private raceAiInput(race: RaceSession, rival: RaceVehicle): VehicleInput {
    const position = rival.chassis.translation();
    rival.progress = nearestRaceProgress(race.course, position, rival.progress);
    while (
      rival.checkpointTimes.length < race.course.checkpointDistances.length &&
      rival.progress >=
        race.course.checkpointDistances[rival.checkpointTimes.length]!
    )
      rival.checkpointTimes.push(race.elapsedSeconds);
    if (!rival.finishTime && rival.progress >= race.course.length - 3)
      rival.finishTime = race.elapsedSeconds;
    const speedKph = Math.abs(rival.controller.currentVehicleSpeed()) * 3.6;
    const rotation = rival.chassis.rotation();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    );
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    let proximityBrake = 0;
    let nearestBlock = Number.POSITIVE_INFINITY;
    let avoidanceSteer = 0;
    for (const other of [
      this.chassis,
      ...race.rivals
        .filter((candidate) => candidate !== rival)
        .map((candidate) => candidate.chassis),
    ]) {
      const otherPosition = other.translation();
      const offsetX = otherPosition.x - position.x;
      const offsetZ = otherPosition.z - position.z;
      const longitudinal = offsetX * forward.x + offsetZ * forward.z;
      const lateral = offsetX * right.x + offsetZ * right.z;
      if (longitudinal > 0 && longitudinal < 18 && Math.abs(lateral) < 2.6)
        nearestBlock = Math.min(nearestBlock, longitudinal);
      if (Math.abs(longitudinal) < 5 && Math.abs(lateral) < 3 && lateral !== 0)
        avoidanceSteer += lateral > 0 ? 0.32 : -0.32;
      proximityBrake = Math.max(
        proximityBrake,
        racerProximityBrake({
          forwardX: forward.x,
          forwardZ: forward.z,
          offsetX,
          offsetZ,
        }),
      );
    }
    const laneLimit = Math.max(
      0,
      Math.min(2.25, race.course.roadWidth / 2 - 1.1),
    );
    if (nearestBlock < 15 && race.course.roadWidth >= 6.5 && laneLimit >= 1.8)
      rival.targetLaneOffset = laneLimit * rival.personality.passingBias;
    else if (nearestBlock === Number.POSITIVE_INFINITY)
      rival.targetLaneOffset *= 0.985;
    rival.laneOffset += Math.max(
      -0.035,
      Math.min(0.035, rival.targetLaneOffset - rival.laneOffset),
    );

    const lookAhead = 10 + Math.min(16, speedKph * 0.17);
    const targetDistance = Math.min(
      race.course.length,
      rival.progress + lookAhead,
    );
    const target = sampleRaceRoute(race.course, targetDistance);
    const routeDirection = this.courseDirection(race.course, targetDistance);
    const routeRight = new THREE.Vector3(
      -routeDirection.z,
      0,
      routeDirection.x,
    );
    const desired = new THREE.Vector3(
      target.x + routeRight.x * rival.laneOffset - position.x,
      0,
      target.z + routeRight.z * rival.laneOffset - position.z,
    ).normalize();
    const cross = forward.z * desired.x - forward.x * desired.z;
    const dot = Math.max(
      -1,
      Math.min(1, forward.x * desired.x + forward.z * desired.z),
    );
    const angle = Math.atan2(cross, dot);
    const laterDirection = this.courseDirection(
      race.course,
      Math.min(race.course.length, rival.progress + lookAhead + 28),
    );
    const cornerAngle = Math.abs(
      Math.atan2(
        routeDirection.z * laterDirection.x -
          routeDirection.x * laterDirection.z,
        routeDirection.x * laterDirection.x +
          routeDirection.z * laterDirection.z,
      ),
    );
    const difficulty = difficultyProfiles[race.difficulty];
    const mistake =
      Math.sin(race.elapsedSeconds * 0.73 + rival.name.charCodeAt(0)) *
      rival.personality.mistakeAmount *
      difficulty.mistakeScale;
    const steering = Math.max(
      -1,
      Math.min(1, angle * 1.55 + avoidanceSteer + mistake),
    );
    const cornerFactor = Math.max(0.2, 1 - cornerAngle / (Math.PI * 0.62));
    const targetSpeed =
      (22 + cornerFactor * 46) * rival.skill * rival.personality.speedFactor;
    if (Math.abs(rival.laneOffset) > 1.65 && nearestBlock > 7)
      proximityBrake *= 0.35;
    const leaderProgress = Math.max(
      race.playerProgress,
      ...race.rivals.map((candidate) => candidate.progress),
    );
    const gap = Math.max(0, leaderProgress - rival.progress - 30);
    const catchUp = Math.min(
      difficulty.catchUp,
      (gap / 500) * difficulty.catchUp,
    );
    const draft = nearestBlock > 6 && nearestBlock < 18 ? 0.045 : 0;
    rival.powerMultiplier = 1 + catchUp + draft;
    const routeBrake =
      speedKph > targetSpeed + 4 / rival.personality.brakingMargin ? 0.62 : 0;
    return {
      throttle:
        proximityBrake > 0.05 ? 0 : speedKph < targetSpeed ? rival.skill : 0,
      brake: Math.max(routeBrake, proximityBrake),
      steering,
      handbrake:
        proximityBrake >= 0.8
          ? true
          : proximityBrake === 0 && Math.abs(angle) > 1.15 && speedKph > 28,
    };
  }

  private advanceRace(race: RaceSession): void {
    if (race.phase === "countdown") {
      race.countdownElapsed += FIXED_STEP;
      race.falseStart ||=
        this.keys.has("KeyW") ||
        this.keys.has("ArrowUp") ||
        this.keys.has("KeyS") ||
        this.keys.has("ArrowDown");
      if (race.falseStart) race.warning = "False start held until green";
      race.countdownLights = Math.min(3, Math.floor(race.countdownElapsed) + 1);
      this.placeRigidBody(this.chassis, race.gridPoses[0]!);
      race.rivals.forEach((rival, index) =>
        this.placeRigidBody(rival.chassis, race.gridPoses[index + 1]!),
      );
      if (race.countdownElapsed >= RACE_COUNTDOWN_SECONDS) {
        race.phase = "racing";
        race.countdownLights = 0;
        delete race.warning;
        this.currentInput = { ...neutralVehicleInput };
        for (const rival of race.rivals)
          rival.input = { ...neutralVehicleInput };
      }
    } else if (race.phase === "racing") {
      race.elapsedSeconds += FIXED_STEP;
      delete race.warning;
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
        const isFinish =
          race.checkpointIndex === race.course.checkpointDistances.length - 1;
        const playerRotation = this.chassis.rotation();
        const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
          new THREE.Quaternion(
            playerRotation.x,
            playerRotation.y,
            playerRotation.z,
            playerRotation.w,
          ),
        );
        const routeDirection = this.courseDirection(
          race.course,
          Math.min(race.course.length - 0.1, checkpointDistance),
        );
        const crossedInRaceDirection = playerForward.dot(routeDirection) > 0.05;
        if (
          race.playerProgress >= checkpointDistance - 12 &&
          separation <= Math.max(3.5, race.course.roadWidth * 0.62) &&
          (!isFinish || crossedInRaceDirection)
        ) {
          race.splitTimes.push(race.elapsedSeconds);
          const rivalSplit = Math.min(
            ...race.rivals.flatMap((rival) => {
              const time = rival.checkpointTimes[race.checkpointIndex];
              return time === undefined ? [] : [time];
            }),
          );
          if (Number.isFinite(rivalSplit))
            race.lastSplitDelta = race.elapsedSeconds - rivalSplit;
          race.checkpointIndex += 1;
        } else if (!isFinish && race.playerProgress > checkpointDistance + 28)
          race.warning = "Checkpoint missed — turn back through the arch";
      }

      const routePoint = sampleRaceRoute(race.course, race.playerProgress);
      const routeSeparation = Math.hypot(
        position.x - routePoint.x,
        position.z - routePoint.z,
      );
      const playerRotation = this.chassis.rotation();
      const playerForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(
          playerRotation.x,
          playerRotation.y,
          playerRotation.z,
          playerRotation.w,
        ),
      );
      const routeDirection = this.courseDirection(
        race.course,
        race.playerProgress,
      );
      const speedKph = Math.abs(this.vehicle.currentVehicleSpeed()) * 3.6;
      race.wrongWaySeconds =
        speedKph > 6 && playerForward.dot(routeDirection) < -0.35
          ? race.wrongWaySeconds + FIXED_STEP
          : Math.max(0, race.wrongWaySeconds - FIXED_STEP * 2);
      if (race.wrongWaySeconds > 0.8) race.warning = "Wrong way";
      race.offCourseSeconds =
        routeSeparation > Math.max(8, race.course.roadWidth * 1.35)
          ? race.offCourseSeconds + FIXED_STEP
          : Math.max(0, race.offCourseSeconds - FIXED_STEP * 2);
      if (race.offCourseSeconds > 1)
        race.warning = "Off course — return to the route";
      if (race.offCourseSeconds > 4) {
        const recoveryDistance = Math.max(
          0,
          (race.course.checkpointDistances[race.checkpointIndex - 1] ?? 0) - 6,
        );
        race.playerProgress = recoveryDistance;
        this.placeRigidBody(
          this.chassis,
          this.racePoseAt(race.course, recoveryDistance),
        );
        this.currentInput = { ...neutralVehicleInput };
        race.offCourseSeconds = 0;
        race.notice = {
          text: "Returned to the last checkpoint",
          expiresAt: race.elapsedSeconds + 2.5,
        };
      }

      for (const rival of race.rivals) {
        if (rival.hit) {
          this.settleHitRival(race, rival, FIXED_STEP);
          continue;
        }
        const rivalSpeed =
          Math.abs(rival.controller.currentVehicleSpeed()) * 3.6;
        const rotation = rival.chassis.rotation();
        const upright =
          1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
        rival.stuckSeconds =
          (rivalSpeed < 2 && rival.input.throttle > 0.25) || upright < 0.25
            ? rival.stuckSeconds + FIXED_STEP
            : Math.max(0, rival.stuckSeconds - FIXED_STEP * 2);
        if (rival.stuckSeconds > 3) this.recoverRival(race, rival);
      }

      const positionNow = this.racePosition(race);
      if (positionNow !== race.previousPosition) {
        race.positionChange = {
          from: race.previousPosition,
          to: positionNow,
          expiresAt: race.elapsedSeconds + 2.2,
        };
        race.previousPosition = positionNow;
      }
      if (
        race.checkpointIndex >= race.course.checkpointDistances.length &&
        race.elapsedSeconds > 5
      ) {
        race.finishPosition = this.racePosition(race);
        race.playerFinishTime = race.elapsedSeconds;
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

  private raceResults(race: RaceSession): RaceResult[] {
    const entries = [
      {
        name: "You",
        color: this.vehicleChoice.color,
        player: true,
        progress: race.playerProgress,
        time: race.playerFinishTime,
      },
      ...race.rivals.map((rival) => ({
        name: rival.name,
        color: rival.color,
        player: false,
        progress: rival.progress,
        time: rival.finishTime,
      })),
    ].sort((left, right) => {
      if (left.time !== undefined && right.time !== undefined)
        return left.time - right.time;
      if (left.time !== undefined) return -1;
      if (right.time !== undefined) return 1;
      return right.progress - left.progress;
    });
    return entries.map((entry, index) => ({
      position: index + 1,
      name: entry.name,
      color: entry.color,
      player: entry.player,
      finished: entry.time !== undefined,
      ...(entry.time !== undefined ? { timeSeconds: entry.time } : {}),
    }));
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
    const progress = this.transformProgress();
    this.helicopterKit.update(progress, this.rotorSpeed(), deltaSeconds);
    if (this.flightForm !== "car" || this.wheelsFolded)
      this.foldWheels(this.helicopterKit.wheelFold(progress));
    const wheelSpin =
      this.flightForm === "car"
        ? (this.vehicle.currentVehicleSpeed() * deltaSeconds) /
          defaultVehicleConfig.wheelRadius
        : 0;
    if (this.flightForm === "car")
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
    if (this.mode === "drive" && this.flightForm !== "car") {
      this.updateFlightCamera(deltaSeconds, progress);
    } else if (this.mode === "drive") {
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
    const rivals = race.rivals.map((rival) => ({
      ...vehicleMapPose(
        rival.chassis.translation(),
        rival.chassis.rotation(),
        this.definition.world.anchor,
      ),
      name: rival.name,
      color: rival.color,
    }));
    const notice =
      race.notice && race.notice.expiresAt > race.elapsedSeconds
        ? race.notice.text
        : undefined;
    const positionChange =
      race.positionChange && race.positionChange.expiresAt > race.elapsedSeconds
        ? { from: race.positionChange.from, to: race.positionChange.to }
        : undefined;
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
      difficulty: race.difficulty,
      currentLap: Math.min(
        race.course.laps,
        Math.floor(race.playerProgress / race.course.lapLength) + 1,
      ),
      laps: race.course.laps,
      draftBoost: this.raceDraftBoost(race),
      splitTimes: race.splitTimes,
      ...(race.lastSplitDelta !== undefined
        ? { lastSplitDelta: race.lastSplitDelta }
        : {}),
      ...(notice || race.warning ? { warning: notice ?? race.warning } : {}),
      ...(positionChange ? { positionChange } : {}),
      ...(race.phase === "finished" ? { results: this.raceResults(race) } : {}),
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
        this.flightForm !== "car"
          ? flightAirspeedKph(this.flightState)
          : Math.abs(this.vehicle?.currentVehicleSpeed?.() ?? 0) * 3.6,
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
      destroyedBuildings: this.destroyedBuildings.size,
      ...(this.race ? { race: this.raceStats(this.race) } : {}),
      ...(this.flightForm !== "car" ? { flight: this.flightStats() } : {}),
      ...(this.flightNotice && this.flightNotice.expiresAt > performance.now()
        ? { flightNotice: this.flightNotice.text }
        : {}),
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
    this.combat.update(deltaSeconds);
    this.updateAimReticle();
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
