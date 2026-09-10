import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FeatureCollection, Geometry } from "geojson";
import type { NormalizedFeature } from "@osm3d/contracts";
import type { VehicleMapPose } from "../engine/driveMapPose.js";

interface DriveMiniMapProps {
  features: NormalizedFeature[];
  pose: VehicleMapPose;
}

const sourceId = "drive-minimap-features";

maplibregl.setWorkerUrl(workerUrl);

function featureCollection(
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

function localMapStyle(features: NormalizedFeature[]): StyleSpecification {
  return {
    version: 8,
    sources: {
      [sourceId]: {
        type: "geojson",
        data: featureCollection(features),
      },
    },
    layers: [
      {
        id: "drive-minimap-background",
        type: "background",
        paint: { "background-color": "#dce6dc" },
      },
      {
        id: "drive-minimap-land",
        type: "fill",
        source: sourceId,
        filter: ["in", ["get", "kind"], ["literal", ["land", "water"]]],
        paint: {
          "fill-color": [
            "match",
            ["get", "kind"],
            "water",
            "#4f9ec4",
            "#72a563",
          ],
          "fill-opacity": 0.48,
        },
      },
      {
        id: "drive-minimap-buildings",
        type: "fill",
        source: sourceId,
        filter: ["==", ["get", "kind"], "building"],
        paint: {
          "fill-color": "#bd7a4b",
          "fill-opacity": 0.72,
          "fill-outline-color": "#6d4931",
        },
      },
      {
        id: "drive-minimap-roads",
        type: "line",
        source: sourceId,
        filter: ["==", ["get", "kind"], "road"],
        paint: {
          "line-color": "#f7f3e9",
          "line-width": 4,
          "line-opacity": 0.95,
        },
      },
    ],
  };
}

export function DriveMiniMap({ features, pose }: DriveMiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      // The drive overlay deliberately uses the already-downloaded world data
      // instead of a remote style. It must remain available during offline and
      // cached-data testing, even when the external preview tiles are blocked.
      style: localMapStyle(featuresRef.current),
      center: [pose.longitude, pose.latitude],
      bearing: pose.headingDegrees,
      zoom: 16.5,
      pitch: 0,
      interactive: false,
      attributionControl: false,
    });
    map.on("load", () => {
      const source = map.getSource(sourceId) as GeoJSONSource | undefined;
      source?.setData(featureCollection(featuresRef.current));
      map.resize();
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const source = mapRef.current?.getSource(sourceId) as
      GeoJSONSource | undefined;
    source?.setData(featureCollection(features));
  }, [features]);

  useEffect(() => {
    mapRef.current?.easeTo({
      center: [pose.longitude, pose.latitude],
      bearing: pose.headingDegrees,
      duration: 260,
      essential: true,
    });
  }, [pose.headingDegrees, pose.latitude, pose.longitude]);

  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  return (
    <section
      className={`drive-minimap glass-panel ${expanded ? "expanded" : "collapsed"}`}
      aria-label="Drive map"
    >
      <div className="drive-minimap-map" ref={containerRef} />
      <span className="drive-minimap-label">Navigation</span>
      <span className="drive-minimap-credit">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>
      </span>
      <div className="drive-minimap-car" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 2 20 21l-8-4-8 4 8-19Z" />
        </svg>
      </div>
      <button
        className="drive-minimap-toggle"
        type="button"
        aria-label={expanded ? "Collapse drive map" : "Expand drive map"}
        aria-expanded={expanded}
        title={expanded ? "Collapse drive map" : "Expand drive map"}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7.5 9 5l6 2.5L20 5v11.5L15 19l-6-2.5L4 19V7.5Z" />
            <path d="M9 5v11.5M15 7.5V19" />
          </svg>
        )}
      </button>
    </section>
  );
}
