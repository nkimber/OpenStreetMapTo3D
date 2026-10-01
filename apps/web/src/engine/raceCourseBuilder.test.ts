import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RaceCourseBuilderClient,
  type RaceCourseBuildRequest,
  type RaceCourseWorkerMessage,
} from "./raceCourseBuilder.js";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  reply(message: RaceCourseWorkerMessage) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

const request: RaceCourseBuildRequest = {
  roads: [],
  start: { x: 0, z: 0 },
  heading: { x: 1, z: 0 },
  options: { targetLength: 1_000 },
};

beforeEach(() => {
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("race course worker lifecycle", () => {
  it("waits for readiness, sends one job and releases the worker on completion", async () => {
    const client = new RaceCourseBuilderClient();
    const result = client.build(request);
    const worker = TestWorker.instances[0]!;
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.reply({ type: "ready" });
    worker.reply({ type: "ready" });
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(request);
    worker.reply({ type: "complete", courses: [] });
    await expect(result).resolves.toEqual([]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a running job and ignores its late result", async () => {
    const client = new RaceCourseBuilderClient();
    const first = expect(client.build(request)).rejects.toMatchObject({
      name: "AbortError",
    });
    const oldWorker = TestWorker.instances[0]!;
    oldWorker.reply({ type: "ready" });
    const second = client.build({
      ...request,
      options: { targetLength: 5_000 },
    });
    await first;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    oldWorker.reply({ type: "complete", courses: [] });
    const worker = TestWorker.instances[1]!;
    worker.reply({ type: "ready" });
    expect(worker.postMessage.mock.calls[0]?.[0].options.targetLength).toBe(
      5_000,
    );
    worker.reply({ type: "complete", courses: [] });
    await expect(second).resolves.toEqual([]);
  });

  it("can cancel before the worker module has loaded and start again", async () => {
    const client = new RaceCourseBuilderClient();
    const pending = expect(client.build(request)).rejects.toMatchObject({
      name: "AbortError",
    });
    const worker = TestWorker.instances[0]!;
    client.cancel();
    await pending;
    worker.reply({ type: "ready" });
    expect(worker.postMessage).not.toHaveBeenCalled();
    const retry = client.build(request);
    TestWorker.instances[1]!.reply({ type: "complete", courses: [] });
    await expect(retry).resolves.toEqual([]);
  });

  it("reports generation failures and releases the worker", async () => {
    const client = new RaceCourseBuilderClient();
    const pending = expect(client.build(request)).rejects.toThrow(
      "No road data",
    );
    TestWorker.instances[0]!.reply({ type: "failed", message: "No road data" });
    await pending;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it.each(["error", "messageerror"])(
    "reports a worker %s instead of leaving setup pending",
    async (type) => {
      const client = new RaceCourseBuilderClient();
      const pending = expect(client.build(request)).rejects.toThrow();
      TestWorker.instances[0]!.dispatchEvent(new Event(type));
      await pending;
      expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    },
  );

  it("times out a stuck worker and permits a retry", async () => {
    const client = new RaceCourseBuilderClient();
    const pending = expect(client.build(request)).rejects.toThrow(
      "took too long",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    const retry = client.build(request);
    TestWorker.instances[1]!.reply({ type: "complete", courses: [] });
    await expect(retry).resolves.toEqual([]);
  });
});
