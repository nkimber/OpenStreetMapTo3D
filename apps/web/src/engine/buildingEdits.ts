import {
  footprintSignature,
  openingWidth,
  type BuildingCustomization,
  type BuildingOpening,
  type MapPoint,
  type NormalizedFeature,
  type WorldDefinition,
} from "@osm3d/contracts";
import { localToWgs84, wgs84ToLocal } from "@osm3d/geo";
import {
  sampleTerrainPlan,
  SurfaceIndex,
  type BuildingPlan,
  type LocalPoint2,
  type WorldPlan,
} from "@osm3d/worldgen";

export function toLocal(
  point: MapPoint,
  definition: WorldDefinition,
): LocalPoint2 {
  const local = wgs84ToLocal(
    { longitude: point[0], latitude: point[1], height: 0 },
    definition.world.anchor,
  );
  return { x: local.east, z: -local.north };
}
export function toMap(
  point: LocalPoint2,
  definition: WorldDefinition,
): MapPoint {
  const map = localToWgs84(
    { east: point.x, north: -point.z, up: 0 },
    definition.world.anchor,
  );
  return [map.longitude, map.latitude];
}
export function emptyCustomization(
  feature: NormalizedFeature,
  revision = 0,
): BuildingCustomization {
  return {
    sourceId: feature.sourceId,
    revision,
    footprint: footprintSignature(feature.geometry),
    openings: [],
    appearance: {},
    boundaries: [],
    landscaping: [],
  };
}
export function hasCustomization(
  value: BuildingCustomization | undefined,
): boolean {
  return Boolean(
    value &&
    (value.openings.length ||
      value.boundaries.length ||
      value.landscaping?.length ||
      value.enhancement ||
      Object.keys(value.appearance).length),
  );
}
export function exteriorWalls(
  feature: NormalizedFeature,
): [MapPoint, MapPoint][] {
  const geometry = feature.geometry;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.flatMap((polygon) =>
    (polygon[0] ?? [])
      .slice(0, -1)
      .map(
        (a, i) =>
          [a.slice(0, 2), polygon[0]![i + 1]!.slice(0, 2)] as [
            MapPoint,
            MapPoint,
          ],
      ),
  );
}
export function nearestWall(
  feature: NormalizedFeature,
  point: LocalPoint2,
  definition: WorldDefinition,
) {
  return exteriorWalls(feature)
    .map((wall) => {
      const a = toLocal(wall[0], definition),
        b = toLocal(wall[1], definition);
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const fraction = Math.max(
        0,
        Math.min(
          1,
          ((point.x - a.x) * (b.x - a.x) + (point.z - a.z) * (b.z - a.z)) /
            (length * length),
        ),
      );
      return {
        wall,
        fraction,
        length,
        distance: Math.hypot(
          point.x - a.x - (b.x - a.x) * fraction,
          point.z - a.z - (b.z - a.z) * fraction,
        ),
      };
    })
    .sort((a, b) => a.distance - b.distance)[0];
}
export function openingPosition(
  opening: BuildingOpening,
  definition: WorldDefinition,
) {
  const a = toLocal(opening.wall[0], definition),
    b = toLocal(opening.wall[1], definition);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  return {
    x: a.x + (b.x - a.x) * opening.fraction,
    z: a.z + (b.z - a.z) * opening.fraction,
    dx: (b.x - a.x) / length,
    dz: (b.z - a.z) / length,
  };
}
export function openingOnBuilding(
  opening: BuildingOpening,
  building: BuildingPlan,
  definition: WorldDefinition,
): boolean {
  const a = toLocal(opening.wall[0], definition),
    b = toLocal(opening.wall[1], definition);
  const near = (p: LocalPoint2, q: LocalPoint2) =>
    Math.hypot(p.x - q.x, p.z - q.z) < 0.15;
  const ring = building.rings[0] ?? [];
  return ring
    .slice(1)
    .some(
      (d, i) =>
        (near(a, ring[i]!) && near(b, d)) || (near(b, ring[i]!) && near(a, d)),
    );
}

