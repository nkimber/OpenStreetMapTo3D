import RAPIER from "@dimforge/rapier3d-compat";
import type { WorldDefinition } from "@osm3d/contracts";
import { wgs84ToLocal } from "@osm3d/geo";
import {
  defaultVehicleConfig,
  neutralVehicleInput,
  smoothVehicleInput,
  type VehicleInput,
} from "@osm3d/simulation";
import {
  buildWorldPlan,
  type BuildingPlan,
  type LocalPoint2,
  type RoadPlan,
} from "@osm3d/worldgen";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const FIXED_STEP = 1 / 60;

export interface EngineStats {
  roads: number;
  buildings: number;
  features: number;
  speedKph: number;
}

export interface EngineCallbacks {
  onSelect: (sourceId: string | undefined) => void;
  onStats: (stats: EngineStats) => void;
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

function roadGeometry(road: RoadPlan): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const halfWidth = road.width / 2;
  for (let index = 0; index < road.points.length - 1; index += 1) {
    const start = road.points[index];
    const end = road.points[index + 1];
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) continue;
    const offsetX = (-dz / length) * halfWidth;
    const offsetZ = (dx / length) * halfWidth;
    const vertexOffset = positions.length / 3;
    positions.push(
      start.x + offsetX,
      0.035,
      start.z + offsetZ,
      start.x - offsetX,
      0.035,
      start.z - offsetZ,
      end.x + offsetX,
      0.035,
      end.z + offsetZ,
      end.x - offsetX,
      0.035,
      end.z - offsetZ,
    );
    indices.push(
      vertexOffset,
      vertexOffset + 2,
      vertexOffset + 1,
      vertexOffset + 2,
      vertexOffset + 3,
      vertexOffset + 1,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export class WorldEngine {
  static async create(
    container: HTMLElement,
    definition: WorldDefinition,
    callbacks: EngineCallbacks,
  ): Promise<WorldEngine> {
    await RAPIER.init();
    return new WorldEngine(container, definition, callbacks);
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
  private readonly plan;
  private readonly chassis: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly vehicleVisual: VehicleVisual;
  private readonly spawnPosition = new THREE.Vector3();
  private readonly spawnRotation = new THREE.Quaternion();
  private animationFrame = 0;
  private previousTime = performance.now();
  private accumulator = 0;
  private currentInput: VehicleInput = { ...neutralVehicleInput };
  private mode: EngineMode = "inspect";
  private disposed = false;
  private statsElapsed = 0;

  private constructor(
    private readonly container: HTMLElement,
    private readonly definition: WorldDefinition,
    private readonly callbacks: EngineCallbacks,
  ) {
    this.plan = buildWorldPlan(
      definition.features,
      definition.world.anchor,
      definition.world.settings,
      definition.overrides,
    );
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure =
      definition.world.settings.visualStyle === "night" ? 0.8 : 1.05;
    this.container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.03;

    this.configureScene();
    this.buildVisibleWorld();
    this.buildPhysicsWorld();
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
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setMode(mode: EngineMode): void {
    const previousMode = this.mode;
    this.mode = mode;
    this.controls.enabled = mode === "inspect";
    if (mode === "drive") this.renderer.domElement.focus();
    else if (previousMode === "drive") this.frameOverview();
  }

  resetVehicle(): void {
    this.chassis.setTranslation(this.spawnPosition, true);
    this.chassis.setRotation(this.spawnRotation, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
    );
    this.controls.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      }
    });
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

  private buildVisibleWorld(): void {
    const size = this.worldSize();
    const groundMaterial = new THREE.MeshStandardMaterial({
      color:
        this.definition.world.settings.visualStyle === "night"
          ? 0x18251c
          : 0x88a66b,
      roughness: 0.96,
    });
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size.width, size.depth),
      groundMaterial,
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(size.centerX, 0, size.centerZ);
    ground.receiveShadow = true;
    this.scene.add(ground);

    for (const area of this.plan.land) {
      const shape = shapeFromRings(area.rings);
      if (!shape) continue;
      const color =
        area.kind === "water"
          ? 0x4f9ec4
          : area.classification === "park"
            ? 0x6fa75f
            : 0x839d69;
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.9,
          transparent: area.kind === "water",
          opacity: 0.82,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.012;
      mesh.receiveShadow = true;
      mesh.userData.sourceId = area.sourceId;
      this.scene.add(mesh);
      this.selectable.push(mesh);
    }

    const roadMaterial = new THREE.MeshStandardMaterial({
      color: 0x343b42,
      roughness: 0.88,
      metalness: 0.02,
    });
    for (const road of this.plan.roads) {
      const mesh = new THREE.Mesh(roadGeometry(road), roadMaterial);
      mesh.receiveShadow = true;
      mesh.userData.sourceId = road.sourceId;
      this.scene.add(mesh);
      this.selectable.push(mesh);
    }

    for (const building of this.plan.buildings) this.addBuilding(building);
  }

  private addBuilding(building: BuildingPlan): void {
    const shape = shapeFromRings(building.rings);
    if (!shape) return;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: building.height,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: colorFromId(
        building.sourceId,
        this.definition.world.settings.visualStyle,
      ),
      roughness: 0.82,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.02;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.sourceId = building.sourceId;
    this.scene.add(mesh);
    this.selectable.push(mesh);
  }

  private buildPhysicsWorld(): void {
    this.physics.timestep = FIXED_STEP;
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

    if (!this.definition.world.settings.buildingCollisions) return;
    for (const building of this.plan.buildings) {
      const outer = building.rings[0];
      if (!outer || outer.length === 0) continue;
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
          building.height / 2,
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
    }
  }

  private createVehicle(): {
    chassis: RAPIER.RigidBody;
    controller: RAPIER.DynamicRayCastVehicleController;
    visual: VehicleVisual;
  } {
    const spawnOverride = [...this.definition.overrides]
      .reverse()
      .find((override) => override.operation === "set-spawn");
    const firstRoad =
      this.plan.roads.find(
        (road) =>
          road.sourceId === spawnOverride?.targetId && road.points.length > 1,
      ) ?? this.plan.roads.find((road) => road.points.length > 1);
    const start = firstRoad?.points[0] ?? { x: 0, z: 0 };
    const next = firstRoad?.points[1] ?? { x: 0, z: -1 };
    const direction = new THREE.Vector2(
      next.x - start.x,
      next.z - start.z,
    ).normalize();
    const yaw = Math.atan2(-direction.x, -direction.y);
    this.spawnPosition.set(start.x, 1.4, start.z);
    this.spawnRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
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
    if (event.code === "KeyR") this.resetVehicle();
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
    const match = this.raycaster.intersectObjects(this.selectable, false)[0]
      ?.object;
    this.callbacks.onSelect(
      typeof match?.userData.sourceId === "string"
        ? match.userData.sourceId
        : undefined,
    );
  };

  private targetInput(): VehicleInput {
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
      steering: left ? 1 : right ? -1 : 0,
      handbrake: this.keys.has("Space"),
    };
  }

  private stepPhysics(): void {
    this.currentInput = smoothVehicleInput(
      this.currentInput,
      this.targetInput(),
      FIXED_STEP,
    );
    const engineForce =
      -this.currentInput.throttle * defaultVehicleConfig.engineForce;
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

  private readonly animate = (time: number): void => {
    if (this.disposed) return;
    const deltaSeconds = Math.min((time - this.previousTime) / 1_000, 0.1);
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
    if (this.statsElapsed >= 0.25) {
      this.statsElapsed = 0;
      this.callbacks.onStats({
        roads: this.plan.roads.length,
        buildings: this.plan.buildings.length,
        features: this.plan.featureCount,
        speedKph: Math.round(
          Math.abs(this.vehicle.currentVehicleSpeed()) * 3.6,
        ),
      });
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
