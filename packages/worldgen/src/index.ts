import type {
  Diagnostic,
  ElevationSnapshot,
  GenerationSettings,
  GeoJsonPosition,
  NormalizedFeature,
  Wgs84Position,
  Wgs84Bounds,
  WorldOverride,
} from "@osm3d/contracts";
import { wgs84ToLocal } from "@osm3d/geo";
import {
  buildTerrainPlan,
  createElevationSampler,
  ROAD_TERRAIN_BLEND_WIDTH_METERS,
  roadTerrainCellSafetyMargin,
  type ElevationSampler,
  type TerrainPlan,
} from "./terrain.js";

export {
  buildTerrainPlan,
  createElevationSampler,
  ROAD_TERRAIN_BLEND_WIDTH_METERS,
  ROAD_TERRAIN_CLEARANCE_METERS,
  roadTerrainCellSafetyMargin,
  sampleElevationSnapshot,
  sampleTerrainPlan,
} from "./terrain.js";
export type {
  TerrainChunkPlan,
  TerrainJunctionProfile,
  TerrainPlan,
  TerrainRoadProfile,
} from "./terrain.js";

export const WORLD_GENERATOR_VERSION = "0.4.0";
export const DEFAULT_CHUNK_SIZE_METERS = 256;
export const DEFAULT_TERRAIN_CELLS_PER_CHUNK = 64;

export interface LocalPoint2 {
  x: number;
  z: number;
}

export interface LocalPoint3 extends LocalPoint2 {
  y: number;
}

export interface SurfaceMeshPlan {
  positions: number[];
  indices: number[];
}

export type RoadWidthSource = "source" | "lanes" | "class" | "override";

