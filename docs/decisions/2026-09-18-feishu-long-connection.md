# Independent Feishu long-connection ingress

## Context

Oryn Eyes must support Feishu as well as QQ and be deployable beyond its original host. Tying Feishu to a running QQ stack adds operational dependencies without improving repository analysis.

## Decision

Use the official pinned Feishu SDK for a separate outbound long-connection process. The existing authenticated Oryn API remains the sole route to Core, repository search and Issue publication. Platform events return immediately; bounded background jobs perform normalization, analysis polling and two replies with a shared diagnostic reference. The model never receives app credentials.

Support private messages, group mentions, text/image/post content and explicit same-chat quotes. Short-term context is bounded by account, user, chat and topic; bot messages do not trigger work. Message resources come from the official API and reuse the QQ image normalization policy. Both processes can run on any supported Linux architecture without AstrBot. Configure a single Feishu ingress per app; in-memory state is intentionally not a distributed queue.

Each outgoing phase uses a stable message UUID. Stop and shutdown cancel admitted Oryn jobs; an in-flight admission retains its returned job ID for cancellation. In-memory deduplication and queues do not guarantee exactly-once delivery across process loss. Credentials and deployment configuration remain external inputs, not memory.

## Verification

Behavioral tests exercise event acknowledgement, deduplication, trigger/allowlist rules, context isolation, image/quote mapping, cancellation, errors and the two-reply invariant. SDK tests exercise the actual dispatcher, API paths and image normalizer without an external app. CI runs the checks and existing Core smoke on native x64 and ARM64. Real app credentials are checked separately from event subscription and end-to-end reply acceptance.

## Sources

- [Official Node SDK](https://github.com/larksuite/node-sdk): authentication, WSClient, three-second acknowledgement and non-broadcast event delivery.
- [Message receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive): event fields and permission scope.
- [Message reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply): message UUID and thread routing.
