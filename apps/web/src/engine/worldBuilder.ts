import type {
  WorldBuildProgress,
  WorldBuildRequest,
  WorldDefinition,
} from "@osm3d/contracts";
import type { WorldPlan } from "@osm3d/worldgen";

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

type WorkerMessage = WorldBuildProgress | CompleteMessage | FailedMessage;

export interface WorldBuildResult {
  plan: WorldPlan;
  durationMs: number;
}

export class WorldBuilderClient {
  private worker: Worker | undefined;
  private cancelActive: (() => void) | undefined;

  async build(
    definition: WorldDefinition,
    onProgress: (progress: WorldBuildProgress) => void,
    signal?: AbortSignal,
  ): Promise<WorldBuildResult> {
    this.cancel();
    const jobId = crypto.randomUUID();
    const worker = new Worker(
      new URL("../workers/worldBuilder.worker.ts", import.meta.url),
      { type: "module", name: "osm3d-world-builder" },
    );
    this.worker = worker;

    return new Promise<WorldBuildResult>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        if (this.cancelActive === abort) this.cancelActive = undefined;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        reject(
          new DOMException("World generation was cancelled.", "AbortError"),
        );
      };
      this.cancelActive = abort;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      worker.addEventListener(
        "message",
        (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.jobId !== jobId) return;
          if (message.type === "progress") {
            onProgress(message);
            return;
          }
          if (!finish()) return;
          if (message.type === "complete") {
            onProgress({
              version: 1,
              jobId,
              type: "progress",
              stage: "complete",
              progress: 100,
            });
            resolve({ plan: message.plan, durationMs: message.durationMs });
          } else reject(new Error(message.message));
        },
      );
      worker.addEventListener("error", (event) => {
        if (!finish()) return;
        reject(
          new Error(event.message || "The world-generation worker failed."),
        );
      });
      worker.postMessage({
        version: 1,
        jobId,
        definition,
        chunkSize: 256,
      } satisfies WorldBuildRequest);
    });
  }

  cancel(): void {
    this.cancelActive?.();
  }

  dispose(): void {
    this.cancel();
  }
}
