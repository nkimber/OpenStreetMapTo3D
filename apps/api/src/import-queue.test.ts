import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { DatabasePool } from "./database.js";
import { processQueuedImports } from "./import-queue.js";
import { createImportJob, executeImportJob } from "./imports.js";

vi.mock("./imports.js", () => ({
  createImportJob: vi.fn(),
  executeImportJob: vi.fn(),
  getImportJob: vi.fn(),
}));

const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const input = {
  provider: "fixture",
  queryVersion: 1,
  bounds: { west: -75.2, south: 39.9, east: -75.199, north: 39.901 },
};
const pool = {} as DatabasePool;
afterEach(() => vi.clearAllMocks());

describe("deployment import queue", () => {
  it("returns a durable queued job without executing it in the web process", async () => {
    vi.mocked(createImportJob).mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      status: "queued",
      progress: 0,
      stage: "queued",
      diagnostics: [],
    });
    const app = await buildApp({
      config: { ...config, IMPORT_EXECUTION_MODE: "worker" },
      pool,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        payload: input,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(response.statusCode).toBe(202);
      expect(response.json().status).toBe("queued");
      expect(executeImportJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("finishes one import before claiming another and drains on shutdown", async () => {
    const stop = new AbortController();
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "first", input }] })
      .mockResolvedValueOnce({ rows: [{ id: "second", input }] });
    vi.mocked(executeImportJob)
      .mockImplementationOnce(() => firstFinished)
      .mockImplementationOnce(async () => {
        stop.abort();
      });
    const running = processQueuedImports(
      { query } as unknown as PoolClient,
      pool,
      config,
      stop.signal,
    );
    await vi.waitFor(() => expect(executeImportJob).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledTimes(1);
    finishFirst();
    await running;
    expect(executeImportJob).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(executeImportJob).mock.calls.map((call) => call[2]),
    ).toEqual(["first", "second"]);
  });

  it("quarantines invalid persisted jobs and continues to the next valid job", async () => {
    const stop = new AbortController();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "invalid", input: {} }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "valid", input }] });
    vi.mocked(executeImportJob).mockImplementationOnce(async () => {
      stop.abort();
    });
    await processQueuedImports(
      { query } as unknown as PoolClient,
      pool,
      config,
      stop.signal,
    );
    expect(executeImportJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeImportJob).mock.calls[0]?.[2]).toBe("valid");
    expect(query.mock.calls[1]?.[1]).toEqual(["invalid"]);
  });
});
