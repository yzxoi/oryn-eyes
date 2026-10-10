# Recover from a slow Git source connection

QQ and AstrBot remained connected, but feedback failed before inference when GitHub Git transfers
fell below the low-speed threshold for 20 seconds. Cache mode bypassed the configured public archive
mirror and had no alternate source transport. Increasing the model budget could not fix that failure.

Keep the exact-commit Git cache as the primary path. If cache preparation fails, download an archive
of the same SHA already resolved from the official GitHub API. Reuse the existing archive downloader:
only a repository verified public may use the operator-configured mirror, and GitHub credentials are
not sent to the mirror. Private repositories use the official API. Do not fall back after cancellation.

The fallback has its own source-fetch timeout and remains within the original task's abort signal.
Extraction limits and cleanup apply to both paths. A structured source_cache_fallback event records
the failed transport without exposing credentials. No older commit is selected and no archive is
written into the Git object cache. Repeated fallback requests can reuse the existing short-lived,
in-memory archive cache. Missing GitHub search evidence continues to block publication independently.
