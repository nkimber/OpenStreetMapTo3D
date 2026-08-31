import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Feature, FeatureCollection, Geometry, Polygon } from "geojson";
import type {
  NormalizedFeature,
  Wgs84Bounds,
  Wgs84Position,
} from "@osm3d/contracts";

interface MapPreviewProps {
  center: Wgs84Position;
  bounds: Wgs84Bounds;
  features: NormalizedFeature[];
  onCenterChange: (center: Wgs84Position) => void;
}

const selectionSourceId = "world-selection";
const previewSourceId = "osm-preview";

maplibregl.setWorkerUrl(workerUrl);

function boundsFeature(bounds: Wgs84Bounds): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.south],
          [bounds.east, bounds.north],
          [bounds.west, bounds.north],
          [bounds.west, bounds.south],
        ],
      ],
    },
  };
}

function previewFeatureCollection(
  features: NormalizedFeature[],
): FeatureCollection<Geometry> {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      type: "Feature",
      properties: { sourceId: feature.sourceId, kind: feature.kind },
      geometry: feature.geometry as Geometry,
    })),
  };
}

export function MapPreview({
  center,
  bounds,
  features,
  onCenterChange,
}: MapPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const callbackRef = useRef(onCenterChange);
  callbackRef.current = onCenterChange;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const styleUrl = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl || {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#dce6dc" },
          },
        ],
      },
      center: [center.longitude, center.latitude],
      zoom: 15,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true }),
      "top-right",
    );
    map.on("load", () => {
      map.addSource(previewSourceId, {
        type: "geojson",
        data: previewFeatureCollection(features),
      });
      map.addLayer({
        id: "osm-preview-land",
        type: "fill",
        source: previewSourceId,
        filter: ["in", ["get", "kind"], ["literal", ["land", "water"]]],
        paint: {
          "fill-color": [
            "match",
            ["get", "kind"],
            "water",
            "#4f9ec4",
            "#72a563",
          ],
          "fill-opacity": 0.58,
        },
      });
      map.addLayer({
        id: "osm-preview-buildings",
        type: "fill",
        source: previewSourceId,
        filter: ["==", ["get", "kind"], "building"],
        paint: {
          "fill-color": "#c77740",
          "fill-opacity": 0.78,
          "fill-outline-color": "#71482f",
        },
      });
      map.addLayer({
        id: "osm-preview-roads",
        type: "line",
        source: previewSourceId,
        filter: ["==", ["get", "kind"], "road"],
        paint: {
          "line-color": "#283a32",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });
      map.addSource(selectionSourceId, {
        type: "geojson",
        data: boundsFeature(bounds),
      });
      map.addLayer({
        id: "world-selection-fill",
        type: "fill",
        source: selectionSourceId,
        paint: { "fill-color": "#ef7d32", "fill-opacity": 0.16 },
      });
      map.addLayer({
        id: "world-selection-line",
        type: "line",
        source: selectionSourceId,
        paint: {
          "line-color": "#d45d12",
          "line-width": 3,
          "line-dasharray": [2, 1.5],
        },
      });
    });
    map.on("moveend", () => {
      const next = map.getCenter();
      callbackRef.current({
        longitude: next.lng,
        latitude: next.lat,
        height: 0,
      });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = map.getCenter();
    if (
      Math.abs(current.lng - center.longitude) > 1e-7 ||
      Math.abs(current.lat - center.latitude) > 1e-7
    ) {
      map.easeTo({
        center: [center.longitude, center.latitude],
        duration: 500,
      });
    }
  }, [center.latitude, center.longitude]);

  useEffect(() => {
    const source = mapRef.current?.getSource(selectionSourceId) as
      GeoJSONSource | undefined;
    source?.setData(boundsFeature(bounds));
  }, [bounds]);

  useEffect(() => {
    const source = mapRef.current?.getSource(previewSourceId) as
      GeoJSONSource | undefined;
    source?.setData(previewFeatureCollection(features));
  }, [features]);

  return (
    <div
      className="map-preview"
      ref={containerRef}
      aria-label="Neighborhood selection map"
    />
  );
}
