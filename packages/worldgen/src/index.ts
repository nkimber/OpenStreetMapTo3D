import type {
  GenerationSettings,
  GeoJsonPosition,
  NormalizedFeature,
  Wgs84Position,
  WorldOverride,
} from "@osm3d/contracts";
import { wgs84ToLocal } from "@osm3d/geo";

export interface LocalPoint2 {
  x: number;
  z: number;
}

export interface RoadPlan {
  sourceId: string;
  name?: string;
  width: number;
  points: LocalPoint2[];
  surface?: string;
}

export interface BuildingPlan {
  sourceId: string;
  height: number;
  heightSource: "source" | "levels" | "override" | "fallback";
  rings: LocalPoint2[][];
  buildingType?: string;
}

export interface LandPlan {
  sourceId: string;
  kind: "land" | "water";
  rings: LocalPoint2[][];
  classification?: string;
}

export interface WorldPlan {
  roads: RoadPlan[];
  buildings: BuildingPlan[];
  land: LandPlan[];
  featureCount: number;
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

export function estimateRoadWidth(
  feature: NormalizedFeature,
  overrides: WorldOverride[] = [],
): number {
  const override = overrideFor(overrides, feature.sourceId, "set-width");
  const overriddenWidth = override?.payload.width;
  if (typeof overriddenWidth === "number" && overriddenWidth > 0)
    return overriddenWidth;
  const explicit = numericFact(feature, "width");
  if (explicit !== undefined && explicit > 0) return explicit;
  const lanes = numericFact(feature, "lanes");
  if (lanes !== undefined && lanes > 0) return Math.max(3, lanes * 3.2);
  const highway = feature.tags.highway ?? "unclassified";
  return roadWidths[highway] ?? 5;
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

export function buildWorldPlan(
  features: NormalizedFeature[],
  anchor: Wgs84Position,
  settings: GenerationSettings,
  overrides: WorldOverride[] = [],
): WorldPlan {
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

  for (const feature of features) {
    if (hidden.has(feature.sourceId)) continue;
    if (feature.kind === "road" && feature.geometry.type === "LineString") {
      const highway = feature.tags.highway ?? "";
      if (
        !settings.includeMinorPaths &&
        ["path", "footway", "cycleway"].includes(highway)
      )
        continue;
      roads.push({
        sourceId: feature.sourceId,
        ...(feature.tags.name ? { name: feature.tags.name } : {}),
        width: estimateRoadWidth(feature, overrides),
        points: feature.geometry.coordinates.map((point) =>
          localPoint(point, anchor),
        ),
        ...(feature.tags.surface ? { surface: feature.tags.surface } : {}),
      });
    } else if (feature.kind === "building") {
      const height = estimateBuildingHeight(feature, settings, overrides);
      for (const rings of polygonRings(feature, anchor)) {
        buildings.push({
          sourceId: feature.sourceId,
          height: height.height,
          heightSource: height.source,
          rings,
          ...(feature.tags.building
            ? { buildingType: feature.tags.building }
            : {}),
        });
      }
    } else if (feature.kind === "land" || feature.kind === "water") {
      for (const rings of polygonRings(feature, anchor)) {
        land.push({
          sourceId: feature.sourceId,
          kind: feature.kind,
          rings,
          ...(feature.tags.landuse || feature.tags.natural
            ? { classification: feature.tags.landuse ?? feature.tags.natural }
            : {}),
        });
      }
    }
  }

  return { roads, buildings, land, featureCount: features.length };
}
