# Incremental repository cache and disposable task snapshots

## Context

A full source download before every request can spend the entire task budget on a slow network,
blocking all later QQ messages on a single-worker deployment. The operator explicitly allows a local
repository cache while keeping messages and model history ephemeral.

## Decision

An optional host-owned shallow bare Git repository holds source objects. Resolve the default branch
through GitHub for each request, fetch its exact commit if absent, and export a separate archive into
each task workspace. Never run pull/merge or repository hooks in the model workspace. Bound fetches
separately (120 seconds by default) and fail explicitly if fresh source is unavailable. Serialize cache
operations within the service. One process owns the cache root; cross-process sharing is unsupported.

Supply scoped GitHub authentication through process environment, not URLs or persistent Git config.
The worker receives neither credentials nor Git metadata. Preserve the existing extraction bounds
and exclusion of symlinks, `.git`, `.env`, runtime files and node_modules.

Dispose snapshots on all terminal paths. A periodic cleanup also removes orphaned task/worker
directories older than two hours, excluding active snapshots. The persistent cache is only a source
optimization and can be discarded without losing user feedback or assets.

## Consequences

Unchanged source requires only small metadata API requests. New commits reuse existing Git objects.
The initial clone can be pre-seeded by an operator from a verified repository; the service still checks
the live commit and never accepts a stale snapshot as current. Persistent caching is explicitly enabled
per deployment. The existing archive mode remains available when persistence is undesirable.

## Validation

Local Git integration tests cover initial fetch, update, concurrent snapshots, unchanged source in a
new process with the origin unavailable, credential-free cache config, cancellation and orphan cleanup.
Service tests preserve publication and authentication boundaries. Deployment acceptance includes a real
QQ request and compares source preparation time against the previous full-download behavior.
