/// <reference lib="webworker" />

import {
  WorldBuildRequestSchema,
  type WorldBuildProgress,
} from "@osm3d/contracts";
import {
  buildWorldPlan,
  WORLD_GENERATOR_VERSION,
  type WorldPlan,
} from "@osm3d/worldgen";

interface CompleteMessage {
  version: 1;
  jobId: string;
  type: "complete";
  plan: WorldPlan;
  durationMs: number;
}

interface FailedMessage {
  version: 1;
  jobId: string;
  type: "failed";
  message: string;
}

const worker = self as unknown as DedicatedWorkerGlobalScope;

function progress(
  jobId: string,
  stage: WorldBuildProgress["stage"],
  value: number,
): void {
  worker.postMessage({
    version: 1,
    jobId,
    type: "progress",
    stage,
    progress: value,
  } satisfies WorldBuildProgress);
}

worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  let jobId = "unknown";
  try {
    const request = WorldBuildRequestSchema.parse(event.data);
    jobId = request.jobId;
    const startedAt = performance.now();
    progress(jobId, "queued", 5);
    progress(jobId, "normalizing", 20);
    const plan = buildWorldPlan(
      request.definition.features,
      request.definition.world.anchor,
      request.definition.world.settings,
      request.definition.overrides,
      {
        chunkSize: request.chunkSize,
        sourceSnapshotId: request.definition.world.snapshotId,
        generatorVersion: WORLD_GENERATOR_VERSION,
        bounds: request.definition.world.bounds,
        ...(request.definition.elevation
          ? { elevation: request.definition.elevation }
          : {}),
      },
    );
    progress(jobId, "roads", 72);
    progress(jobId, "chunking", 92);
    worker.postMessage({
      version: 1,
      jobId,
      type: "complete",
      plan,
      durationMs: performance.now() - startedAt,
    } satisfies CompleteMessage);
  } catch (error) {
    worker.postMessage({
      version: 1,
      jobId,
      type: "failed",
      message:
        error instanceof Error ? error.message : "World generation failed.",
    } satisfies FailedMessage);
  }
});

export {};
