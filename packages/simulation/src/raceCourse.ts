export interface RacePoint {
  x: number;
  y: number;
  z: number;
}

export interface RaceRoad {
  id: string;
  width: number;
  layer: number;
  points: RacePoint[];
}

export interface RaceCourse {
  kind: "loop" | "out-and-back";
  points: RacePoint[];
  distances: number[];
  length: number;
  roadWidth: number;
  checkpointDistances: number[];
  turnDistances: number[];
}

interface Edge {
  from: string;
  to: string;
  length: number;
}

interface Graph {
  points: Map<string, RacePoint>;
  neighbors: Map<string, Edge[]>;
}

interface StartEdge {
  from: string;
  to: string;
  projection: RacePoint;
  roadWidth: number;
}

const coordinateKey = (point: RacePoint, layer: number) =>
  `${Math.round(point.x * 10)}:${Math.round(point.z * 10)}:${layer}`;

const planarDistance = (left: RacePoint, right: RacePoint) =>
  Math.hypot(right.x - left.x, right.z - left.z);

function buildGraph(roads: RaceRoad[]): Graph {
  const graph: Graph = { points: new Map(), neighbors: new Map() };
  const addEdge = (from: string, to: string, length: number) => {
    const edges = graph.neighbors.get(from) ?? [];
    if (!edges.some((edge) => edge.to === to)) edges.push({ from, to, length });
    graph.neighbors.set(from, edges);
  };
  for (const road of roads) {
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const fromPoint = road.points[index];
      const toPoint = road.points[index + 1];
      if (!fromPoint || !toPoint) continue;
      const from = coordinateKey(fromPoint, road.layer);
      const to = coordinateKey(toPoint, road.layer);
      const length = planarDistance(fromPoint, toPoint);
      if (length < 0.05) continue;
      graph.points.set(from, fromPoint);
      graph.points.set(to, toPoint);
      addEdge(from, to, length);
      addEdge(to, from, length);
    }
  }
  return graph;
}

function closestStartEdge(
  roads: RaceRoad[],
  start: Pick<RacePoint, "x" | "z">,
): StartEdge | undefined {
  let closest: StartEdge | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const road of roads) {
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const from = road.points[index];
      const to = road.points[index + 1];
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const lengthSquared = dx * dx + dz * dz;
      if (lengthSquared < 0.01) continue;
      const ratio = Math.max(
        0,
        Math.min(
          1,
          ((start.x - from.x) * dx + (start.z - from.z) * dz) / lengthSquared,
        ),
      );
      const projection = {
        x: from.x + dx * ratio,
        y: from.y + (to.y - from.y) * ratio,
        z: from.z + dz * ratio,
      };
      const distance = Math.hypot(
        start.x - projection.x,
        start.z - projection.z,
      );
      if (distance >= closestDistance) continue;
      closestDistance = distance;
      closest = {
        from: coordinateKey(from, road.layer),
        to: coordinateKey(to, road.layer),
        projection,
        roadWidth: road.width,
      };
    }
  }
  return closest;
}

interface PathResult {
  distance: number;
  keys: string[];
}

class MinQueue {
  private readonly items: Array<{ key: string; distance: number }> = [];

  push(key: string, distance: number): void {
    this.items.push({ key, distance });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.distance <= distance) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = { key, distance };
  }

  pop(): { key: string; distance: number } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    let index = 0;
    this.items[0] = last;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < this.items.length &&
        this.items[left]!.distance < this.items[smallest]!.distance
      )
        smallest = left;
      if (
        right < this.items.length &&
        this.items[right]!.distance < this.items[smallest]!.distance
      )
        smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [
        this.items[smallest]!,
        this.items[index]!,
      ];
      index = smallest;
    }
    return first;
  }

  get size(): number {
    return this.items.length;
  }
}