export function insidePolygon(point: LocalPoint2, ring: LocalPoint2[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function segmentDistance(p: LocalPoint2, a: LocalPoint2, b: LocalPoint2) {
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) /
        Math.max(1e-9, (b.x - a.x) ** 2 + (b.z - a.z) ** 2),
    ),
  );
  return Math.hypot(p.x - a.x - t * (b.x - a.x), p.z - a.z - t * (b.z - a.z));
}

interface RoadProjection {
  center: LocalPoint2;
  direction: LocalPoint2;
  distance: number;
  width: number;
}

function nearestRoadProjection(
  point: LocalPoint2,
  plan: WorldPlan,
  roadId?: string,
): RoadProjection | undefined {
  let nearest: RoadProjection | undefined;
  for (const road of plan.roads) {
    if (road.bridge || road.tunnel || (roadId && road.sourceId !== roadId))
      continue;
    for (let index = 0; index + 1 < road.points.length; index++) {
      const a = road.points[index]!,
        b = road.points[index + 1]!;
      const dx = b.x - a.x,
        dz = b.z - a.z,
        lengthSquared = dx * dx + dz * dz;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          ((point.x - a.x) * dx + (point.z - a.z) * dz) /
            Math.max(1e-9, lengthSquared),
        ),
      );
      const center = {
        x: a.x + dx * fraction,
        z: a.z + dz * fraction,
      };
      const distance = Math.hypot(point.x - center.x, point.z - center.z);
      if (!nearest || distance < nearest.distance) {
        const length = Math.max(1e-9, Math.sqrt(lengthSquared));
        nearest = {
          center,
          direction: { x: dx / length, z: dz / length },
          distance,
          width: road.width,
        };
      }
    }
  }
  return nearest;
}

const sacredRoadSurfaces = new WeakMap<WorldPlan, SurfaceIndex>();
function sacredRoadSurface(plan: WorldPlan): SurfaceIndex {
  let surface = sacredRoadSurfaces.get(plan);
  if (surface) return surface;
  const mesh = { positions: [] as number[], indices: [] as number[] };
  const append = (value: { positions: number[]; indices: number[] }) => {
    const offset = mesh.positions.length / 3;
    mesh.positions.push(...value.positions);
    mesh.indices.push(...value.indices.map((index) => index + offset));
  };
  const groundRoadIds = new Set<string>();
  for (const road of plan.roads) {
    if (road.bridge || road.tunnel) continue;
    groundRoadIds.add(road.sourceId);
    append(road.mesh);
  }
  for (const junction of plan.junctions)
    if (junction.sourceIds.some((sourceId) => groundRoadIds.has(sourceId)))
      append(junction.mesh);
  surface = new SurfaceIndex(mesh);
  sacredRoadSurfaces.set(plan, surface);
  return surface;
}

function crownTouchesRoad(
  point: LocalPoint2,
  radius: number,
  plan: WorldPlan,
): boolean {
  const surface = sacredRoadSurface(plan);
  for (const ringFraction of [0, 0.5, 1]) {
    const samples = ringFraction === 0 ? 1 : 24;
    for (let index = 0; index < samples; index++) {
      const angle = (index / samples) * Math.PI * 2;
      if (
        surface.height(
          point.x + Math.cos(angle) * radius * ringFraction,
          point.z + Math.sin(angle) * radius * ringFraction,
        ) !== undefined
      )
        return true;
    }
  }
  return false;
}

