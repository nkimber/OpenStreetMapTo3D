// Run inside the API container; only the deterministic fixture is used.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:3000/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
assert.equal((await request("/ready")).database, "connected");
const bounds = { west: -75.17, south: 39.95, east: -75.165, north: 39.955 };
let job = await request("/imports", {
  provider: "fixture",
  queryVersion: 1,
  bounds,
});
const deadline = Date.now() + 90_000;
while (!["complete", "failed", "cancelled"].includes(job.status)) {
  assert(Date.now() < deadline, "Sample import did not finish in 90 seconds");
  await delay(1_000);
  job = await request(`/imports/${job.id}`);
}
assert.equal(job.status, "complete", job.errorMessage);
assert(job.snapshotId);
const preview = await request(`/snapshots/${job.snapshotId}/preview`);
assert(preview.features.length > 0, "Sample map has no features");
const world = await request("/worlds", {
  name: `Deployment check ${new Date().toISOString()}`,
  snapshotId: job.snapshotId,
  bounds,
  anchor: { longitude: -75.1675, latitude: 39.9525, height: 0 },
  settings: {
    buildingLevelHeight: 3,
    defaultBuildingHeight: 8,
    includeMinorPaths: true,
    buildingCollisions: true,
    seed: 1,
    visualStyle: "clean",
  },
});
const reopened = await request(`/worlds/${world.id}/definition`);
assert.equal(reopened.world.id, world.id);
console.log(
  "Database, queued sample import, snapshot persistence and world reload passed.",
);
