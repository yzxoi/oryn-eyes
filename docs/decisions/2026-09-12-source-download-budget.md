# Source preparation follows the task budget

## Context

On the deployment Pi, QQ acknowledgements and progress worked, but source preparation failed before the model ran: an independent 120-second download timeout expired at roughly 50 KB/s. The task already has a 900-second overall budget and a cancellation controller. Extending an unrelated timer would still leave stopped requests waiting for a shared download.

## Decision

Pass the task signal through preparation, shared archive waits, and extraction. Each archive download owns a controller; one cancelled consumer cannot interrupt another, and the final consumer aborts the upstream transfer. Begin the five-minute in-memory cache lifetime after completion. Preserve archive/extraction size limits and the extraction time limit.

Allow an explicitly configured HTTPS archive mirror only after official metadata confirms a public repository. Resolve the exact commit through the official API and never attach GitHub credentials to mirror requests. API reads, writes and asset publication retain official endpoints. Mirror trust is explicit; commit-addressed URLs alone do not verify bytes. There is no persistent source cache.

Pi measurement: a 13,738,032-byte archive downloaded through ghfast.top in 5.42 seconds (~2.53 MB/s). Its SHA-256 matched the same archive downloaded directly from GitHub. This is a deployment observation, not a guarantee of future mirror correctness or availability.

## Validation

Behavioral tests cover shared-consumer cancellation, last-consumer upstream abort and retry, child termination, public-only mirror routing and credential isolation. Full checks include existing image, queue, publication and plugin tests. Live deployment acceptance checks source preparation, actual GLM image/source QA, and the QQ response path.