export function roadSafeLandscapePoint(
  point: LocalPoint2,
  crownRadius: number,
  plan: WorldPlan,
  fallback?: LocalPoint2,
): { point: LocalPoint2; moved: boolean } {
  const road = nearestRoadProjection(point, plan);
  let result = point;
  let moved = false;
  if (road) {
    const clearance = road.width / 2 + crownRadius + 0.35;
    if (road.distance < clearance) {
      let x = point.x - road.center.x,
        z = point.z - road.center.z;
      if (Math.hypot(x, z) < 0.05 && fallback) {
        x = fallback.x - road.center.x;
        z = fallback.z - road.center.z;
      }
      if (Math.hypot(x, z) < 0.05) {
        x = -road.direction.z;
        z = road.direction.x;
      }
      const length = Math.hypot(x, z);
      result = {
        x: road.center.x + (x / length) * clearance,
        z: road.center.z + (z / length) * clearance,
      };
      moved = true;
    }
  }
  for (const junction of plan.junctions) {
    const clearance = junction.radius + crownRadius + 0.35;
    let x = result.x - junction.center.x,
      z = result.z - junction.center.z,
      distance = Math.hypot(x, z);
    if (distance >= clearance) continue;
    if (distance < 0.05 && fallback) {
      x = fallback.x - junction.center.x;
      z = fallback.z - junction.center.z;
      distance = Math.hypot(x, z);
    }
    if (distance < 0.05) {
      x = 1;
      z = 0;
      distance = 1;
    }
    result = {
      x: junction.center.x + (x / distance) * clearance,
      z: junction.center.z + (z / distance) * clearance,
    };
    moved = true;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!crownTouchesRoad(result, crownRadius, plan)) break;
    const nearest = nearestRoadProjection(result, plan);
    if (!nearest) break;
    let x = result.x - nearest.center.x,
      z = result.z - nearest.center.z;
    const length = Math.hypot(x, z);
    if (length < 0.05) {
      x = -nearest.direction.z;
      z = nearest.direction.x;
    }
    const safeLength = Math.max(0.05, Math.hypot(x, z));
    result = {
      x: result.x + (x / safeLength) * 0.5,
      z: result.z + (z / safeLength) * 0.5,
    };
    moved = true;
  }
  return { point: result, moved };
}

export function trimRouteToRoadEdge(
  points: LocalPoint2[],
  routeWidth: number,
  plan: WorldPlan,
  roadId?: string,
): LocalPoint2[] {
  if (points.length < 2) return points;
  const end = points.at(-1)!;
  const previous = points.at(-2)!;
  const road = nearestRoadProjection(end, plan, roadId);
  if (!road) return points;
  const routeX = road.center.x - previous.x,
    routeZ = road.center.z - previous.z,
    routeLength = Math.max(1e-9, Math.hypot(routeX, routeZ));
  const routeNormal = { x: -routeZ / routeLength, z: routeX / routeLength };
  const roadNormal = { x: -road.direction.z, z: road.direction.x };
  const clearance =
    road.width / 2 +
    Math.abs(routeNormal.x * roadNormal.x + routeNormal.z * roadNormal.z) *
      (routeWidth / 2) +
    0.03;
  let trimmedEnd = end;
  if (road.distance < clearance) {
    let sideX = previous.x - road.center.x,
      sideZ = previous.z - road.center.z;
    if (Math.hypot(sideX, sideZ) < 0.05) {
      sideX = end.x - road.center.x;
      sideZ = end.z - road.center.z;
    }
    if (Math.hypot(sideX, sideZ) < 0.05) {
      sideX = roadNormal.x;
      sideZ = roadNormal.z;
    }
    const sideLength = Math.hypot(sideX, sideZ);
    trimmedEnd = {
      x: road.center.x + (sideX / sideLength) * clearance,
      z: road.center.z + (sideZ / sideLength) * clearance,
    };
  }
  const routeDx = trimmedEnd.x - previous.x,
    routeDz = trimmedEnd.z - previous.z,
    finalLength = Math.hypot(routeDx, routeDz),
    crossX = (-routeDz / Math.max(1e-9, finalLength)) * (routeWidth / 2),
    crossZ = (routeDx / Math.max(1e-9, finalLength)) * (routeWidth / 2),
    surface = sacredRoadSurface(plan);
  const intersectsRoad = (fraction: number) => {
    const center = {
      x: previous.x + routeDx * fraction,
      z: previous.z + routeDz * fraction,
    };
    return [-1, 0, 1].some(
      (side) =>
        surface.height(center.x + crossX * side, center.z + crossZ * side) !==
        undefined,
    );
  };
  let safe = 0;
  let blocked: number | undefined;
  const samples = Math.max(1, Math.ceil(finalLength / 0.25));
  if (intersectsRoad(0)) blocked = 0;
  else
    for (let sample = 1; sample <= samples; sample++) {
      const fraction = sample / samples;
      if (intersectsRoad(fraction)) {
        blocked = fraction;
        break;
      }
      safe = fraction;
    }
  if (blocked !== undefined) {
    let blockedBoundary = blocked;
    for (let iteration = 0; iteration < 18; iteration++) {
      const middle: number = (safe + blockedBoundary) / 2;
      if (intersectsRoad(middle)) blockedBoundary = middle;
      else safe = middle;
    }
    const safeFraction = Math.max(0, safe - 0.03 / Math.max(0.03, finalLength));
    trimmedEnd = {
      x: previous.x + routeDx * safeFraction,
      z: previous.z + routeDz * safeFraction,
    };
  }
  return [...points.slice(0, -1), trimmedEnd];
}