function shortestPath(
  graph: Graph,
  start: string,
  goal?: string,
  excluded?: { from: string; to: string },
): { paths: Map<string, PathResult>; farthest?: PathResult } {
  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  const pending = new MinQueue();
  pending.push(start, 0);
  while (pending.size > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === goal) break;
    for (const edge of graph.neighbors.get(current.key) ?? []) {
      if (
        excluded &&
        ((edge.from === excluded.from && edge.to === excluded.to) ||
          (edge.from === excluded.to && edge.to === excluded.from))
      )
        continue;
      const candidate = current.distance + edge.length;
      if (candidate >= (distances.get(edge.to) ?? Number.POSITIVE_INFINITY))
        continue;
      distances.set(edge.to, candidate);
      previous.set(edge.to, current.key);
      pending.push(edge.to, candidate);
    }
  }

  const paths = new Map<string, PathResult>();
  let farthest: PathResult | undefined;
  for (const [key, distance] of distances) {
    const keys = [key];
    let cursor = key;
    while (cursor !== start) {
      const prior = previous.get(cursor);
      if (!prior) break;
      keys.push(prior);
      cursor = prior;
    }
    keys.reverse();
    const path = { distance, keys };
    paths.set(key, path);
    if (!farthest || distance > farthest.distance) farthest = path;
  }
  return farthest ? { paths, farthest } : { paths };
}

function pathPoints(graph: Graph, keys: string[]): RacePoint[] {
  return keys.flatMap((key) => {
    const point = graph.points.get(key);
    return point ? [point] : [];
  });
}

function orientEndpoints(
  graph: Graph,
  edge: StartEdge,
  heading: Pick<RacePoint, "x" | "z">,
): [string, string] {
  const from = graph.points.get(edge.from);
  const to = graph.points.get(edge.to);
  if (!from || !to) return [edge.from, edge.to];
  const fromDot =
    (from.x - edge.projection.x) * heading.x +
    (from.z - edge.projection.z) * heading.z;
  const toDot =
    (to.x - edge.projection.x) * heading.x +
    (to.z - edge.projection.z) * heading.z;
  return toDot >= fromDot ? [edge.to, edge.from] : [edge.from, edge.to];
}

export function routeDistances(points: RacePoint[]): number[] {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(
      (distances[index - 1] ?? 0) +
        planarDistance(points[index - 1]!, points[index]!),
    );
  }
  return distances;
}

export function sampleRaceRoute(
  course: Pick<RaceCourse, "points" | "distances" | "length">,
  distance: number,
): RacePoint {
  const clamped = Math.max(0, Math.min(course.length, distance));
  let index = 1;
  while (index < course.distances.length && course.distances[index]! < clamped)
    index += 1;
  const end = course.points[index] ??
    course.points.at(-1) ?? { x: 0, y: 0, z: 0 };
  const start = course.points[index - 1] ?? end;
  const startDistance = course.distances[index - 1] ?? 0;
  const endDistance = course.distances[index] ?? startDistance;
  const ratio =
    endDistance <= startDistance
      ? 0
      : (clamped - startDistance) / (endDistance - startDistance);
  return {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
    z: start.z + (end.z - start.z) * ratio,
  };
}

export function nearestRaceProgress(
  course: Pick<RaceCourse, "points" | "distances" | "length">,
  point: Pick<RacePoint, "x" | "z">,
  previousDistance = 0,
): number {
  let bestDistance = previousDistance;
  let bestSeparation = Number.POSITIVE_INFINITY;
  const lower = Math.max(0, previousDistance - 20);
  const upper = Math.min(course.length, previousDistance + 90);
  for (let index = 0; index < course.points.length - 1; index += 1) {
    const segmentStartDistance = course.distances[index] ?? 0;
    const segmentEndDistance =
      course.distances[index + 1] ?? segmentStartDistance;
    if (segmentEndDistance < lower || segmentStartDistance > upper) continue;
    const start = course.points[index]!;
    const end = course.points[index + 1]!;
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
    const x = start.x + dx * ratio;
    const z = start.z + dz * ratio;
    const separation = Math.hypot(point.x - x, point.z - z);
    const routeDistance =
      segmentStartDistance +
      (segmentEndDistance - segmentStartDistance) * ratio;
    if (
      separation < bestSeparation ||
      (Math.abs(separation - bestSeparation) < 0.25 &&
        routeDistance > bestDistance)
    ) {
      bestSeparation = separation;
      bestDistance = routeDistance;
    }
  }
  return Math.max(previousDistance, bestDistance);
}