export interface RoadPlan {
  planId: string;
  sourceId: string;
  name?: string;
  width: number;
  widthSource: RoadWidthSource;
  points: LocalPoint3[];
  mesh: SurfaceMeshPlan;
  shoulderMesh?: SurfaceMeshPlan;
  surface?: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface RoadJunctionPlan {
  planId: string;
  sourceIds: string[];
  center: LocalPoint3;
  radius: number;
  kind: "end-cap" | "intersection";
  layer: number;
  mesh: SurfaceMeshPlan;
}

export interface BuildingPlan {
  planId: string;
  sourceId: string;
  height: number;
  heightSource: "source" | "levels" | "override" | "fallback";
  baseHeight: number;
  rings: LocalPoint2[][];
  buildingType?: string;
}

export interface LandPlan {
  planId: string;
  sourceId: string;
  kind: "land" | "water";
  rings: LocalPoint2[][];
  classification?: string;
}

export interface WorldChunkPlan {
  id: string;
  x: number;
  z: number;
  center: LocalPoint2;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  roadIndexes: number[];
  buildingIndexes: number[];
  landIndexes: number[];
  junctionIndexes: number[];
  featureIds: string[];
}

export interface WorldPlan {
  roads: RoadPlan[];
  junctions: RoadJunctionPlan[];
  buildings: BuildingPlan[];
  land: LandPlan[];
  terrain?: TerrainPlan;
  chunks: WorldChunkPlan[];
  featureChunks: Record<string, string[]>;
  featureCount: number;
  buildHash: string;
  generatorVersion: string;
  chunkSize: number;
  diagnostics: Diagnostic[];
}

export interface WorldBuildOptions {
  chunkSize?: number;
  sourceSnapshotId?: string;
  generatorVersion?: string;
  bounds?: Wgs84Bounds;
  elevation?: ElevationSnapshot;
  terrainCellsPerChunk?: number;
}

export interface SpawnPose {
  sourceId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

const roadWidths: Record<string, number> = {
  motorway: 24,
  trunk: 18,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  residential: 7,
  living_street: 6,
  service: 4.5,
  unclassified: 6,
  track: 3.5,
  path: 2,
  footway: 2,
  cycleway: 2.5,
};

function numericFact(
  feature: NormalizedFeature,
  key: string,
): number | undefined {
  const value = feature.facts[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function overrideFor(
  overrides: WorldOverride[],
  targetId: string,
  operation: WorldOverride["operation"],
): WorldOverride | undefined {
  return [...overrides]
    .reverse()
    .find(
      (override) =>
        override.targetId === targetId && override.operation === operation,
    );
}

export function estimateBuildingHeight(
  feature: NormalizedFeature,
  settings: GenerationSettings,
  overrides: WorldOverride[] = [],
): { height: number; source: BuildingPlan["heightSource"] } {
  const override = overrideFor(overrides, feature.sourceId, "set-height");
  const overriddenHeight = override?.payload.height;
  if (typeof overriddenHeight === "number" && overriddenHeight > 0) {
    return { height: overriddenHeight, source: "override" };
  }
  const explicit = numericFact(feature, "height");
  if (explicit !== undefined && explicit > 0)
    return { height: explicit, source: "source" };
  const levels = numericFact(feature, "levels");
  if (levels !== undefined && levels > 0) {
    return { height: levels * settings.buildingLevelHeight, source: "levels" };
  }
  return { height: settings.defaultBuildingHeight, source: "fallback" };
}

export function estimateRoadWidthWithSource(
  feature: NormalizedFeature,
  overrides: WorldOverride[] = [],
): { width: number; source: RoadWidthSource } {
  const override = overrideFor(overrides, feature.sourceId, "set-width");
  const overriddenWidth = override?.payload.width;
  if (typeof overriddenWidth === "number" && overriddenWidth > 0)
    return { width: overriddenWidth, source: "override" };
  const explicit = numericFact(feature, "width");
  if (explicit !== undefined && explicit > 0)
    return { width: explicit, source: "source" };
  const lanes = numericFact(feature, "lanes");
  if (lanes !== undefined && lanes > 0)
    return { width: Math.max(3, lanes * 3.2), source: "lanes" };
  const highway = feature.tags.highway ?? "unclassified";
  return { width: roadWidths[highway] ?? 5, source: "class" };
}

export function estimateRoadWidth(
  feature: NormalizedFeature,
  overrides: WorldOverride[] = [],
): number {
  return estimateRoadWidthWithSource(feature, overrides).width;
}

function localPoint(
  position: GeoJsonPosition,
  anchor: Wgs84Position,
): LocalPoint2 {
  const local = wgs84ToLocal(
    { longitude: position[0], latitude: position[1], height: position[2] ?? 0 },
    anchor,
  );
  return { x: local.east, z: -local.north };
}

function polygonRings(
  feature: NormalizedFeature,
  anchor: Wgs84Position,
): LocalPoint2[][][] {
  if (feature.geometry.type === "Polygon") {
    return [
      feature.geometry.coordinates.map((ring) =>
        ring.map((point) => localPoint(point, anchor)),
      ),
    ];
  }
  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates.map((polygon) =>
      polygon.map((ring) => ring.map((point) => localPoint(point, anchor))),
    );
  }
  return [];
}

function deduplicatePoints<T extends LocalPoint2>(points: T[]): T[] {
  const result: T[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (
      !previous ||
      Math.hypot(point.x - previous.x, point.z - previous.z) > 0.02
    )
      result.push(point);
  }
  return result;
}

function normalizedDirection(from: LocalPoint2, to: LocalPoint2): LocalPoint2 {
  const x = to.x - from.x;
  const z = to.z - from.z;
  const length = Math.hypot(x, z);
  return length > 0 ? { x: x / length, z: z / length } : { x: 1, z: 0 };
}

export function buildRoadSurface(
  inputPoints: Array<LocalPoint2 | LocalPoint3>,
  width: number,
  elevation = 0.035,
): SurfaceMeshPlan {
  const points = deduplicatePoints(inputPoints);
  if (points.length < 2) return { positions: [], indices: [] };
  const halfWidth = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    const previous = points[Math.max(0, index - 1)] ?? point;
    const next = points[Math.min(points.length - 1, index + 1)] ?? point;
    const incoming = normalizedDirection(previous, point);
    const outgoing = normalizedDirection(point, next);
    const before = index === 0 ? outgoing : incoming;
    const after = index === points.length - 1 ? incoming : outgoing;
    const beforeNormal = { x: -before.z, z: before.x };
    const afterNormal = { x: -after.z, z: after.x };
    let miterX = beforeNormal.x + afterNormal.x;
    let miterZ = beforeNormal.z + afterNormal.z;
    const miterLength = Math.hypot(miterX, miterZ);
    if (miterLength < 0.001) {
      miterX = afterNormal.x;
      miterZ = afterNormal.z;
    } else {
      miterX /= miterLength;
      miterZ /= miterLength;
    }
    const denominator = Math.max(
      0.35,
      Math.abs(miterX * afterNormal.x + miterZ * afterNormal.z),
    );
    const offset = Math.min(halfWidth / denominator, halfWidth * 2.5);
    positions.push(
      point.x + miterX * offset,
      "y" in point ? point.y : elevation,
      point.z + miterZ * offset,
      point.x - miterX * offset,
      "y" in point ? point.y : elevation,
      point.z - miterZ * offset,
    );
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = index * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, right, nextLeft, nextRight, right);
  }
  return { positions, indices };
}

function buildRoadShoulderSurface(
  points: LocalPoint3[],
  width: number,
  sampleTerrain: (x: number, z: number) => number,
  transitionWidth: number,
): SurfaceMeshPlan {
  if (points.length < 2) return { positions: [], indices: [] };
  const positions: number[] = [];
  const indices: number[] = [];
  const inner = width / 2;
  const outer = inner + transitionWidth;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    const previous = points[Math.max(0, index - 1)] ?? point;
    const next = points[Math.min(points.length - 1, index + 1)] ?? point;
    const direction = normalizedDirection(previous, next);
    const normal = { x: -direction.z, z: direction.x };
    const leftOuter = {
      x: point.x + normal.x * outer,
      z: point.z + normal.z * outer,
    };
    const rightOuter = {
      x: point.x - normal.x * outer,
      z: point.z - normal.z * outer,
    };
    positions.push(
      leftOuter.x,
      sampleTerrain(leftOuter.x, leftOuter.z) + 0.01,
      leftOuter.z,
      point.x + normal.x * inner,
      point.y - 0.015,
      point.z + normal.z * inner,
      point.x - normal.x * inner,
      point.y - 0.015,
      point.z - normal.z * inner,
      rightOuter.x,
      sampleTerrain(rightOuter.x, rightOuter.z) + 0.01,
      rightOuter.z,
    );
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = index * 4;
    const next = current + 4;
    indices.push(
      current,
      next,
      current + 1,
      next,
      next + 1,
      current + 1,
      current + 2,
      next + 2,
      current + 3,
      next + 2,
      next + 3,
      current + 3,
    );
  }
  return { positions, indices };
}

