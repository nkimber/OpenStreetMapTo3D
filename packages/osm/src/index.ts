import type {
  Diagnostic,
  FeatureKind,
  GeoJsonGeometry,
  GeoJsonPosition,
  NormalizedFeature,
} from "@osm3d/contracts";

interface OverpassGeometryPoint {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  geometry?: OverpassGeometryPoint[];
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  version?: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: OverpassGeometryPoint[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  elements: OverpassElement[];
}

export interface NormalizationResult {
  features: NormalizedFeature[];
  diagnostics: Diagnostic[];
}

const polygonKinds = new Set<FeatureKind>(["building", "land", "water"]);

export function parseOsmNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const feetInches = normalized.match(
    /^(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?"?$/,
  );
  if (feetInches) {
    const feet = Number(feetInches[1]);
    const inches = Number(feetInches[2] ?? 0);
    return feet * 0.3048 + inches * 0.0254;
  }
  const match = normalized.match(/^(-?\d+(?:[.,]\d+)?)\s*(m|meter|meters)?$/);
  if (!match) return undefined;
  const parsed = Number(match[1]?.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classify(tags: Record<string, string>): FeatureKind | undefined {
  if (tags.building || tags["building:part"]) return "building";
  if (tags.highway) return "road";
  if (tags.waterway || tags.natural === "water" || tags.water) return "water";
  if (tags.landuse || tags.leisure || tags.natural) return "land";
  if (tags.barrier) return "barrier";
  return undefined;
}

function factsFor(
  tags: Record<string, string>,
): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {};
  const height = parseOsmNumber(tags.height);
  const levels = parseOsmNumber(tags["building:levels"]);
  const width = parseOsmNumber(tags.width);
  const lanes = parseOsmNumber(tags.lanes);
  if (height !== undefined) facts.height = height;
  if (levels !== undefined) facts.levels = levels;
  if (width !== undefined) facts.width = width;
  if (lanes !== undefined) facts.lanes = lanes;
  if (tags.highway) facts.highway = tags.highway;
  if (tags.building) facts.building = tags.building;
  if (tags.surface) facts.surface = tags.surface;
  if (tags.name) facts.name = tags.name;
  if (tags.layer) facts.layer = tags.layer;
  if (tags.bridge === "yes") facts.bridge = true;
  if (tags.tunnel === "yes") facts.tunnel = true;
  return facts;
}

function pointsToPositions(points: OverpassGeometryPoint[]): GeoJsonPosition[] {
  return points.map((point) => [point.lon, point.lat]);
}

function closeRing(points: GeoJsonPosition[]): GeoJsonPosition[] {
  if (points.length === 0) return points;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return points;
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, [...first] as GeoJsonPosition];
}

function samePoint(
  a: GeoJsonPosition | undefined,
  b: GeoJsonPosition | undefined,
): boolean {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
}

function joinMemberWays(
  members: OverpassMember[],
  role: string,
): GeoJsonPosition[][] {
  const chains = members
    .filter(
      (member) =>
        member.role === role && member.geometry && member.geometry.length > 1,
    )
    .map((member) => pointsToPositions(member.geometry ?? []));
  const rings: GeoJsonPosition[][] = [];

  while (chains.length > 0) {
    let chain = chains.shift() ?? [];
    let changed = true;
    while (changed && chain.length > 0 && !samePoint(chain[0], chain.at(-1))) {
      changed = false;
      for (let index = 0; index < chains.length; index += 1) {
        const candidate = chains[index];
        if (!candidate) continue;
        if (samePoint(chain.at(-1), candidate[0])) {
          chain = [...chain, ...candidate.slice(1)];
        } else if (samePoint(chain.at(-1), candidate.at(-1))) {
          chain = [...chain, ...candidate.slice(0, -1).reverse()];
        } else if (samePoint(chain[0], candidate.at(-1))) {
          chain = [...candidate.slice(0, -1), ...chain];
        } else if (samePoint(chain[0], candidate[0])) {
          chain = [...candidate.slice(1).reverse(), ...chain];
        } else {
          continue;
        }
        chains.splice(index, 1);
        changed = true;
        break;
      }
    }
    if (chain.length >= 4 && samePoint(chain[0], chain.at(-1)))
      rings.push(chain);
  }

  return rings;
}

function pointInRing(point: GeoJsonPosition, ring: GeoJsonPosition[]): boolean {
  let inside = false;
  for (
    let current = 0, previous = ring.length - 1;
    current < ring.length;
    previous = current++
  ) {
    const currentPoint = ring[current];
    const previousPoint = ring[previous];
    if (!currentPoint || !previousPoint) continue;
    const intersects =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function relationGeometry(
  element: OverpassElement,
): GeoJsonGeometry | undefined {
  const members = element.members ?? [];
  const outers = joinMemberWays(members, "outer");
  const inners = joinMemberWays(members, "inner");
  if (outers.length === 0) return undefined;
  const polygons = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const point = inner[0];
    if (!point) continue;
    const polygonIndex = outers.findIndex((outer) => pointInRing(point, outer));
    if (polygonIndex >= 0) polygons[polygonIndex]?.push(inner);
  }
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] ?? [] }
    : { type: "MultiPolygon", coordinates: polygons };
}

function elementGeometry(
  element: OverpassElement,
  kind: FeatureKind,
): GeoJsonGeometry | undefined {
  if (
    element.type === "node" &&
    element.lon !== undefined &&
    element.lat !== undefined
  ) {
    return { type: "Point", coordinates: [element.lon, element.lat] };
  }
  if (element.type === "relation") return relationGeometry(element);
  const points = element.geometry ? pointsToPositions(element.geometry) : [];
  if (points.length < 2) return undefined;
  if (polygonKinds.has(kind) && points.length >= 3) {
    return { type: "Polygon", coordinates: [closeRing(points)] };
  }
  return { type: "LineString", coordinates: points };
}

export function normalizeOverpass(
  response: OverpassResponse,
): NormalizationResult {
  const features: NormalizedFeature[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const element of response.elements) {
    const tags = element.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    const sourceId = `osm:${element.type}:${element.id}`;
    const geometry = elementGeometry(element, kind);
    if (!geometry) {
      diagnostics.push({
        code: "OSM_GEOMETRY_UNUSABLE",
        severity: "warning",
        message:
          "The feature did not contain enough geometry to generate a world object.",
        sourceId,
      });
      continue;
    }
    const warnings: Diagnostic[] = [];
    if (kind === "building" && !tags.height && !tags["building:levels"]) {
      warnings.push({
        code: "BUILDING_HEIGHT_ESTIMATED",
        severity: "info",
        message: "The building height will be estimated from project defaults.",
        sourceId,
      });
    }
    features.push({
      sourceId,
      sourceType: element.type,
      ...(element.version === undefined
        ? {}
        : { sourceVersion: element.version }),
      kind,
      geometry,
      tags,
      facts: factsFor(tags),
      warnings,
    });
  }

  if (!features.some((feature) => feature.kind === "road")) {
    diagnostics.push({
      code: "NO_ROADS_FOUND",
      severity: "error",
      message: "No driveable road geometry was found in the selected area.",
    });
  }

  return { features, diagnostics };
}
