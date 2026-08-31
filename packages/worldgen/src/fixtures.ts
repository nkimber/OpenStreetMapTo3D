import type { NormalizedFeature } from "@osm3d/contracts";

type Coordinate = [number, number];

function road(
  id: string,
  coordinates: Coordinate[],
  tags: Record<string, string> = {},
): NormalizedFeature {
  return {
    sourceId: `fixture:way:${id}`,
    sourceType: "way",
    kind: "road",
    geometry: { type: "LineString", coordinates },
    tags: { highway: "residential", ...tags },
    facts: {},
    warnings: [],
  };
}

function building(
  id: string,
  longitude: number,
  latitude: number,
): NormalizedFeature {
  const delta = 0.00008;
  return {
    sourceId: `fixture:way:${id}`,
    sourceType: "way",
    kind: "building",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [longitude - delta, latitude - delta],
          [longitude + delta, latitude - delta],
          [longitude + delta, latitude + delta],
          [longitude - delta, latitude + delta],
          [longitude - delta, latitude - delta],
        ],
      ],
    },
    tags: { building: "apartments", "building:levels": "4" },
    facts: { levels: 4 },
    warnings: [],
  };
}

const center: Coordinate = [-75, 40];

export const representativeFixtures = {
  suburban: [
    road("suburban-main", [[-75.004, 40], center, [-74.996, 40]]),
    road("suburban-branch", [center, [-75, 40.003]]),
    road(
      "suburban-culdesac",
      [
        [-75.002, 39.998],
        [-75.002, 39.996],
      ],
      { name: "Cedar Close" },
    ),
  ],
  denseUrban: [
    road("urban-east-west", [[-75.004, 40], center, [-74.996, 40]], {
      highway: "primary",
      lanes: "4",
    }),
    road("urban-north-south", [[-75, 39.996], center, [-75, 40.004]], {
      highway: "secondary",
      lanes: "2",
    }),
    ...Array.from({ length: 12 }, (_, index) =>
      building(
        `urban-building-${index}`,
        -75.003 + (index % 4) * 0.002,
        39.9975 + Math.floor(index / 4) * 0.0025,
      ),
    ),
  ],
  curvedRoad: [
    road(
      "curve",
      [
        [-75.004, 39.998],
        [-75.002, 39.999],
        center,
        [-74.998, 40.002],
        [-74.996, 40.0025],
      ],
      { name: "Arc Road" },
    ),
  ],
  layered: [
    road("ground", [[-75.004, 40], center, [-74.996, 40]]),
    road("bridge", [[-75, 39.996], center, [-75, 40.004]], {
      bridge: "yes",
      layer: "1",
      highway: "primary",
    }),
    road(
      "tunnel",
      [
        [-75.002, 39.996],
        [-75.002, 40.004],
      ],
      { tunnel: "yes", layer: "-1" },
    ),
  ],
} satisfies Record<string, NormalizedFeature[]>;