function buildDiscSurface(
  center: LocalPoint3,
  radius: number,
): SurfaceMeshPlan {
  const segments = 18;
  const positions = [center.x, center.y, center.z];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    positions.push(
      center.x + Math.cos(angle) * radius,
      center.y,
      center.z - Math.sin(angle) * radius,
    );
  }
  for (let index = 0; index < segments; index += 1) {
    indices.push(0, index + 1, ((index + 1) % segments) + 1);
  }
  return { positions, indices };
}

function booleanTag(value: string | undefined): boolean {
  return value !== undefined && !["", "no", "false", "0"].includes(value);
}

function roadLayer(feature: NormalizedFeature): number {
  const parsed = Number(feature.tags.layer ?? 0);
  return Number.isFinite(parsed) ? Math.max(-5, Math.min(5, parsed)) : 0;
}

function densifyRoad(points: LocalPoint2[], maximumSegment = 4): LocalPoint2[] {
  const result: LocalPoint2[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    if (result.length === 0) result.push(start);
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const steps = Math.max(1, Math.ceil(distance / maximumSegment));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      result.push({
        x: start.x + (end.x - start.x) * ratio,
        z: start.z + (end.z - start.z) * ratio,
      });
    }
  }
  return deduplicatePoints(result);
}

function smoothRoadHeights(points: LocalPoint3[]): LocalPoint3[] {
  let result = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < 2; pass += 1) {
    result = result.map((point, index, all) => {
      if (index === 0 || index === all.length - 1) return point;
      const before = all[index - 1]?.y ?? point.y;
      const after = all[index + 1]?.y ?? point.y;
      return { ...point, y: before * 0.25 + point.y * 0.5 + after * 0.25 };
    });
  }
  return result;
}

function verticalRoadOffset(
  progress: number,
  layer: number,
  bridge: boolean,
  tunnel: boolean,
): number {
  const separation = Math.max(3, Math.abs(layer) * 3);
  if (bridge) return Math.sin(progress * Math.PI) * separation;
  if (tunnel) return -Math.sin(progress * Math.PI) * separation;
  return layer * 3;
}