export function routeBlocked(
  points: LocalPoint2[],
  buildings: BuildingPlan[],
  width: number,
  ownerId: string,
): boolean {
  return points.slice(1).some((b, index) => {
    const a = points[index]!;
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5),
    );
    for (let i = 0; i <= steps; i++) {
      const p = {
        x: a.x + ((b.x - a.x) * i) / steps,
        z: a.z + ((b.z - a.z) * i) / steps,
      };
      for (const building of buildings) {
        const ring = building.rings[0] ?? [];
        // The entrance touches its own wall; only the initial short apron is exempt.
        if (
          building.sourceId === ownerId &&
          index === 0 &&
          Math.hypot(p.x - points[0]!.x, p.z - points[0]!.z) < width / 2 + 0.4
        )
          continue;
        if (
          insidePolygon(p, ring) ||
          ring
            .slice(1)
            .some((v, j) => segmentDistance(p, ring[j]!, v) < width / 2 + 0.15)
        )
          return true;
      }
    }
    return false;
  });
}

/** Short, terrain-aware routes with a visible failure instead of crossing houses. */
export function automaticPath(
  opening: BuildingOpening,
  sourceId: string,
  definition: WorldDefinition,
  plan: WorldPlan,
  roadId?: string,
): MapPoint[] {
  const start = openingPosition(opening, definition);
  const width = opening.kind === "garage" ? openingWidth(opening) : 1.2;
  const owner = plan.buildings.find(
    (building) =>
      building.sourceId === sourceId &&
      openingOnBuilding(opening, building, definition),
  );
  if (!owner) throw new Error("This building is hidden or unavailable.");
  let normal = { x: -start.dz, z: start.dx };
  if (
    insidePolygon(
      { x: start.x + normal.x * 0.2, z: start.z + normal.z * 0.2 },
      owner.rings[0]!,
    )
  )
    normal = { x: -normal.x, z: -normal.z };
  const apron = {
    x: start.x + normal.x * (width / 2 + 1),
    z: start.z + normal.z * (width / 2 + 1),
  };
  const candidates = plan.roads
    .filter(
      (road) =>
        !road.bridge && !road.tunnel && (!roadId || road.sourceId === roadId),
    )
    .flatMap((road) =>
      road.points.slice(1).map((b, index) => {
        const a = road.points[index]!;
        const length2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((apron.x - a.x) * (b.x - a.x) + (apron.z - a.z) * (b.z - a.z)) /
              Math.max(0.001, length2),
          ),
        );
        const center = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        const distance = Math.hypot(apron.x - center.x, apron.z - center.z);
        return {
          x:
            center.x +
            ((apron.x - center.x) / Math.max(0.01, distance)) *
              Math.max(0, road.width / 2 - 0.25),
          z:
            center.z +
            ((apron.z - center.z) / Math.max(0.01, distance)) *
              Math.max(0, road.width / 2 - 0.25),
          distance,
        };
      }),
    )
    .filter((p) => p.distance < 150)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12);
  for (const end of candidates) {
    const straight = [start, apron, end];
    if (!routeBlocked(straight, plan.buildings, width, sourceId))
      return straight.map((point) => toMap(point, definition));
    // Visibility graph around expanded building bounding boxes. Exact segment
    // clearance checks keep every accepted connection outside the buildings.
    const pad = width / 2 + 0.8;
    const nodes: LocalPoint2[] = [apron, end];
    for (const building of plan.buildings) {
      const ring = building.rings[0] ?? [];
      if (!ring.length) continue;
      const minX = Math.min(...ring.map((p) => p.x)) - pad,
        maxX = Math.max(...ring.map((p) => p.x)) + pad;
      const minZ = Math.min(...ring.map((p) => p.z)) - pad,
        maxZ = Math.max(...ring.map((p) => p.z)) + pad;
      if (
        maxX < Math.min(apron.x, end.x) - 20 ||
        minX > Math.max(apron.x, end.x) + 20 ||
        maxZ < Math.min(apron.z, end.z) - 20 ||
        minZ > Math.max(apron.z, end.z) + 20
      )
        continue;
      nodes.push(
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
      );
      if (nodes.length > 100) break;
    }
    const costs = nodes.map(() => Infinity),
      previous = nodes.map(() => -1),
      visited = new Set<number>();
    costs[0] = 0;
    while (visited.size < nodes.length) {
      let current = -1;
      nodes.forEach((_, i) => {
        if (
          !visited.has(i) &&
          Number.isFinite(costs[i]) &&
          (current < 0 || costs[i]! < costs[current]!)
        )
          current = i;
      });
      if (current < 0 || current === 1) break;
      visited.add(current);
      nodes.forEach((point, index) => {
        if (
          visited.has(index) ||
          routeBlocked([nodes[current]!, point], plan.buildings, width, "")
        )
          return;
        const cost =
          costs[current]! +
          Math.hypot(point.x - nodes[current]!.x, point.z - nodes[current]!.z);
        if (cost < costs[index]!) {
          costs[index] = cost;
          previous[index] = current;
        }
      });
    }
    if (Number.isFinite(costs[1])) {
      const route: LocalPoint2[] = [end];
      for (let i = previous[1]!; i >= 0; i = previous[i]!)
        route.unshift(nodes[i]!);
      route.unshift(start);
      if (!routeBlocked(route, plan.buildings, width, sourceId))
        return route.map((point) => toMap(point, definition));
    }
  }
  throw new Error(
    "No clear driveway or path found within 150 m. Choose another road or add route points manually.",
  );
}

