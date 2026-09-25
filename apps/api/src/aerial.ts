import sharp from "sharp";
import {
  BuildingCustomizationSchema,
  footprintSignature,
  type BuildingCustomization,
  type BuildingEnhancementProposal,
  type LandscapingFeature,
  type MapPoint,
  type NormalizedFeature,
  type SceneEnhancementTile,
} from "@osm3d/contracts";
import type { AppConfig } from "./config.js";

const IMAGE_SIZE = 512;
const TILE_IMAGE_SIZE = 1024;
const TILE_BUILDING_BUFFER_METERS = 30;
const MAX_TILE_BUILDINGS = 60;
const METERS_PER_LATITUDE_DEGREE = 111_320;
const ATTRIBUTION = "USGS The National Map — NAIP imagery";
const LICENSE = "Public domain (United States government work)";
const ROAD_CLEARANCE_METERS = 0.35;
const ROAD_WIDTHS: Record<string, number> = {
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
  cycleway: 2.5,
  footway: 1.8,
  path: 1.4,
  steps: 1.4,
};

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

function featureCenter(feature: NormalizedFeature): MapPoint | undefined {
  const ring = exteriorRing(feature);
  const points =
    ring.length > 1 &&
    ring[0]![0] === ring.at(-1)![0] &&
    ring[0]![1] === ring.at(-1)![1]
      ? ring.slice(0, -1)
      : ring;
  if (!points.length) return undefined;
  return points.reduce<MapPoint>(
    (center, point) => [
      center[0] + point[0] / points.length,
      center[1] + point[1] / points.length,
    ],
    [0, 0],
  );
}

function squareBounds(center: MapPoint, sizeMeters: number): Bounds {
  const half = sizeMeters / 2;
  const latitudePadding = half / METERS_PER_LATITUDE_DEGREE;
  const longitudePadding =
    half /
    (METERS_PER_LATITUDE_DEGREE *
      Math.max(0.2, Math.cos((center[1] * Math.PI) / 180)));
  return {
    west: center[0] - longitudePadding,
    south: center[1] - latitudePadding,
    east: center[0] + longitudePadding,
    north: center[1] + latitudePadding,
  };
}

function boundsContain(bounds: Bounds, point: MapPoint): boolean {
  return (
    point[0] >= bounds.west &&
    point[0] < bounds.east &&
    point[1] >= bounds.south &&
    point[1] < bounds.north
  );
}

function exteriorRing(feature: NormalizedFeature): MapPoint[] {
  const polygons =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];
  return (polygons[0]?.[0] ?? []).map((point) => [point[0], point[1]]);
}

function bufferedBounds(ring: MapPoint[], bufferMeters: number): Bounds {
  const longitudes = ring.map((point) => point[0]);
  const latitudes = ring.map((point) => point[1]);
  const latitude =
    latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length;
  const latitudePadding = bufferMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudePadding =
    bufferMeters /
    (METERS_PER_LATITUDE_DEGREE *
      Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
  return {
    west: Math.min(...longitudes) - longitudePadding,
    south: Math.min(...latitudes) - latitudePadding,
    east: Math.max(...longitudes) + longitudePadding,
    north: Math.max(...latitudes) + latitudePadding,
  };
}

function imagePoint(point: MapPoint, bounds: Bounds, image: DecodedImage) {
  return {
    x:
      ((point[0] - bounds.west) / (bounds.east - bounds.west)) *
      (image.width - 1),
    y:
      ((bounds.north - point[1]) / (bounds.north - bounds.south)) *
      (image.height - 1),
  };
}

function mapPoint(
  x: number,
  y: number,
  bounds: Bounds,
  image: DecodedImage,
): MapPoint {
  return [
    bounds.west + (x / (image.width - 1)) * (bounds.east - bounds.west),
    bounds.north - (y / (image.height - 1)) * (bounds.north - bounds.south),
  ];
}

function inside(
  point: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>,
) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}

function pixel(
  image: DecodedImage,
  x: number,
  y: number,
): [number, number, number] {
  const index =
    (Math.max(0, Math.min(image.height - 1, y)) * image.width +
      Math.max(0, Math.min(image.width - 1, x))) *
    image.channels;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
}

function colorHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function roofObservation(
  image: DecodedImage,
  bounds: Bounds,
  ring: MapPoint[],
) {
  const polygon = ring.map((point) => imagePoint(point, bounds, image));
  const xs = polygon.map((point) => point.x),
    ys = polygon.map((point) => point.y);
  const minX = Math.max(1, Math.floor(Math.min(...xs)));
  const maxX = Math.min(image.width - 2, Math.ceil(Math.max(...xs)));
  const minY = Math.max(1, Math.floor(Math.min(...ys)));
  const maxY = Math.min(image.height - 2, Math.ceil(Math.max(...ys)));
  let red = 0,
    green = 0,
    blue = 0,
    count = 0;
  let xx = 0,
    yy = 0,
    xy = 0,
    gradients = 0;
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      if (!inside({ x, y }, polygon)) continue;
      const [r, g, b] = pixel(image, x, y);
      red += r;
      green += g;
      blue += b;
      count++;
      const luminance = (px: number, py: number) => {
        const [pr, pg, pb] = pixel(image, px, py);
        return pr * 0.299 + pg * 0.587 + pb * 0.114;
      };
      const gx = luminance(x + 1, y) - luminance(x - 1, y);
      const gy = luminance(x, y + 1) - luminance(x, y - 1);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 10) continue;
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
      gradients++;
    }
  }
  const safeCount = Math.max(1, count);
  const anisotropy = Math.hypot(xx - yy, 2 * xy) / Math.max(1, xx + yy);
  const texture = gradients / safeCount;
  const shape =
    texture < 0.06 ? "flat" : anisotropy > 0.28 ? "gabled" : "hipped";
  const gradientAngle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ridgeAngle = gradientAngle + Math.PI / 2;
  let longest = ring[0]!,
    longestAngle = 0,
    longestLength = 0;
  ring.slice(1).forEach((point) => {
    const dx = (point[0] - longest[0]) * Math.cos((point[1] * Math.PI) / 180);
    const dy = point[1] - longest[1];
    const length = Math.hypot(dx, dy);
    if (length > longestLength) {
      longestLength = length;
      longestAngle = Math.atan2(-dy, dx);
    }
    longest = point;
  });
  const alignment = Math.abs(Math.cos(ridgeAngle - longestAngle));
  return {
    shape: shape as "flat" | "gabled" | "hipped",
    orientation: (alignment >= Math.SQRT1_2 ? "along" : "across") as
      "along" | "across",
    color: colorHex(red / safeCount, green / safeCount, blue / safeCount),
    confidence: Math.min(
      0.88,
      Math.max(0.35, 0.38 + texture * 1.8 + anisotropy * 0.3),
    ),
  };
}

interface RoadProjection {
  point: MapPoint;
  roadId: string;
  distance: number;
  width: number;
  direction: { x: number; y: number };
}

