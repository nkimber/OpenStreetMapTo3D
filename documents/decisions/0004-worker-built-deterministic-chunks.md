# ADR-0004: Worker-built deterministic chunks

Status: Accepted

Date: 2026-08-31

## Context

World generation originally created isolated road segments and prepared every
mesh on the browser main thread. Any saved override required rebuilding the
entire scene. That approach was sufficient for the first bounded sample but did
not provide cancelable generation, stable build identity, continuous roads, or
responsive editing at neighborhood scale.

## Decision

Geometry planning runs in a dedicated module Web Worker through versioned
request and progress contracts. The generator returns a serializable
`WorldPlan` with a stable build hash, diagnostics, joined road surfaces,
layer-aware junctions, and deterministic 256 m chunks.

Each feature is assigned to one authoritative owner chunk by a stable centroid
rule. Junctions record every contributing source ID, producing a
feature-to-chunk dependency map. An override rebuild invalidates the union of
the feature's old and new chunk dependencies. The main thread replaces only
those Three.js groups and Rapier building bodies.

The main thread remains responsible for GPU object creation, physics objects,
input, and rendering. Cancellation terminates the current Worker rather than
attempting to interrupt synchronous generator code inside it.

## Consequences

- Identical source, anchor, settings, overrides, generator version, and chunk
  size produce the same ordered plan and build hash.
- Editing a contained feature normally replaces one chunk; roads touching
  junctions may intentionally invalidate additional dependent chunks.
- A hidden feature can be restored because the source definition remains
  authoritative and only visibility is overridden.
- Structured cloning copies numeric arrays. Transferable typed arrays or a
  persistent generated-artifact cache may be added if profiling shows the copy
  is material for larger worlds.
- Centroid ownership avoids duplicates but does not yet provide chunk streaming
  for a very long feature. Deterministic fragmentation is a compatible future
  refinement.
