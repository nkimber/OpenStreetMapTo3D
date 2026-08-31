# ADR-0001: TypeScript modular monolith

Status: Accepted

Date: 2026-08-30

## Context

The project needs a browser editor and simulation, a server-side OSM data proxy,
shared geographic contracts, persistence, and Docker-based local development.
Early development will be performed by a small number of contributors, and the
primary deployment is a single-user local installation.

Splitting the system into independently deployed microservices would introduce
network contracts, orchestration, observability, and deployment work before the
core world-generation and driving risks are understood.

## Decision

Use TypeScript across the web application, API, and shared packages. Implement
one modular API application and one browser application in a pnpm workspace.
Run web, API, and PostGIS as separate development containers because they have
different runtime concerns, but treat the codebase as a modular monolith.

The API's import job runner begins in-process behind an interface that can later
move to a worker container.

## Consequences

Positive:

- Shared schemas and types reduce contract drift.
- Contributors need fewer languages and toolchains.
- Docker Compose remains understandable.
- Domain packages can be tested without HTTP or UI composition.
- Deployment can produce one application image plus PostGIS.

Negative:

- CPU-heavy API work could affect request latency.
- Process-level scaling is coarse.
- Care is required to prevent application-layer imports from contaminating
  reusable packages.

## Revisit when

- Import jobs routinely block or exhaust the API process.
- Multiple users require independent workload scaling.
- A local `.osm.pbf` import pipeline needs a distinct runtime or toolchain.
