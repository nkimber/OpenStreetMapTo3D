import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  GeocodeRequestSchema,
  ImportRequestSchema,
  WorldCreateRequestSchema,
  WorldOverrideSchema,
} from "@osm3d/contracts";
import { boundsAreaSquareKm } from "@osm3d/geo";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { DatabasePool } from "./database.js";
import { createImportJob, executeImportJob, getImportJob } from "./imports.js";
import { geocode } from "./providers.js";
import {
  createWorld,
  getSnapshotPreview,
  getWorldDefinition,
  listWorlds,
  replaceOverrides,
} from "./worlds.js";

export interface AppDependencies {
  config: AppConfig;
  pool: DatabasePool;
}

const UuidParamSchema = z.object({ id: z.uuid() });

export async function buildApp({
  config,
  pool,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true } } }
        : {}),
    },
    bodyLimit: 1_000_000,
    requestTimeout: 30_000,
  });

  await app.register(cors, {
    origin: config.NODE_ENV === "production" ? config.PUBLIC_APP_URL : true,
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready", database: "connected" };
    } catch {
      return reply
        .code(503)
        .send({ status: "not-ready", database: "unavailable" });
    }
  });

  app.post("/api/geocode", async (request) => {
    const body = GeocodeRequestSchema.parse(request.body);
    return { results: await geocode(body.query, config) };
  });

  app.post("/api/imports", async (request, reply) => {
    const body = ImportRequestSchema.parse(request.body);
    const area = boundsAreaSquareKm(body.bounds);
    if (area > config.MAX_IMPORT_AREA_SQUARE_KM) {
      return reply.code(413).send({
        error: {
          code: "IMPORT_AREA_TOO_LARGE",
          message: `The selected area is ${area.toFixed(2)} km²; the configured maximum is ${config.MAX_IMPORT_AREA_SQUARE_KM} km².`,
        },
      });
    }
    const job = await createImportJob(pool, body);
    if (job.status === "queued" && config.IMPORT_EXECUTION_MODE === "inline") {
      setImmediate(() => {
        void executeImportJob(pool, config, job.id, body);
      });
    }
    return reply.code(job.status === "complete" ? 200 : 202).send(job);
  });

  app.get("/api/imports/:id", async (request, reply) => {
    const { id } = UuidParamSchema.parse(request.params);
    const job = await getImportJob(pool, id);
    return (
      job ??
      reply.code(404).send({
        error: { code: "IMPORT_NOT_FOUND", message: "Import job not found." },
      })
    );
  });

  app.get("/api/imports/:id/events", async (request, reply) => {
    const { id } = UuidParamSchema.parse(request.params);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    let lastPayload = "";
    const emit = async (): Promise<boolean> => {
      const job = await getImportJob(pool, id);
      if (!job) {
        reply.raw.write(
          `event: failed\ndata: ${JSON.stringify({ code: "IMPORT_NOT_FOUND" })}\n\n`,
        );
        reply.raw.end();
        return true;
      }
      const payload = JSON.stringify(job);
      if (payload !== lastPayload) {
        reply.raw.write(`event: status\ndata: ${payload}\n\n`);
        lastPayload = payload;
      }
      if (["complete", "failed", "cancelled"].includes(job.status)) {
        reply.raw.end();
        return true;
      }
      return false;
    };
    if (await emit()) return;
    const interval = setInterval(
      () => void emit().then((finished) => finished && clearInterval(interval)),
      2_000,
    );
    request.raw.on("close", () => clearInterval(interval));
  });

  app.get("/api/snapshots/:id/preview", async (request, reply) => {
    const { id } = UuidParamSchema.parse(request.params);
    const preview = await getSnapshotPreview(pool, id);
    return (
      preview ??
      reply.code(404).send({
        error: {
          code: "SNAPSHOT_NOT_FOUND",
          message: "Source snapshot not found.",
        },
      })
    );
  });

  app.post("/api/worlds", async (request, reply) => {
    const body = WorldCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await createWorld(pool, body));
  });

  app.get("/api/worlds", async () => ({ worlds: await listWorlds(pool) }));

  app.get("/api/worlds/:id/definition", async (request, reply) => {
    const { id } = UuidParamSchema.parse(request.params);
    const definition = await getWorldDefinition(pool, id);
    return (
      definition ??
      reply.code(404).send({
        error: { code: "WORLD_NOT_FOUND", message: "World not found." },
      })
    );
  });

  app.put("/api/worlds/:id/overrides", async (request, reply) => {
    const { id } = UuidParamSchema.parse(request.params);
    const body = z
      .object({ overrides: z.array(WorldOverrideSchema).max(20_000) })
      .parse(request.body);
    const definition = await getWorldDefinition(pool, id);
    if (!definition)
      return reply.code(404).send({
        error: { code: "WORLD_NOT_FOUND", message: "World not found." },
      });
    return { overrides: await replaceOverrides(pool, id, body.overrides) };
  });

  if (config.NODE_ENV === "production") {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const publicDirectory = resolve(currentDirectory, "../public");
    await app.register(fastifyStatic, { root: publicDirectory });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "Route not found." } });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request was not valid.",
          details: error.issues,
        },
      });
    }
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message:
          config.NODE_ENV === "production"
            ? "An unexpected error occurred."
            : error instanceof Error
              ? error.message
              : "An unknown error occurred.",
      },
    });
  });

  return app;
}
