import type { LocalPoint3, RoadPlan } from "./index.js";

interface Segment {
  id: number;
  road: RoadPlan;
  index: number;
  a: LocalPoint3;
  b: LocalPoint3;
  inserts: Array<{ t: number; point: LocalPoint3 }>;
}

/** Repair same-level ground crossings lacking a shared OSM coordinate. */
export function insertGroundCrossings(roads: RoadPlan[]): void {
  const buckets = new Map<string, Segment[]>();
  const segments: Segment[] = [];
  for (const road of roads) {
    if (road.bridge || road.tunnel || road.layer !== 0) continue;
    for (let index = 0; index < road.points.length - 1; index++) {
      const a = road.points[index]!,
        b = road.points[index + 1]!;
      const segment: Segment = {
        id: segments.length,
        road,
        index,
        a,
        b,
        inserts: [],
      };
      segments.push(segment);
      const candidates = new Set<Segment>();
      for (
        let x = Math.floor(Math.min(a.x, b.x) / 32);
        x <= Math.floor(Math.max(a.x, b.x) / 32);
        x++
      ) {
        for (
          let z = Math.floor(Math.min(a.z, b.z) / 32);
          z <= Math.floor(Math.max(a.z, b.z) / 32);
          z++
        ) {
          const key = `${x}:${z}`;
          const bucket = buckets.get(key) ?? [];
          for (const other of bucket)
            if (other.road !== road) candidates.add(other);
          bucket.push(segment);
          buckets.set(key, bucket);
        }
      }
      for (const other of candidates) {
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const ex = other.b.x - other.a.x,
          ez = other.b.z - other.a.z;
        const denominator = dx * ez - dz * ex;
        if (Math.abs(denominator) < 1e-10) continue;
        const cx = other.a.x - a.x,
          cz = other.a.z - a.z;
        const t = (cx * ez - cz * ex) / denominator;
        const u = (cx * dz - cz * dx) / denominator;
        if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) continue;
        const x = a.x + t * dx,
          z = a.z + t * dz;
        segment.inserts.push({ t, point: { x, z, y: a.y + t * (b.y - a.y) } });
        other.inserts.push({
          t: u,
          point: { x, z, y: other.a.y + u * (other.b.y - other.a.y) },
        });
      }
    }
  }
  const byRoad = new Map<RoadPlan, Segment[]>();
  for (const segment of segments) {
    const list = byRoad.get(segment.road) ?? [];
    list.push(segment);
    byRoad.set(segment.road, list);
  }
  for (const [road, list] of byRoad) {
    const points: LocalPoint3[] = [];
    for (const segment of list) {
      const entries = [
        { t: 0, point: segment.a },
        ...segment.inserts,
        { t: 1, point: segment.b },
      ].sort((a, b) => a.t - b.t);
      for (const { point } of entries) {
        const previous = points.at(-1);
        if (
          !previous ||
          Math.hypot(point.x - previous.x, point.z - previous.z) > 1e-6
        )
          points.push(point);
      }
    }
    road.points = points;
  }
}
