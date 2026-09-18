# Feishu reaction acknowledgement

## Context

The Feishu ingress initially mirrored QQ's text receipt, producing two replies per feedback. In active group chats the extra "收到" reply adds noise without information, and Feishu offers a native per-message acknowledgement surface through the reaction API.

## Decision

Acknowledge accepted Feishu feedback with a 👀 (`GLANCE`) reaction on the triggering message instead of a text receipt. On completion, add ✅ (`DONE`) and only then remove the 👀 reaction, so an interrupted switch never leaves the message without a marker, and send only the final reply without the log reference suffix. Reactions are best-effort: a failed 👀 logs `feishu_reaction_failed` and the final reply falls back to appending the log reference, preserving the diagnostic-reference invariant for every handled message. Stop, busy, timeout and failure paths use the same switch. Only reaction IDs returned by this bot's own create calls are removed.

QQ keeps its two-reply receipt format unchanged. The bridge port gains `react`/`unreact` methods backed by the official SDK's `im.messageReaction` API, which requires the `im:message.reactions:write_only` scope (or the broader `im:message`).

## Verification

Bridge tests cover the reaction switch order, the absence of a text receipt, the fallback reference when reactions fail, and that stop, timeout and failure paths still switch to ✅. SDK tests pin the exact reaction create and delete URLs and payloads through the real adapter. The full check suite (33 TypeScript and 6 Python tests) passes.

## Sources

- [Add reaction API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create): scope, `reaction_id` response and error codes.
- [Delete reaction API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete): only the operator's own reactions can be deleted.
- [Emoji reference](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce): `GLANCE` and `DONE` keys.
