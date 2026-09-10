# StreetRove documentation

Status: Active

Last updated: 2026-09-10

**Your neighborhood. Your world. Your drive.**

This directory contains the product intent, implemented architecture, and
future roadmap for StreetRove. Start with the
[implementation status](implementation-status.md) to distinguish the working
MVP from later roadmap items.

## Product and experience

- [Product vision](product-vision.md) defines the problem, goals, non-goals,
  users, and MVP success criteria.
- [User workflow](user-workflow.md) describes the complete experience from
  location search through driving and saving a world.
- [Delivery roadmap](delivery-roadmap.md) breaks implementation into phases
  with explicit exit criteria.
- [Implementation status](implementation-status.md) maps the current build to
  those phases and records known limitations.

## Engineering

- [Technical architecture](technical-architecture.md) describes containers,
  runtime boundaries, packages, and system-level invariants.
- [OpenStreetMap data pipeline](openstreetmap-data-pipeline.md) covers
  geocoding, Overpass queries, source snapshots, normalization, and updates.
- [World generation and physics](world-generation-and-physics.md) defines
  coordinate conversion, geometry generation, rendering, and vehicle physics.
- [API and persistence](api-and-persistence.md) defines the initial HTTP API,
  jobs, project records, source data, and override model.
- [Docker development](docker-development.md) defines the intended local and
  production container workflows.
- [OVHcloud pilot deployment](../deploy/README.md) covers VPS-2, the password
  gate, the persistent import worker, backups and release verification.
- [Testing strategy](testing-strategy.md) defines automated validation,
  deterministic fixtures, browser tests, and performance gates.
- [Performance budget](performance-budget.md) records the reference machine,
  measurable generation and driving budgets, and the current sample baseline.
- [Security, privacy, and licensing](security-privacy-and-licensing.md) records
  the operating constraints for location data, external services, secrets,
  OpenStreetMap attribution, and open-source dependencies.
- [Glossary](glossary.md) defines project-specific terms.

## Architecture decisions

- [ADR-0001: TypeScript modular monolith](decisions/0001-typescript-modular-monolith.md)
- [ADR-0002: Local ENU world coordinates](decisions/0002-local-enu-coordinates.md)
- [ADR-0003: Immutable source snapshots and overrides](decisions/0003-source-snapshots-and-overrides.md)
- [ADR-0004: Worker-built deterministic chunks](decisions/0004-worker-built-deterministic-chunks.md)
- [ADR-0005: Immutable elevation snapshots and shared heightfields](decisions/0005-immutable-elevation-snapshots-and-shared-heightfields.md)

## Documentation conventions

- Statements using **must** are architectural requirements.
- Statements using **should** are strong defaults that may change through an
  architecture decision record.
- Proposed numerical limits are starting values and should be calibrated with
  recorded performance fixtures.
- When implementation and documentation disagree, either update the code or
  record the intentional change in an ADR before updating these documents.