function drapedRoadPoints(
  points: LocalPoint2[],
  sampler: ElevationSampler | undefined,
  layer: number,
  bridge: boolean,
  tunnel: boolean,
): LocalPoint3[] {
  const dense = densifyRoad(points);
  const distances = [0];
  for (let index = 1; index < dense.length; index += 1) {
    const previous = dense[index - 1];
    const point = dense[index];
    distances.push(
      (distances[index - 1] ?? 0) +
        (previous && point
          ? Math.hypot(point.x - previous.x, point.z - previous.z)
          : 0),
    );
  }
  const total = distances.at(-1) ?? 1;
  const terrainPoints = dense.map((point) => ({
    ...point,
    y: (sampler?.atLocal(point.x, point.z) ?? 0) + 0.1,
  }));
  const smoothed = smoothRoadHeights(terrainPoints);
  return smoothed.map((point, index) => ({
    ...point,
    y:
      point.y +
      verticalRoadOffset(
        (distances[index] ?? 0) / Math.max(1, total),
        layer,
        bridge,
        tunnel,
      ),
  }));
}

function maximumRoadGrade(points: LocalPoint3[]): number {
  let maximum = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    const run = Math.hypot(end.x - start.x, end.z - start.z);
    if (run > 0) maximum = Math.max(maximum, Math.abs(end.y - start.y) / run);
  }
  return maximum * 100;
}

function centerOfPoints(points: LocalPoint2[]): LocalPoint2 {
  if (points.length === 0) return { x: 0, z: 0 };
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: total.x / points.length, z: total.z / points.length };
}

function centerOfRings(rings: LocalPoint2[][]): LocalPoint2 {
  return centerOfPoints(rings[0] ?? []);
}

function coordinateKey(point: LocalPoint2, layer: number): string {
  return `${Math.round(point.x * 10)}:${Math.round(point.z * 10)}:${layer}`;
}

interface JunctionAccumulator {
  center: LocalPoint3;
  layer: number;
  radius: number;
  sourceIds: Set<string>;
  endpointCount: number;
  occurrenceCount: number;
  elevationSum: number;
}

