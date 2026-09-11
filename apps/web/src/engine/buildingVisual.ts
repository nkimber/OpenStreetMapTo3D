import * as THREE from "three";
import type { BuildingPlan } from "@osm3d/worldgen";

type Point = { x: number; z: number };
type Plane = { x: number; z: number; c: number };
const value = (plane: Plane, point: Point) =>
  plane.x * point.x + plane.z * point.z + plane.c;
function clip(points: Point[], plane: Plane): Point[] {
  const result: Point[] = [];
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]!;
    const da = value(plane, a),
      db = value(plane, b);
    if (da <= 1e-8) result.push(a);
    if (da < 0 !== db < 0) {
      const t = da / (da - db);
      result.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  });
  return result;
}
function seedOf(id: string): number {
  let seed = 0;
  for (const char of id)
    seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  return seed;
}
function safeColor(raw: string | undefined, fallback: string): string {
  return raw &&
    (/^#[\da-f]{6}$/i.test(raw) ||
      Object.hasOwn(THREE.Color.NAMES, raw.toLowerCase()))
    ? raw.toLowerCase()
    : fallback;
}

export function buildingAppearance(building: BuildingPlan) {
  const tags = building.appearanceTags ?? {};
  const seed = seedOf(building.sourceId);
  const residential =
    /^(house|detached|residential|semidetached_house|terrace|bungalow)$/.test(
      building.buildingType ?? "",
    ) ||
    ((!building.buildingType || building.buildingType === "yes") &&
      building.height <= 12);
  const requested = tags["roof:shape"];
  const roof =
    requested === "gabled" || requested === "hipped" || requested === "flat"
      ? requested
      : requested
        ? "flat"
        : residential
          ? seed % 2
            ? "gabled"
            : "hipped"
          : "flat";
  const parsedHeight = Number.parseFloat(tags["roof:height"] ?? "");
  const rise =
    roof === "flat"
      ? 0
      : Math.min(
          building.height * 0.4,
          Math.max(0, building.height - 2.6),
          Number.isFinite(parsedHeight) && parsedHeight > 0
            ? parsedHeight
            : 1.8 + (seed % 8) / 10,
        );
  const finish =
    tags["building:material"] ?? ["brick", "siding", "stucco"][seed % 3]!;
  return {
    roof,
    rise,
    finish,
    residential,
    eaves: building.height - rise,
    wallColor: safeColor(
      tags["building:colour"],
      (finish === "brick"
        ? ["#a97964", "#916350", "#b69982"]
        : ["#d0c5b0", "#bbc6bc", "#d7d4c8"])[seed % 3]!,
    ),
    roofColor: safeColor(
      tags["roof:colour"],
      ["#514d48", "#655b52", "#555e65"][seed % 3]!,
    ),
    estimated:
      !requested || !tags["building:colour"] || !tags["building:material"],
  };
}

/** Split each footprint triangle by roof planes, never span a courtyard or concavity. */
export function roofSurface(building: BuildingPlan) {
  const appearance = buildingAppearance(building);
  const rings = building.rings.map((ring) => ring.slice(0, -1));
  const outer = rings[0] ?? [];
  if (outer.length < 3)
    return { positions: [] as number[], planes: [] as Plane[], appearance };
  let edge = { x: 1, z: 0 },
    longest = 0;
  outer.forEach((a, i) => {
    const b = outer[(i + 1) % outer.length]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length > longest) {
      longest = length;
      edge = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
    }
  });
  if (building.appearanceTags?.["roof:orientation"] === "across")
    edge = { x: -edge.z, z: edge.x };
  const across = { x: -edge.z, z: edge.x };
  const axes = [across, edge];
  const planes: Plane[] = [];
  for (const axis of axes.slice(0, appearance.roof === "hipped" ? 2 : 1)) {
    const projections = outer.map(
      (point) => point.x * axis.x + point.z * axis.z,
    );
    const lo = Math.min(...projections),
      hi = Math.max(...projections);
    const slope = appearance.rise / Math.max(0.1, (hi - lo) / 2);
    planes.push(
      { x: axis.x * slope, z: axis.z * slope, c: -lo * slope },
      { x: -axis.x * slope, z: -axis.z * slope, c: hi * slope },
    );
  }
  const flat = rings.flat();
  const triangles = THREE.ShapeUtils.triangulateShape(
    outer.map((p) => new THREE.Vector2(p.x, p.z)),
    rings.slice(1).map((r) => r.map((p) => new THREE.Vector2(p.x, p.z))),
  );
  const positions: number[] = [];
  for (const triangle of triangles) {
    planes.forEach((plane, index) => {
      let polygon = triangle.map((i) => flat[i]!);
      planes.forEach((other, j) => {
        if (index !== j)
          polygon = clip(polygon, {
            x: plane.x - other.x,
            z: plane.z - other.z,
            c: plane.c - other.c,
          });
      });
      // Flat planes coincide: emit only once.
      if (appearance.rise === 0 && index !== 0) return;
      for (let i = 1; i + 1 < polygon.length; i++) {
        for (const point of [polygon[0]!, polygon[i]!, polygon[i + 1]!])
          positions.push(
            point.x,
            appearance.eaves + Math.max(0, value(plane, point)),
            point.z,
          );
      }
    });
  }
  return { positions, planes, appearance };
}

