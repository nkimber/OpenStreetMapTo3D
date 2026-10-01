import type {
  GenerateRaceCourseCandidatesOptions,
  RaceCourse,
  RacePoint,
  RaceRoad,
} from "@osm3d/simulation";

export interface RaceCourseBuildRequest {
  roads: RaceRoad[];
  start: Pick<RacePoint, "x" | "z">;
  heading: Pick<RacePoint, "x" | "z">;
  options: GenerateRaceCourseCandidatesOptions;
}

export type RaceCourseWorkerMessage =
  | { type: "ready" }
  | { type: "complete"; courses: RaceCourse[] }
  | { type: "failed"; message: string };

/** Each job owns its worker so cancellation can interrupt synchronous search. */
export class RaceCourseBuilderClient {
  private cancelActive: (() => void) | undefined;

  async build(request: RaceCourseBuildRequest): Promise<RaceCourse[]> {
    this.cancel();
    const worker = new Worker(
      new URL("../workers/raceCourse.worker.ts", import.meta.url),
      { type: "module", name: "osm3d-race-courses" },
    );
    return new Promise<RaceCourse[]>((resolve, reject) => {
      let settled = false;
      let sent = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        if (this.cancelActive === abort) this.cancelActive = undefined;
        return true;
      };
      const fail = (reason: Error) => {
        if (finish()) reject(reason);
      };
      const abort = () =>
        fail(new DOMException("Route generation was cancelled.", "AbortError"));
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              "Route generation took too long. Try another road or regenerate routes.",
            ),
          ),
        30_000,
      );
      this.cancelActive = abort;
      worker.addEventListener(
        "message",
        (event: MessageEvent<RaceCourseWorkerMessage>) => {
          if (settled) return;
          const message = event.data;
          if (message.type === "ready") {
            if (sent) return;
            sent = true;
            try {
              worker.postMessage(request);
            } catch (reason) {
              fail(
                reason instanceof Error
                  ? reason
                  : new Error(
                      "The roads could not be sent for route generation.",
                    ),
              );
            }
          } else if (message.type === "complete") {
            if (finish()) resolve(message.courses);
          } else fail(new Error(message.message));
        },
      );
      worker.addEventListener("error", (event) =>
        fail(new Error(event.message || "The race-course worker failed.")),
      );
      worker.addEventListener("messageerror", () =>
        fail(new Error("The generated race courses could not be read.")),
      );
    });
  }

  cancel(): void {
    this.cancelActive?.();
  }
}
