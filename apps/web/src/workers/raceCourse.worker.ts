/// <reference lib="webworker" />

import { generateRaceCourseCandidates } from "@osm3d/simulation";
import type {
  RaceCourseBuildRequest,
  RaceCourseWorkerMessage,
} from "../engine/raceCourseBuilder.js";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const reply = (message: RaceCourseWorkerMessage) => worker.postMessage(message);
worker.addEventListener(
  "message",
  (event: MessageEvent<RaceCourseBuildRequest>) => {
    try {
      const { roads, start, heading, options } = event.data;
      reply({
        type: "complete",
        courses: generateRaceCourseCandidates(roads, start, heading, options),
      });
    } catch (reason) {
      reply({
        type: "failed",
        message:
          reason instanceof Error
            ? reason.message
            : "Race course generation failed.",
      });
    }
  },
);
// Wait for the module and its listener before the client posts a request.
reply({ type: "ready" });

export {};
