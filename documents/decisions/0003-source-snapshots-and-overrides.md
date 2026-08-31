# ADR-0003: Immutable source snapshots and overrides

Status: Accepted

Date: 2026-08-30

## Context

OpenStreetMap changes continuously, while users need saved worlds to remain
reproducible. Users also need to correct missing heights, road widths, hidden
features, and spawn positions without losing the ability to identify what came
from OSM.

Mutating imported source rows directly would erase provenance and make refreshes
or debugging difficult. Persisting only generated geometry would make worlds
dependent on disposable binary artifacts.

## Decision

Treat each successful provider response as an immutable source snapshot with a
content hash, retrieval metadata, license, and attribution. Store user edits as
versioned overrides that reference stable source IDs or generated object IDs.

A world build is a deterministic function of:

```text
source snapshot + settings + overrides + generator version
```

Generated geometry is a cache and may be deleted and rebuilt.

## Consequences

Positive:

- Saved worlds are reproducible.
- Source facts remain distinguishable from estimates and user changes.
- New OSM snapshots can be compared without overwriting old projects.
- User edits can be reapplied or flagged during refresh.
- Large generated artifacts do not become the only authoritative record.

Negative:

- Refresh requires a merge and conflict workflow.
- Override payloads need schema versions and migrations.
- Snapshot retention consumes storage and needs explicit cleanup policy.

## Revisit when

- Snapshot storage becomes operationally significant.
- Projects require collaborative, concurrent editing.
- Stable OSM identities prove insufficient for a class of refresh operations.