function createJunctions(roads: RoadPlan[]): RoadJunctionPlan[] {
  const nodes = new Map<string, JunctionAccumulator>();
  for (const road of roads) {
    road.points.forEach((point, index) => {
      const key = coordinateKey(point, road.layer);
      const node = nodes.get(key) ?? {
        center: point,
        layer: road.layer,
        radius: road.width / 2,
        sourceIds: new Set<string>(),
        endpointCount: 0,
        occurrenceCount: 0,
        elevationSum: 0,
      };
      node.radius = Math.max(node.radius, road.width / 2);
      node.sourceIds.add(road.sourceId);
      node.occurrenceCount += 1;
      node.elevationSum += point.y;
      if (index === 0 || index === road.points.length - 1)
        node.endpointCount += 1;
      nodes.set(key, node);
    });
  }

  return [...nodes.entries()]
    .filter(([, node]) => node.endpointCount > 0 || node.sourceIds.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, node]) => {
      const sourceIds = [...node.sourceIds].sort();
      const kind =
        node.sourceIds.size > 1 || node.occurrenceCount > 1
          ? "intersection"
          : "end-cap";
      return {
        planId: `junction:${key}`,
        sourceIds,
        center: {
          ...node.center,
          y: node.elevationSum / node.occurrenceCount + 0.002,
        },
        radius: node.radius,
        kind,
        layer: node.layer,
        mesh: buildDiscSurface(
          {
            ...node.center,
            y: node.elevationSum / node.occurrenceCount + 0.002,
          },
          node.radius,
        ),
      };
    });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function deterministicHash(value: unknown): string {
  const input = JSON.stringify(stableValue(value));
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function overrideIdentity(overrides: WorldOverride[]): unknown[] {
  return overrides.map((override) => ({
    targetId: override.targetId,
    operation: override.operation,
    payloadVersion: override.payloadVersion,
    payload: override.payload,
  }));
}

function chunkIdFor(point: LocalPoint2, chunkSize: number): string {
  return `${Math.floor(point.x / chunkSize)}:${Math.floor(point.z / chunkSize)}`;
}

function makeChunk(id: string, chunkSize: number): WorldChunkPlan {
  const [xText = "0", zText = "0"] = id.split(":");
  const x = Number(xText);
  const z = Number(zText);
  const minX = x * chunkSize;
  const minZ = z * chunkSize;
  return {
    id,
    x,
    z,
    center: { x: minX + chunkSize / 2, z: minZ + chunkSize / 2 },
    bounds: { minX, minZ, maxX: minX + chunkSize, maxZ: minZ + chunkSize },
    roadIndexes: [],
    buildingIndexes: [],
    landIndexes: [],
    junctionIndexes: [],
    featureIds: [],
  };
}

function buildChunks(
  roads: RoadPlan[],
  buildings: BuildingPlan[],
  land: LandPlan[],
  junctions: RoadJunctionPlan[],
  chunkSize: number,
): { chunks: WorldChunkPlan[]; featureChunks: Record<string, string[]> } {
  const chunks = new Map<string, WorldChunkPlan>();
  const featureChunkSets = new Map<string, Set<string>>();
  const add = (
    featureIds: string[],
    center: LocalPoint2,
    collection: keyof Pick<
      WorldChunkPlan,
      "roadIndexes" | "buildingIndexes" | "landIndexes" | "junctionIndexes"
    >,
    index: number,
  ) => {
    const id = chunkIdFor(center, chunkSize);
    const chunk = chunks.get(id) ?? makeChunk(id, chunkSize);
    chunk[collection].push(index);
    for (const featureId of featureIds) {
      if (!chunk.featureIds.includes(featureId))
        chunk.featureIds.push(featureId);
      const ids = featureChunkSets.get(featureId) ?? new Set<string>();
      ids.add(id);
      featureChunkSets.set(featureId, ids);
    }
    chunks.set(id, chunk);
  };

  roads.forEach((road, index) =>
    add([road.sourceId], centerOfPoints(road.points), "roadIndexes", index),
  );
  buildings.forEach((building, index) =>
    add(
      [building.sourceId],
      centerOfRings(building.rings),
      "buildingIndexes",
      index,
    ),
  );
  land.forEach((area, index) =>
    add([area.sourceId], centerOfRings(area.rings), "landIndexes", index),
  );
  junctions.forEach((junction, index) =>
    add(junction.sourceIds, junction.center, "junctionIndexes", index),
  );

  const orderedChunks = [...chunks.values()]
    .map((chunk) => ({ ...chunk, featureIds: [...chunk.featureIds].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const featureChunks = Object.fromEntries(
    [...featureChunkSets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, ids]) => [sourceId, [...ids].sort()]),
  );
  return { chunks: orderedChunks, featureChunks };
}

export function changedOverrideTargetIds(
  previous: WorldOverride[],
  next: WorldOverride[],
): string[] {
  const entries = (items: WorldOverride[]) =>
    new Map(
      items.map((item) => [
        `${item.targetId}\u0000${item.operation}`,
        {
          targetId: item.targetId,
          hash: deterministicHash({
            payloadVersion: item.payloadVersion,
            payload: item.payload,
          }),
        },
      ]),
    );
  const before = entries(previous);
  const after = entries(next);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changed = new Set<string>();
  for (const key of keys) {
    if (before.get(key)?.hash !== after.get(key)?.hash) {
      const entry = after.get(key) ?? before.get(key);
      if (entry) changed.add(entry.targetId);
    }
  }
  return [...changed].sort();
}

export function affectedChunkIds(
  previous: WorldPlan,
  next: WorldPlan,
  targetIds: string[],
): string[] {
  const result = new Set<string>();
  for (const targetId of targetIds) {
    for (const id of previous.featureChunks[targetId] ?? []) result.add(id);
    for (const id of next.featureChunks[targetId] ?? []) result.add(id);
  }
  return [...result].sort();
}

export function closestPointOnRoad(
  road: RoadPlan,
  point: LocalPoint2,
): SpawnPose {
  let closest = road.points[0] ?? { x: 0, y: 0, z: 0 };
  let closestDistance = Number.POSITIVE_INFINITY;
  let yaw = 0;
  let pitch = 0;
  for (let index = 0; index < road.points.length - 1; index += 1) {
    const start = road.points[index];
    const end = road.points[index + 1];
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= 0) continue;
    const ratio = Math.max(
      0,
      Math.min(
        1,
        ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
      ),
    );
    const candidate = {
      x: start.x + dx * ratio,
      y: start.y + (end.y - start.y) * ratio,
      z: start.z + dz * ratio,
    };
    const distance = Math.hypot(point.x - candidate.x, point.z - candidate.z);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = candidate;
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(end.y - start.y, Math.hypot(dx, dz));
    }
  }
  return { sourceId: road.sourceId, ...closest, yaw, pitch };
}