function roadWidth(feature: NormalizedFeature): number {
  const explicit = Number(feature.facts.width);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const lanes = Number(feature.facts.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return Math.max(3, lanes * 3.2);
  return ROAD_WIDTHS[feature.tags.highway ?? "unclassified"] ?? 5;
}

function nearestPointOnRoad(
  point: MapPoint,
  features: NormalizedFeature[],
): RoadProjection | undefined {
  const latitude = point[1];
  const scaleX =
    METERS_PER_LATITUDE_DEGREE * Math.cos((latitude * Math.PI) / 180);
  let best: RoadProjection | undefined;
  for (const road of features.filter((feature) => feature.kind === "road")) {
    if (road.geometry.type !== "LineString") continue;
    const line = road.geometry.coordinates;
    for (let index = 0; index + 1 < line.length; index++) {
      const a = line[index]!,
        b = line[index + 1]!;
      const ax = (a[0] - point[0]) * scaleX,
        ay = (a[1] - point[1]) * METERS_PER_LATITUDE_DEGREE;
      const bx = (b[0] - point[0]) * scaleX,
        by = (b[1] - point[1]) * METERS_PER_LATITUDE_DEGREE;
      const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          -(ax * (bx - ax) + ay * (by - ay)) / Math.max(1e-9, lengthSquared),
        ),
      );
      const x = ax + (bx - ax) * fraction,
        y = ay + (by - ay) * fraction;
      const segmentLength = Math.hypot(bx - ax, by - ay);
      const candidate = {
        point: [
          point[0] + x / scaleX,
          point[1] + y / METERS_PER_LATITUDE_DEGREE,
        ] as MapPoint,
        roadId: road.sourceId,
        distance: Math.hypot(x, y),
        width: roadWidth(road),
        direction: {
          x: (bx - ax) / Math.max(1e-9, segmentLength),
          y: (by - ay) / Math.max(1e-9, segmentLength),
        },
      };
      if (!best || candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
}

function offsetFromRoad(
  source: MapPoint,
  road: RoadProjection,
  clearance: number,
  fallback: MapPoint,
): MapPoint {
  const latitude = source[1];
  const scaleX =
    METERS_PER_LATITUDE_DEGREE * Math.cos((latitude * Math.PI) / 180);
  let x = (source[0] - road.point[0]) * scaleX;
  let y = (source[1] - road.point[1]) * METERS_PER_LATITUDE_DEGREE;
  if (Math.hypot(x, y) < 0.05) {
    x = (fallback[0] - road.point[0]) * scaleX;
    y = (fallback[1] - road.point[1]) * METERS_PER_LATITUDE_DEGREE;
  }
  if (Math.hypot(x, y) < 0.05) {
    x = -road.direction.y;
    y = road.direction.x;
  }
  const length = Math.hypot(x, y);
  return [
    road.point[0] + (x / length / scaleX) * clearance,
    road.point[1] + (y / length / METERS_PER_LATITUDE_DEGREE) * clearance,
  ];
}

function mapDistance(a: MapPoint, b: MapPoint): number {
  const latitude = (a[1] + b[1]) / 2;
  return Math.hypot(
    (a[0] - b[0]) *
      METERS_PER_LATITUDE_DEGREE *
      Math.cos((latitude * Math.PI) / 180),
    (a[1] - b[1]) * METERS_PER_LATITUDE_DEGREE,
  );
}

function protectRoads(
  landscaping: LandscapingFeature[],
  features: NormalizedFeature[],
  ring: MapPoint[],
): LandscapingFeature[] {
  const buildingCenter: MapPoint = [
    ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
    ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
  ];
  const prepared = landscaping.map((item) => {
    const road = nearestPointOnRoad(item.point, features);
    const clearance = road
      ? road.width / 2 + item.crownRadius + ROAD_CLEARANCE_METERS
      : 0;
    if (!road || road.distance >= clearance) return { item, moved: false };
    return {
      item: {
        ...item,
        point: offsetFromRoad(item.point, road, clearance, buildingCenter),
      },
      moved: true,
    };
  });
  const accepted: LandscapingFeature[] = [];
  for (const [index, candidate] of prepared.entries()) {
    if (candidate.moved && candidate.item.kind === "tree") {
      const nearbyExistingTree = prepared.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          !other.moved &&
          other.item.kind === "tree" &&
          mapDistance(candidate.item.point, other.item.point) <
            Math.max(
              2.5,
              (candidate.item.crownRadius + other.item.crownRadius) * 0.65,
            ),
      );
      const nearbyAcceptedTree = accepted.some(
        (other) =>
          other.kind === "tree" &&
          mapDistance(candidate.item.point, other.point) <
            Math.max(
              2.5,
              (candidate.item.crownRadius + other.crownRadius) * 0.65,
            ),
      );
      if (nearbyExistingTree || nearbyAcceptedTree) continue;
    }
    accepted.push(candidate.item);
  }
  return accepted;
}

function drivewayObservation(
  image: DecodedImage,
  bounds: Bounds,
  ring: MapPoint[],
  features: NormalizedFeature[],
) {
  let best:
    | {
        wall: [MapPoint, MapPoint];
        road: MapPoint;
        roadId: string;
        score: number;
      }
    | undefined;
  for (let index = 0; index + 1 < ring.length; index++) {
    const wall: [MapPoint, MapPoint] = [ring[index]!, ring[index + 1]!];
    const latitude = (wall[0][1] + wall[1][1]) / 2;
    const wallLength = Math.hypot(
      (wall[1][0] - wall[0][0]) *
        METERS_PER_LATITUDE_DEGREE *
        Math.cos((latitude * Math.PI) / 180),
      (wall[1][1] - wall[0][1]) * METERS_PER_LATITUDE_DEGREE,
    );
    if (wallLength < 3) continue;
    const midpoint: MapPoint = [
      (wall[0][0] + wall[1][0]) / 2,
      (wall[0][1] + wall[1][1]) / 2,
    ];
    const road = nearestPointOnRoad(midpoint, features);
    if (!road || road.distance < 2 || road.distance > 45) continue;
    const routeX =
      (road.point[0] - midpoint[0]) *
      METERS_PER_LATITUDE_DEGREE *
      Math.cos((latitude * Math.PI) / 180);
    const routeY = (road.point[1] - midpoint[1]) * METERS_PER_LATITUDE_DEGREE;
    const routeLength = Math.max(1e-9, Math.hypot(routeX, routeY));
    const routeNormal = { x: -routeY / routeLength, y: routeX / routeLength };
    const roadNormal = { x: -road.direction.y, y: road.direction.x };
    const endClearance =
      road.width / 2 +
      Math.abs(routeNormal.x * roadNormal.x + routeNormal.y * roadNormal.y) *
        1.35;
    const roadEdge = offsetFromRoad(
      midpoint,
      road,
      endClearance + 0.03,
      midpoint,
    );
    const start = imagePoint(midpoint, bounds, image),
      end = imagePoint(roadEdge, bounds, image);
    let surface = 0;
    const samples = 18;
    for (let sample = 2; sample < samples - 2; sample++) {
      const fraction = sample / samples;
      const [r, g, b] = pixel(
        image,
        Math.round(start.x + (end.x - start.x) * fraction),
        Math.round(start.y + (end.y - start.y) * fraction),
      );
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      if (spread < 42 && brightness > 55 && brightness < 235) surface++;
    }
    const score = surface / (samples - 4);
    if (!best || score > best.score)
      best = { wall, road: roadEdge, roadId: road.roadId, score };
  }
  return best;
}

function landscapingObservation(
  image: DecodedImage,
  bounds: Bounds,
  ring: MapPoint[],
  features: NormalizedFeature[],
) {
  const stride = 3;
  const columns = Math.floor(image.width / stride),
    rows = Math.floor(image.height / stride);
  const polygon = ring.map((point) => imagePoint(point, bounds, image));
  const vegetation = new Uint8Array(columns * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const px = x * stride,
        py = y * stride;
      if (inside({ x: px, y: py }, polygon)) continue;
      const [r, g, b] = pixel(image, px, py);
      if (g > r * 1.08 && g > b * 1.12 && g - Math.min(r, b) > 16 && g < 205)
        vegetation[y * columns + x] = 1;
    }
  const visited = new Uint8Array(vegetation.length);
  const components: Array<{
    x: number;
    y: number;
    cells: number;
    strength: number;
  }> = [];
  for (let origin = 0; origin < vegetation.length; origin++) {
    if (!vegetation[origin] || visited[origin]) continue;
    const queue = [origin];
    visited[origin] = 1;
    let head = 0,
      sumX = 0,
      sumY = 0,
      strength = 0;
    while (head < queue.length) {
      const index = queue[head++]!,
        x = index % columns,
        y = Math.floor(index / columns);
      sumX += x;
      sumY += y;
      const [r, g, b] = pixel(image, x * stride, y * stride);
      strength += Math.min(1, (g - Math.max(r, b)) / 60);
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nx = x + dx,
          ny = y + dy,
          next = ny * columns + nx;
        if (
          nx >= 0 &&
          nx < columns &&
          ny >= 0 &&
          ny < rows &&
          vegetation[next] &&
          !visited[next]
        ) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    if (queue.length >= 5)
      components.push({
        x: (sumX / queue.length) * stride,
        y: (sumY / queue.length) * stride,
        cells: queue.length,
        strength: strength / queue.length,
      });
  }
  const latitude = (bounds.north + bounds.south) / 2;
  const metersPerPixel = Math.sqrt(
    (((bounds.east - bounds.west) *
      METERS_PER_LATITUDE_DEGREE *
      Math.cos((latitude * Math.PI) / 180)) /
      image.width) *
      (((bounds.north - bounds.south) * METERS_PER_LATITUDE_DEGREE) /
        image.height),
  );
  const candidates = components
    .map((component, index) => {
      const radius =
        Math.sqrt((component.cells * stride * stride) / Math.PI) *
        metersPerPixel;
      return {
        id: `aerial-landscape-${index + 1}`,
        kind: (radius >= 1.45 ? "tree" : "bush") as "tree" | "bush",
        point: mapPoint(component.x, component.y, bounds, image),
        crownRadius: Math.min(8, Math.max(0.5, radius)),
        height:
          radius >= 1.45
            ? Math.min(16, Math.max(3.5, radius * 2.4))
            : Math.min(2.2, Math.max(0.6, radius * 1.35)),
        confidence: Math.min(
          0.9,
          Math.max(0.35, 0.45 + component.strength * 0.45),
        ),
      };
    })
    .filter((item) => item.crownRadius <= 8)
    .sort((a, b) => b.crownRadius - a.crownRadius);
  return protectRoads(candidates, features, ring).slice(0, 16);
}

export async function analyzeAerialImage(
  bytes: Buffer,
  bounds: Bounds,
  feature: NormalizedFeature,
  features: NormalizedFeature[],
  existing?: BuildingCustomization,
  bufferMeters = 30,
  sourceUrl = "https://imagery.nationalmap.gov/",
): Promise<BuildingEnhancementProposal> {
  const decoded = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image: DecodedImage = {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  };
  const ring = exteriorRing(feature);
  if (ring.length < 4)
    throw new Error("The selected building has no usable exterior footprint.");
  const roof = roofObservation(image, bounds, ring);
  const driveway = drivewayObservation(image, bounds, ring, features);
  const landscaping = landscapingObservation(image, bounds, ring, features);
  const analyzedAt = new Date().toISOString();
  const base = BuildingCustomizationSchema.parse(
    existing ?? {
      sourceId: feature.sourceId,
      revision: 0,
      footprint: footprintSignature(feature.geometry),
    },
  );
  const detectedDriveway = Boolean(driveway && driveway.score >= 0.48);
  const openings = [...base.openings];
  if (
    detectedDriveway &&
    driveway &&
    !openings.some((opening) => opening.kind === "garage")
  )
    openings.push({
      id: "aerial-garage",
      kind: "garage",
      wall: driveway.wall,
      fraction: 0.5,
      cars: 1,
      width: 1,
      sill: 1,
      roadId: driveway.roadId,
      path: [
        [
          (driveway.wall[0][0] + driveway.wall[1][0]) / 2,
          (driveway.wall[0][1] + driveway.wall[1][1]) / 2,
        ],
        driveway.road,
      ],
    });
  const proposedCustomization = BuildingCustomizationSchema.parse({
    ...base,
    openings,
    appearance: {
      ...base.appearance,
      roof: roof.shape,
      roofOrientation: roof.orientation,
      roofColor: roof.color,
    },
    landscaping,
    enhancement: {
      provider: "usgs-naip",
      analyzedAt,
      bufferMeters,
      sourceUrl,
      attribution: ATTRIBUTION,
      license: LICENSE,
      roofConfidence: roof.confidence,
      ...(driveway ? { drivewayConfidence: driveway.score } : {}),
      ...(landscaping.length
        ? {
            vegetationConfidence:
              landscaping.reduce((sum, item) => sum + item.confidence, 0) /
              landscaping.length,
          }
        : {}),
    },
  });
  const preview = await sharp(bytes).jpeg({ quality: 82 }).toBuffer();
  const trees = landscaping.filter((item) => item.kind === "tree").length;
  return {
    sourceId: feature.sourceId,
    bufferMeters,
    imagery: {
      previewDataUrl: `data:image/jpeg;base64,${preview.toString("base64")}`,
      analyzedAt,
      provider: "usgs-naip",
      attribution: ATTRIBUTION,
      license: LICENSE,
      sourceUrl,
    },
    observations: {
      roof,
      ...(driveway
        ? {
            driveway: {
              detected: detectedDriveway,
              confidence: driveway.score,
            },
          }
        : {}),
      landscaping: {
        trees,
        bushes: landscaping.length - trees,
        confidence: landscaping.length
          ? landscaping.reduce((sum, item) => sum + item.confidence, 0) /
            landscaping.length
          : 0.25,
      },
    },
    proposedCustomization,
    warnings: [
      "Computer-vision estimates can be wrong; inspect the live 3D preview before applying.",
      "The public 3DEP elevation surface is bare earth, so this preview does not infer roof height from LiDAR yet.",
      ...(landscaping.length === 16
        ? ["Only the 16 strongest vegetation candidates are shown."]
        : []),
    ],
  };
}

export async function createBuildingEnhancement(
  feature: NormalizedFeature,
  features: NormalizedFeature[],
  existing: BuildingCustomization | undefined,
  bufferMeters: number,
  config: AppConfig,
): Promise<BuildingEnhancementProposal> {
  const ring = exteriorRing(feature);
  if (ring.length < 4)
    throw new Error("The selected building has no usable exterior footprint.");
  const bounds = bufferedBounds(ring, bufferMeters);
  const bytes = await fetchAerialImage(bounds, IMAGE_SIZE, config);
  const sourceUrl = config.USGS_NAIP_BASE_URL.replace(/\/exportImage\/?$/, "");
  return analyzeAerialImage(
    bytes,
    bounds,
    feature,
    features,
    existing,
    bufferMeters,
    sourceUrl,
  );
}

async function fetchAerialImage(
  bounds: Bounds,
  imageSize: number,
  config: AppConfig,
): Promise<Buffer> {
  const endpoint = new URL(config.USGS_NAIP_BASE_URL);
  endpoint.searchParams.set(
    "bbox",
    [bounds.west, bounds.south, bounds.east, bounds.north].join(","),
  );
  endpoint.searchParams.set("bboxSR", "4326");
  endpoint.searchParams.set("imageSR", "4326");
  endpoint.searchParams.set("size", `${imageSize},${imageSize}`);
  endpoint.searchParams.set("format", "jpgpng");
  endpoint.searchParams.set(
    "renderingRule",
    JSON.stringify({ rasterFunction: "NaturalColor" }),
  );
  endpoint.searchParams.set("f", "image");
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": config.OSM_USER_AGENT,
      Accept: "image/jpeg,image/png",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`USGS NAIP imagery returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/"))
    throw new Error("USGS NAIP did not return an image for this location.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8_000_000)
    throw new Error("The aerial image exceeded the 8 MB safety limit.");
  return bytes;
}

async function cropAerialImage(
  bytes: Buffer,
  sourceBounds: Bounds,
  requestedBounds: Bounds,
): Promise<{ bytes: Buffer; bounds: Bounds }> {
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? TILE_IMAGE_SIZE;
  const height = metadata.height ?? TILE_IMAGE_SIZE;
  const x = (longitude: number) =>
    ((longitude - sourceBounds.west) /
      (sourceBounds.east - sourceBounds.west)) *
    width;
  const y = (latitude: number) =>
    ((sourceBounds.north - latitude) /
      (sourceBounds.north - sourceBounds.south)) *
    height;
  const left = Math.max(
    0,
    Math.min(width - 2, Math.floor(x(requestedBounds.west))),
  );
  const right = Math.max(
    left + 2,
    Math.min(width, Math.ceil(x(requestedBounds.east))),
  );
  const top = Math.max(
    0,
    Math.min(height - 2, Math.floor(y(requestedBounds.north))),
  );
  const bottom = Math.max(
    top + 2,
    Math.min(height, Math.ceil(y(requestedBounds.south))),
  );
  const cropBounds: Bounds = {
    west:
      sourceBounds.west +
      (left / width) * (sourceBounds.east - sourceBounds.west),
    east:
      sourceBounds.west +
      (right / width) * (sourceBounds.east - sourceBounds.west),
    north:
      sourceBounds.north -
      (top / height) * (sourceBounds.north - sourceBounds.south),
    south:
      sourceBounds.north -
      (bottom / height) * (sourceBounds.north - sourceBounds.south),
  };
  return {
    bytes: await sharp(bytes)
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "fill" })
      .toBuffer(),
    bounds: cropBounds,
  };
}

function distanceMeters(a: MapPoint, b: MapPoint): number {
  const latitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return Math.hypot(
    (a[0] - b[0]) * METERS_PER_LATITUDE_DEGREE * Math.cos(latitude),
    (a[1] - b[1]) * METERS_PER_LATITUDE_DEGREE,
  );
}

/**
 * Analyze every building whose footprint center lies in a driving tile. The
 * imagery includes a 30 m apron around the tile so edge buildings still get
 * the same local context as a manually enhanced building.
 */
export async function createSceneEnhancementTile(
  center: MapPoint,
  sizeMeters: number,
  features: NormalizedFeature[],
  existing: BuildingCustomization[],
  config: AppConfig,
): Promise<SceneEnhancementTile> {
  const tileBounds = squareBounds(center, sizeMeters);
  const imageryBounds = squareBounds(
    center,
    sizeMeters + TILE_BUILDING_BUFFER_METERS * 2,
  );
  const buildings = features
    .filter((feature) => feature.kind === "building")
    .map((feature) => ({ feature, center: featureCenter(feature) }))
    .filter((item): item is { feature: NormalizedFeature; center: MapPoint } =>
      Boolean(item.center && boundsContain(tileBounds, item.center)),
    )
    .sort((a, b) => a.feature.sourceId.localeCompare(b.feature.sourceId));
  const existingById = new Map(
    existing.map((value) => [value.sourceId, value]),
  );
  const pending = buildings
    .filter((item) => !existingById.has(item.feature.sourceId))
    .slice(0, MAX_TILE_BUILDINGS);
  const sourceUrl = config.USGS_NAIP_BASE_URL.replace(/\/exportImage\/?$/, "");
  const analyzedAt = new Date().toISOString();

  if (!pending.length)
    return {
      center,
      sizeMeters,
      analyzedAt,
      imagery: {
        provider: "usgs-naip",
        attribution: ATTRIBUTION,
        license: LICENSE,
        sourceUrl,
      },
      customizations: [],
      analyzedBuildings: 0,
      skippedBuildings: buildings.length,
      failedSourceIds: [],
    };

  const image = await fetchAerialImage(imageryBounds, TILE_IMAGE_SIZE, config);
  const customizations: BuildingCustomization[] = [];
  const failedSourceIds: string[] = [];
  const acceptedLandscaping: LandscapingFeature[] = [];
  for (const { feature } of pending) {
    try {
      const requestedBounds = bufferedBounds(
        exteriorRing(feature),
        TILE_BUILDING_BUFFER_METERS,
      );
      const crop = await cropAerialImage(image, imageryBounds, requestedBounds);
      const proposal = await analyzeAerialImage(
        crop.bytes,
        crop.bounds,
        feature,
        features,
        undefined,
        TILE_BUILDING_BUFFER_METERS,
        sourceUrl,
      );
      const landscaping = proposal.proposedCustomization.landscaping.filter(
        (item) => {
          const duplicate = acceptedLandscaping.some(
            (other) =>
              other.kind === item.kind &&
              distanceMeters(other.point, item.point) <
                Math.max(
                  1,
                  Math.min(other.crownRadius, item.crownRadius) * 0.6,
                ),
          );
          if (!duplicate) acceptedLandscaping.push(item);
          return !duplicate;
        },
      );
      customizations.push({
        ...proposal.proposedCustomization,
        landscaping,
      });
    } catch {
      failedSourceIds.push(feature.sourceId);
    }
  }
  return {
    center,
    sizeMeters,
    analyzedAt,
    imagery: {
      provider: "usgs-naip",
      attribution: ATTRIBUTION,
      license: LICENSE,
      sourceUrl,
    },
    customizations,
    analyzedBuildings: customizations.length,
    skippedBuildings: buildings.length - pending.length,
    failedSourceIds,
  };
}
