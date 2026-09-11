import type {
  AreaSelection,
  GeocodeResult,
  Wgs84Bounds,
} from "@osm3d/contracts";
import { selectionRing, selectionBounds } from "@osm3d/geo";
import type { OverpassResponse } from "@osm3d/osm";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createSampleOverpass } from "./sample-data.js";

const NominatimItemSchema = z.object({
  display_name: z.string(),
  lon: z.string(),
  lat: z.string(),
  type: z.string().optional(),
  boundingbox: z
    .tuple([z.string(), z.string(), z.string(), z.string()])
    .optional(),
});

const geocodeCache = new Map<string, GeocodeResult[]>();
let nominatimQueue: Promise<void> = Promise.resolve();
let lastNominatimRequestAt = 0;

async function waitForNominatimSlot(): Promise<void> {
  const previous = nominatimQueue;
  let release: (() => void) | undefined;
  nominatimQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const delay = Math.max(0, 1_000 - (Date.now() - lastNominatimRequestAt));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastNominatimRequestAt = Date.now();
  release?.();
}

export async function geocode(
  query: string,
  config: AppConfig,
): Promise<GeocodeResult[]> {
  const cacheKey = query.trim().toLocaleLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;
  await waitForNominatimSlot();
  const url = new URL(
    "search",
    config.NOMINATIM_BASE_URL.endsWith("/")
      ? config.NOMINATIM_BASE_URL
      : `${config.NOMINATIM_BASE_URL}/`,
  );
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": config.OSM_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  const items = z.array(NominatimItemSchema).parse(await response.json());
  const results = items.map<GeocodeResult>((item) => {
    const bounds = item.boundingbox;
    return {
      displayName: item.display_name,
      longitude: Number(item.lon),
      latitude: Number(item.lat),
      ...(item.type ? { type: item.type } : {}),
      ...(bounds
        ? {
            bounds: {
              south: Number(bounds[0]),
              north: Number(bounds[1]),
              west: Number(bounds[2]),
              east: Number(bounds[3]),
            },
          }
        : {}),
    };
  });
  geocodeCache.set(cacheKey, results);
  return results;
}

export function overpassQuery(
  bounds: Wgs84Bounds,
  selection?: AreaSelection,
): string {
  const bbox = selection
    ? `poly:"${selectionRing(selection)
        .slice(0, -1)
        .map(([lon, lat]) => `${lat} ${lon}`)
        .join(" ")}"`
    : `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `[out:json][timeout:25];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  way["building:part"](${bbox});
  relation["building"](${bbox});
  relation["building:part"](${bbox});
  way["landuse"](${bbox});
  relation["landuse"](${bbox});
  way["leisure"](${bbox});
  relation["leisure"](${bbox});
  way["natural"](${bbox});
  relation["natural"](${bbox});
  way["waterway"](${bbox});
  way["barrier"](${bbox});
);
out geom;`;
}

export async function fetchOsmData(
  provider: "overpass" | "fixture",
  bounds: Wgs84Bounds,
  config: AppConfig,
  selection?: AreaSelection,
): Promise<{ raw: OverpassResponse; query: string }> {
  if (provider === "fixture") {
    const raw = createSampleOverpass(
      selection ? selectionBounds({ ...selection, bearingDegrees: 0 }) : bounds,
    );
    if (selection) {
      const angle = (selection.bearingDegrees * Math.PI) / 180;
      const scale = Math.max(
        0.15,
        Math.cos((selection.center.latitude * Math.PI) / 180),
      );
      for (const element of raw.elements)
        for (const point of element.geometry ?? []) {
          const east = (point.lon - selection.center.longitude) * scale;
          const north = point.lat - selection.center.latitude;
          point.lon =
            selection.center.longitude +
            (east * Math.cos(angle) + north * Math.sin(angle)) / scale;
          point.lat =
            selection.center.latitude -
            east * Math.sin(angle) +
            north * Math.cos(angle);
        }
    }
    return {
      raw,
      query: selection ? "bundled-rotated-sample-v1" : "bundled-sample-v1",
    };
  }
  const query = overpassQuery(bounds, selection);
  const response = await fetch(config.OVERPASS_BASE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": config.OSM_USER_AGENT,
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok)
    throw new Error(`Overpass returned HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > config.MAX_IMPORT_RESPONSE_BYTES) {
    throw new Error(
      `Overpass response exceeded ${config.MAX_IMPORT_RESPONSE_BYTES} bytes`,
    );
  }
  return {
    raw: z
      .custom<OverpassResponse>((value) =>
        Boolean(value && typeof value === "object" && "elements" in value),
      )
      .parse(JSON.parse(new TextDecoder().decode(body))),
    query,
  };
}