export function resolveSpawnPose(
  plan: Pick<WorldPlan, "roads">,
  overrides: WorldOverride[],
): SpawnPose {
  const spawnOverride = [...overrides]
    .reverse()
    .find((override) => override.operation === "set-spawn");
  if (spawnOverride) {
    const road =
      plan.roads.find((item) => item.sourceId === spawnOverride.targetId) ??
      plan.roads.find((item) => item.points.length > 1);
    if (!road) return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    const x = spawnOverride.payload.x;
    const z = spawnOverride.payload.z;
    if (typeof x === "number" && typeof z === "number") {
      return closestPointOnRoad(road, { x, z });
    }
    return closestPointOnRoad(road, road.points[0] ?? { x: 0, z: 0 });
  }

  let closestPose: SpawnPose | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const road of plan.roads) {
    if (road.points.length < 2) continue;
    const pose = closestPointOnRoad(road, { x: 0, z: 0 });
    const distance = Math.hypot(pose.x, pose.z);
    if (distance < closestDistance) {
      closestPose = pose;
      closestDistance = distance;
    }
  }
  return closestPose ?? { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
}

export function buildWorldPlan(
  features: NormalizedFeature[],
  anchor: Wgs84Position,
  settings: GenerationSettings,
  overrides: WorldOverride[] = [],
  options: WorldBuildOptions = {},
): WorldPlan {
  const generatorVersion = options.generatorVersion ?? WORLD_GENERATOR_VERSION;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE_METERS;
  const terrainCellsPerChunk =
    options.terrainCellsPerChunk ?? DEFAULT_TERRAIN_CELLS_PER_CHUNK;
  const roadShoulderWidth =
    ROAD_TERRAIN_BLEND_WIDTH_METERS +
    roadTerrainCellSafetyMargin(chunkSize / terrainCellsPerChunk);
  const elevationSampler = options.elevation
    ? createElevationSampler(options.elevation, anchor)
    : undefined;
  const hidden = new Set(
    overrides
      .filter(
        (override) =>
          override.operation === "set-visible" &&
          override.payload.visible === false,
      )
      .map((override) => override.targetId),
  );
  const roads: RoadPlan[] = [];
  const buildings: BuildingPlan[] = [];
  const land: LandPlan[] = [];
  const diagnostics: Diagnostic[] = features.flatMap(
    (feature) => feature.warnings,
  );
  if (options.elevation?.provider === "flat-fallback") {
    diagnostics.push({
      code: "elevation.flat-fallback",
      severity: "warning",
      message: "No DEM coverage is available; generated terrain is flat.",
    });
  }

  for (const feature of features) {
    if (hidden.has(feature.sourceId)) continue;
    if (feature.kind === "road" && feature.geometry.type === "LineString") {
      const highway = feature.tags.highway ?? "";
      if (
        !settings.includeMinorPaths &&
        ["path", "footway", "cycleway"].includes(highway)
      )
        continue;
      const sourcePoints = deduplicatePoints(
        feature.geometry.coordinates.map((point) => localPoint(point, anchor)),
      );
      if (sourcePoints.length < 2) {
        diagnostics.push({
          code: "road.insufficient-points",
          severity: "warning",
          message:
            "Road geometry was skipped because it has fewer than two distinct points.",
          sourceId: feature.sourceId,
        });
        continue;
      }
      const width = estimateRoadWidthWithSource(feature, overrides);
      const layer = roadLayer(feature);
      const bridge = booleanTag(feature.tags.bridge);
      const tunnel = booleanTag(feature.tags.tunnel);
      const points = drapedRoadPoints(
        sourcePoints,
        elevationSampler,
        layer,
        bridge,
        tunnel,
      );
      const maximumGrade = maximumRoadGrade(points);
      if (maximumGrade > 20) {
        diagnostics.push({
          code: "road.suspicious-grade",
          severity: "warning",
          message: `Road grade reaches ${maximumGrade.toFixed(1)}%; inspect DEM coverage or vertical tags.`,
          sourceId: feature.sourceId,
        });
      }
      if (bridge || tunnel || layer !== 0) {
        diagnostics.push({
          code: "road.vertical-separation",
          severity: "info",
          message: `${bridge ? "Bridge deck" : tunnel ? "Tunnel open-cut" : "Layered road"} is generated separately at OSM layer ${layer}.`,
          sourceId: feature.sourceId,
        });
      }
      roads.push({
        planId: `road:${feature.sourceId}`,
        sourceId: feature.sourceId,
        ...(feature.tags.name ? { name: feature.tags.name } : {}),
        width: width.width,
        widthSource: width.source,
        points,
        mesh: buildRoadSurface(points, width.width),
        ...(!bridge && !tunnel && layer === 0 && elevationSampler
          ? {
              shoulderMesh: buildRoadShoulderSurface(
                points,
                width.width,
                elevationSampler.atLocal,
                roadShoulderWidth,
              ),
            }
          : {}),
        ...(feature.tags.surface ? { surface: feature.tags.surface } : {}),
        layer,
        bridge,
        tunnel,
      });
    } else if (feature.kind === "building") {
      const height = estimateBuildingHeight(feature, settings, overrides);
      polygonRings(feature, anchor).forEach((rings, polygonIndex) => {
        if ((rings[0]?.length ?? 0) < 4) {
          diagnostics.push({
            code: "building.invalid-ring",
            severity: "warning",
            message:
              "Building geometry was skipped because its outer ring is invalid.",
            sourceId: feature.sourceId,
          });
          return;
        }
        const sampledBaseHeights = (rings[0] ?? [])
          .map((point) => elevationSampler?.atLocal(point.x, point.z) ?? 0)
          .sort((left, right) => left - right);
        const baseHeight =
          sampledBaseHeights[Math.floor(sampledBaseHeights.length / 2)] ?? 0;
        buildings.push({
          planId: `building:${feature.sourceId}:${polygonIndex}`,
          sourceId: feature.sourceId,
          height: height.height,
          heightSource: height.source,
          baseHeight,
          rings,
          ...(feature.tags.building
            ? { buildingType: feature.tags.building }
            : {}),
        });
      });
    } else if (feature.kind === "land" || feature.kind === "water") {
      const areaKind = feature.kind;
      polygonRings(feature, anchor).forEach((rings, polygonIndex) => {
        if ((rings[0]?.length ?? 0) < 4) return;
        land.push({
          planId: `area:${feature.sourceId}:${polygonIndex}`,
          sourceId: feature.sourceId,
          kind: areaKind,
          rings,
          ...(feature.tags.landuse || feature.tags.natural
            ? { classification: feature.tags.landuse ?? feature.tags.natural }
            : {}),
        });
      });
    }
  }

  const junctions = createJunctions(roads);
  const groundRoads = roads.filter(
    (road) => !road.bridge && !road.tunnel && road.layer === 0,
  );
  const terrain =
    options.elevation && options.bounds
      ? buildTerrainPlan({
          bounds: options.bounds,
          anchor,
          elevation: options.elevation,
          chunkSize,
          cellsPerChunk: terrainCellsPerChunk,
          roads: roads
            .filter((road) => !road.bridge && (road.tunnel || road.layer === 0))
            .map((road) => ({
              points: road.points,
              width: road.width,
              tunnel: road.tunnel,
            })),
          junctions: createJunctions(groundRoads).map((junction) => ({
            center: junction.center,
            radius: junction.radius,
          })),
        })
      : undefined;
  const chunkResult = buildChunks(roads, buildings, land, junctions, chunkSize);
  const buildHash = deterministicHash({
    sourceSnapshotId: options.sourceSnapshotId,
    generatorVersion,
    features,
    anchor,
    settings,
    overrides: overrideIdentity(overrides),
    chunkSize,
    bounds: options.bounds,
    elevationContentHash: options.elevation?.contentHash,
    terrainCellsPerChunk,
  });
  return {
    roads,
    junctions,
    buildings,
    land,
    ...(terrain ? { terrain } : {}),
    chunks: chunkResult.chunks,
    featureChunks: chunkResult.featureChunks,
    featureCount: features.length,
    buildHash,
    generatorVersion,
    chunkSize,
    diagnostics,
  };
}