function turnDistances(points: RacePoint[], distances: number[]): number[] {
  const turns: number[] = [];
  for (let index = 2; index < points.length - 2; index += 1) {
    const before = points[index - 2]!;
    const center = points[index]!;
    const after = points[index + 2]!;
    const incoming = Math.atan2(center.x - before.x, center.z - before.z);
    const outgoing = Math.atan2(after.x - center.x, after.z - center.z);
    const difference = Math.atan2(
      Math.sin(outgoing - incoming),
      Math.cos(outgoing - incoming),
    );
    const distance = distances[index] ?? 0;
    if (
      Math.abs(difference) > Math.PI / 5 &&
      distance > 35 &&
      distance < (distances.at(-1) ?? 0) - 35 &&
      distance - (turns.at(-1) ?? -100) > 28
    )
      turns.push(distance);
  }
  return turns;
}

function completeCourse(
  kind: RaceCourse["kind"],
  points: RacePoint[],
  roadWidth: number,
  checkpointSpacing: number,
): RaceCourse {
  const distances = routeDistances(points);
  const length = distances.at(-1) ?? 0;
  const checkpointDistances: number[] = [];
  for (
    let distance = checkpointSpacing;
    distance < length - 30;
    distance += checkpointSpacing
  )
    checkpointDistances.push(distance);
  checkpointDistances.push(length);
  return {
    kind,
    points,
    distances,
    length,
    roadWidth,
    checkpointDistances,
    turnDistances: turnDistances(points, distances),
  };
}

export interface GenerateRaceCourseOptions {
  minimumLength?: number;
  checkpointSpacing?: number;
}

export function generateRaceCourse(
  roads: RaceRoad[],
  start: Pick<RacePoint, "x" | "z">,
  heading: Pick<RacePoint, "x" | "z">,
  options: GenerateRaceCourseOptions = {},
): RaceCourse | undefined {
  const minimumLength = options.minimumLength ?? 1_000;
  const checkpointSpacing = options.checkpointSpacing ?? 125;
  const graph = buildGraph(roads);
  const edge = closestStartEdge(roads, start);
  if (!edge) return undefined;
  const [forward, backward] = orientEndpoints(graph, edge, heading);

  const loop = shortestPath(graph, forward, backward, {
    from: edge.from,
    to: edge.to,
  }).paths.get(backward);
  if (loop) {
    const points = [
      edge.projection,
      ...pathPoints(graph, loop.keys),
      edge.projection,
    ];
    const length = routeDistances(points).at(-1) ?? 0;
    if (length >= minimumLength)
      return completeCourse("loop", points, edge.roadWidth, checkpointSpacing);
  }

  const excludedStartEdge = { from: edge.from, to: edge.to };
  const extendedSearch = (endpoint: string): PathResult | undefined => {
    const endpointPoint = graph.points.get(endpoint);
    const search = shortestPath(
      graph,
      endpoint,
      undefined,
      excludedStartEdge,
    ).farthest;
    if (!endpointPoint || !search) return undefined;
    return {
      distance:
        planarDistance(edge.projection, endpointPoint) + search.distance,
      keys: search.keys,
    };
  };
  const forwardSearch = extendedSearch(forward);
  const backwardSearch = extendedSearch(backward);
  const searches = [forwardSearch, backwardSearch].filter(
    (path): path is PathResult => Boolean(path && path.distance > 0),
  );
  if (
    searches.reduce((sum, path) => sum + path.distance * 2, 0) < minimumLength
  )
    return undefined;
  const points: RacePoint[] = [edge.projection];
  for (const search of searches) {
    const leg = pathPoints(graph, search.keys);
    points.push(...leg, ...leg.slice(0, -1).reverse(), edge.projection);
    if ((routeDistances(points).at(-1) ?? 0) >= minimumLength) break;
  }
  return completeCourse(
    "out-and-back",
    points,
    edge.roadWidth,
    checkpointSpacing,
  );
}