const roadSurfaces = new WeakMap<WorldPlan, SurfaceIndex>();
export function routeHeight(point: LocalPoint2, plan: WorldPlan): number {
  let index = roadSurfaces.get(plan);
  if (!index) {
    const mesh = { positions: [] as number[], indices: [] as number[] };
    for (const road of plan.roads) {
      if (road.bridge || road.tunnel) continue;
      const offset = mesh.positions.length / 3;
      for (const p of road.mesh.positions) mesh.positions.push(p);
      for (const i of road.mesh.indices) mesh.indices.push(i + offset);
    }
    index = new SurfaceIndex(mesh);
    roadSurfaces.set(plan, index);
  }
  return (
    Math.max(
      sampleTerrainPlan(plan.terrain, point.x, point.z),
      index.height(point.x, point.z) ?? -Infinity,
    ) + 0.04
  );
}

export function routeMeetsRoad(
  point: LocalPoint2,
  plan: WorldPlan,
  roadId?: string,
): boolean {
  return plan.roads.some(
    (road) =>
      !road.bridge &&
      !road.tunnel &&
      (!roadId || road.sourceId === roadId) &&
      road.points
        .slice(1)
        .some(
          (b, i) =>
            segmentDistance(point, road.points[i]!, b) <= road.width / 2 + 0.5,
        ),
  );
}
