import type { Wgs84Bounds } from "@osm3d/contracts";
import type { OverpassResponse } from "@osm3d/osm";

export const sampleBounds: Wgs84Bounds = {
  west: -75.1735,
  south: 39.947,
  east: -75.161,
  north: 39.956,
};

export function createSampleOverpass(
  bounds: Wgs84Bounds = sampleBounds,
): OverpassResponse {
  const centerLon = (bounds.west + bounds.east) / 2;
  const centerLat = (bounds.south + bounds.north) / 2;
  const lonSpan = Math.min(bounds.east - bounds.west, 0.012);
  const latSpan = Math.min(bounds.north - bounds.south, 0.009);
  const west = centerLon - lonSpan / 2;
  const east = centerLon + lonSpan / 2;
  const south = centerLat - latSpan / 2;
  const north = centerLat + latSpan / 2;
  const verticals = [west + lonSpan * 0.18, centerLon, east - lonSpan * 0.18];
  const horizontals = [
    south + latSpan * 0.18,
    centerLat,
    north - latSpan * 0.18,
  ];
  let id = 10_000;
  const elements: OverpassResponse["elements"] = [];

  for (const [index, longitude] of verticals.entries()) {
    elements.push({
      type: "way",
      id: id++,
      version: 1,
      tags: {
        highway: index === 1 ? "secondary" : "residential",
        name:
          index === 1
            ? "Open Avenue"
            : `${index === 0 ? "West" : "East"} Street`,
        lanes: index === 1 ? "2" : "1",
        surface: "asphalt",
      },
      geometry: [
        { lon: longitude, lat: south },
        { lon: longitude + lonSpan * 0.015, lat: centerLat },
        { lon: longitude, lat: north },
      ],
    });
  }

  for (const [index, latitude] of horizontals.entries()) {
    elements.push({
      type: "way",
      id: id++,
      version: 1,
      tags: {
        highway: index === 1 ? "tertiary" : "residential",
        name:
          index === 1
            ? "Community Road"
            : `${index === 0 ? "South" : "North"} Lane`,
        lanes: "2",
        surface: "asphalt",
      },
      geometry: [
        { lon: west, lat: latitude },
        { lon: centerLon, lat: latitude + latSpan * 0.012 },
        { lon: east, lat: latitude },
      ],
    });
  }

  const blockLon = lonSpan * 0.12;
  const blockLat = latSpan * 0.11;
  const buildingCenters = [
    [west + lonSpan * 0.32, south + latSpan * 0.32],
    [west + lonSpan * 0.68, south + latSpan * 0.32],
    [west + lonSpan * 0.32, south + latSpan * 0.68],
    [west + lonSpan * 0.68, south + latSpan * 0.68],
  ];

  for (const [blockIndex, center] of buildingCenters.entries()) {
    const [blockCenterLon, blockCenterLat] = center as [number, number];
    for (let buildingIndex = 0; buildingIndex < 4; buildingIndex += 1) {
      const column = buildingIndex % 2;
      const row = Math.floor(buildingIndex / 2);
      const buildingLon = blockCenterLon + (column - 0.5) * blockLon * 0.72;
      const buildingLat = blockCenterLat + (row - 0.5) * blockLat * 0.72;
      const halfLon = blockLon * (blockIndex === 3 ? 0.2 : 0.15);
      const halfLat = blockLat * (blockIndex === 3 ? 0.18 : 0.14);
      elements.push({
        type: "way",
        id: id++,
        version: 1,
        tags: {
          building: blockIndex === 3 ? "apartments" : "house",
          "building:levels":
            blockIndex === 3
              ? String(3 + row)
              : String(1 + ((buildingIndex + blockIndex) % 2)),
          "addr:housenumber": String(100 + blockIndex * 10 + buildingIndex),
        },
        geometry: [
          { lon: buildingLon - halfLon, lat: buildingLat - halfLat },
          { lon: buildingLon + halfLon, lat: buildingLat - halfLat },
          { lon: buildingLon + halfLon, lat: buildingLat + halfLat },
          { lon: buildingLon - halfLon, lat: buildingLat + halfLat },
          { lon: buildingLon - halfLon, lat: buildingLat - halfLat },
        ],
      });
    }
  }

  const parkWest = west + lonSpan * 0.73;
  const parkEast = east - lonSpan * 0.03;
  const parkSouth = south + latSpan * 0.73;
  const parkNorth = north - latSpan * 0.03;
  elements.push({
    type: "way",
    id,
    version: 1,
    tags: { leisure: "park", name: "Open Data Park" },
    geometry: [
      { lon: parkWest, lat: parkSouth },
      { lon: parkEast, lat: parkSouth },
      { lon: parkEast, lat: parkNorth },
      { lon: parkWest, lat: parkNorth },
      { lon: parkWest, lat: parkSouth },
    ],
  });

  return {
    version: 0.6,
    generator: "OpenStreetMapTo3D sample fixture",
    elements,
  };
}
