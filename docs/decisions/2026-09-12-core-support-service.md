# Replace RCM support execution with ephemeral Synergy Core

Status: implemented

The existing Chaos installation already connects QQ through NapCat and AstrBot to a local RCM process. It handles QA, issue search and direct filing, but passes only text, parses a terminal response panel, and maintains archives and long-term memory. Its responsibilities do not require a full Synergy product deployment.

We retain the QQ transport and replace RCM with the same pinned four-package Core closure used by Oryn Mini. Each request gets a separate worker home and source snapshot, disposed after completion. Current/quoted images are normalized and sent as model-facing attachments. Thirty-minute in-memory conversation context handles follow-ups without a knowledge subsystem.

Core gets read/search/image tools and a narrowly allowed webfetch gateway for GitHub evidence. The host alone holds GitHub credentials and publishes typed results. The gateway fixes repository scope, supports only reads, and returns no redirects. The `webfetch*` permission pattern uses the Core configuration's general pattern-rule contract because the fixed `webfetch` key only accepts a flat action in the pinned version.

The result schema separates a user's report, source-supported facts, hypotheses, and unknowns. Fact path/line/quote validation guards against fabricated citations. No runtime reproduction is claimed. Direct creation follows the user's explicit policy; there is no confirmation-draft workflow. A successful GitHub search is required before creation.

Provider output is schema-validated, including when one valid JSON object is wrapped in prose. Multiple conflicting valid objects are rejected. Format correction is bounded by the same task deadline, and its failure reason is logged without the model output. Same-sender tasks are serialized; other senders can run concurrently. Brief status-poll failures are retried without resubmitting the task.

Deployment probes showed redundant source downloads dominating some short QA tasks. The GitHub client therefore shares one in-memory archive promise per immutable commit for five minutes, while still resolving the current branch and extracting an isolated workspace for every request. Live publication verification uses generated images and a labelled, immediately closed Issue protected by the existing Oryn hold label.

Screenshot publication uses a content-addressed file on a dedicated repository branch. Screenshots are not stored in a local long-term archive. Stable public assets belong to the GitHub feedback record. No raw QQ identities are included in public records.

Delivery uses an authenticated local API, non-destructive status polling, bounded queues, sender-scoped cancellation and ephemeral deduplication. The Issue marker allows recovery of ambiguous writes from recent Issues; exactly-once messaging across arbitrary outages is outside this design. No blind retry of a write is allowed.

Live GitHub verification demonstrated that an immediately created Issue can be absent from a subsequent list response. Successful publication results and concurrent publication promises therefore stay in memory for 30 minutes. An ambiguous write is fenced from another POST until its marker is recovered; read-side lag must not turn a retry into a duplicate. Regression tests simulate both stale lists and lost write responses.

Validation: behavioral tests cover message/image validation, sender context isolation, cancellation, publication recovery and source citation validation. Real Core smoke checks provider-bound image bytes, file and gateway tools, and interleaved reasoning. Live provider and deployed service probes are documented in delivery evidence rather than committed raw logs.