function surfaceMaterial(
  color: string,
  finish: string,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec2 surfaceUv;\n" +
      shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nsurfaceUv = uv;",
      );
    shader.fragmentShader = "varying vec2 surfaceUv;\n" + shader.fragmentShader;
    const brick = finish === "brick";
    const patterned = brick || ["siding", "wood", "shingles"].includes(finish);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      vec2 cell = surfaceUv * vec2(${brick ? "2.8, 5.0" : "2.0, 4.0"});
      cell.x += mod(floor(cell.y), 2.0) * 0.5;
      vec2 fw = max(fwidth(cell), vec2(0.001));
      vec2 line = 1.0 - smoothstep(vec2(0.035), vec2(0.035) + fw, fract(cell));
      float mortar = ${patterned ? (brick || finish === "shingles" ? "max(line.x, line.y)" : "line.y") : "0.0"};
      float fade = 1.0 - smoothstep(0.2, 0.8, max(fw.x, fw.y));
      diffuseColor.rgb *= 1.0 - mortar * fade * 0.22;
    `,
    );
  };
  material.customProgramCacheKey = () => `streetrove-building-${finish}-v1`;
  return material;
}

export function createBuildingVisual(
  building: BuildingPlan,
  colorful = false,
  manualPanels: {
    x: number;
    z: number;
    kind: string;
    width: number;
    height: number;
    sill: number;
  }[] = [],
): THREE.Group | undefined {
  if ((building.rings[0]?.length ?? 0) < 4) return undefined;
  const { positions, planes, appearance } = roofSurface(building);
  if (colorful && !building.appearanceTags?.["building:colour"]) {
    appearance.wallColor = `#${new THREE.Color().setHSL((seedOf(building.sourceId) % 360) / 360, 0.38, 0.62).getHexString()}`;
  }
  const group = new THREE.Group();
  group.position.y = building.baseHeight + 0.02;
  const wallPositions: number[] = [],
    wallUvs: number[] = [],
    details: number[] = [],
    colors: number[] = [];
  const roofAt = (p: Point) =>
    appearance.eaves +
    Math.max(0, Math.min(...planes.map((plane) => value(plane, p))));
  building.rings.forEach((ring, ringIndex) => {
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i]!,
        b = ring[i + 1]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.05) continue;
      const cuts = [0, 1];
      planes.forEach((p, pi) =>
        planes.slice(pi + 1).forEach((q) => {
          const da = value(p, a) - value(q, a),
            db = value(p, b) - value(q, b);
          const t = da / (da - db);
          if (t > 0 && t < 1) cuts.push(t);
        }),
      );
      cuts.sort((x, y) => x - y);
      const pointAt = (t: number) => ({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
      });
      for (let c = 0; c + 1 < cuts.length; c++) {
        const ta = cuts[c]!,
          tb = cuts[c + 1]!,
          pa = pointAt(ta),
          pb = pointAt(tb);
        for (const [point, y, u] of [
          [pa, 0, ta],
          [pb, 0, tb],
          [pb, roofAt(pb), tb],
          [pa, 0, ta],
          [pb, roofAt(pb), tb],
          [pa, roofAt(pa), ta],
        ] as const) {
          wallPositions.push(point.x, y, point.z);
          wallUvs.push(u * length, y);
        }
      }
      if (ringIndex !== 0 || length < 2.5) continue;
      // Thin, double-sided facade panels; merged into one nearby-only detail mesh.
      const quad = (
        center: number,
        y: number,
        width: number,
        height: number,
        color: string,
        offset: number,
      ) => {
        const col = new THREE.Color(color);
        for (const side of [-1, 1])
          for (const [u, v] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, -1],
            [1, 1],
            [-1, 1],
          ]) {
            const t = (center + (u! * width) / 2) / length;
            const p = pointAt(t);
            details.push(
              p.x - ((b.z - a.z) / length) * offset * side,
              y + (v! * height) / 2,
              p.z + ((b.x - a.x) / length) * offset * side,
            );
            colors.push(col.r, col.g, col.b);
          }
      };
      const floors = Math.max(
        1,
        Math.min(8, Math.floor(appearance.eaves / 2.8)),
      );
      const bays = Math.max(1, Math.min(20, Math.floor(length / 3)));
      for (let floor = 0; floor < floors; floor++)
        for (let bay = 0; bay < bays; bay++) {
          const center = (length * (bay + 0.5)) / bays;
          const door =
            floor === 0 &&
            i === 0 &&
            bay === 0 &&
            appearance.residential &&
            !manualPanels.some((panel) => panel.kind === "front-door");
          const garage =
            floor === 0 &&
            i === 0 &&
            bay === bays - 1 &&
            bays >= 3 &&
            appearance.residential &&
            !manualPanels.some((panel) => panel.kind === "garage");
          const width = garage ? 2.4 : door ? 0.95 : 1.25;
          const height = door || garage ? 2.15 : 1.3;
          const y =
            door || garage
              ? height / 2
              : floor * (appearance.eaves / floors) + 1.8;
          if (y + height / 2 > appearance.eaves - 0.15) continue;
          if (
            manualPanels.some((panel) => {
              const along =
                ((panel.x - a.x) * (b.x - a.x) +
                  (panel.z - a.z) * (b.z - a.z)) /
                length;
              const across =
                Math.abs(
                  (panel.x - a.x) * (b.z - a.z) - (panel.z - a.z) * (b.x - a.x),
                ) / length;
              return (
                across < 0.2 &&
                Math.abs(along - center) < (panel.width + width) / 2 + 0.15 &&
                y + height / 2 > panel.sill &&
                y - height / 2 < panel.sill + panel.height
              );
            })
          )
            continue;
          quad(center, y, width + 0.18, height + 0.18, "#e5ddd0", 0.035);
          quad(
            center,
            y,
            width,
            height,
            garage ? "#a7a69d" : door ? "#57483e" : "#426475",
            0.05,
          );
          if (!door && !garage) {
            quad(center, y, 0.045, height, "#e5ddd0", 0.06);
            quad(center, y, width, 0.045, "#e5ddd0", 0.06);
          }
        }
    }
  });
  const geometry = (vertices: number[], uv?: number[]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    if (uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return geo;
  };
  const wall = new THREE.Mesh(
    geometry(wallPositions, wallUvs),
    surfaceMaterial(appearance.wallColor, appearance.finish),
  );
  const roofUvs = positions.flatMap((_, i) =>
    i % 3 === 0 ? [positions[i]!, positions[i + 2]!] : [],
  );
  const roof = new THREE.Mesh(
    geometry(positions, roofUvs),
    surfaceMaterial(appearance.roofColor, "shingles"),
  );
  group.add(wall, roof);
  const detailGeometry = geometry(details);
  detailGeometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(colors, 3),
  );
  const detail = new THREE.Mesh(
    detailGeometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  const lod = new THREE.LOD();
  const center = new THREE.Box3()
    .setFromBufferAttribute(
      wall.geometry.getAttribute("position") as THREE.BufferAttribute,
    )
    .getCenter(new THREE.Vector3());
  lod.position.copy(center);
  detail.position.copy(center).negate();
  lod.addLevel(detail, 0);
  lod.addLevel(new THREE.Group(), 160);
  group.add(lod);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = object.receiveShadow = true;
    object.userData = {
      sourceId: building.sourceId,
      featureKind: "building",
      heightSource: building.heightSource,
      appearanceEstimated: appearance.estimated,
    };
  });
  return group;
}
