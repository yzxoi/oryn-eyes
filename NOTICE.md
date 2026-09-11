# Provenance

Core packaging, isolated worker lifecycle, provider profile, progress and failure diagnostics are adapted from [yzxoi/oryn-mini](https://github.com/yzxoi/oryn-mini/tree/775ff40758ffb18ae67e9fdbbf0a335fb447aeaf), MIT, copyright 2026 yzxoi. The configured Synergy Core source and commit are recorded in `config/core.json`; its MIT license is included in built bundles as `.runtime/SYNERGY-LICENSE`.

The QQ integration follows AstrBot's public [plugin events](https://docs.astrbot.app/dev/star/guides/listen-message-event.html), [message sending](https://docs.astrbot.app/dev/star/guides/send-message.html), and [OneBot v11 integration](https://docs.astrbot.app/platform/aiocqhttp.html). It replaces the previous user-owned Chaos thin bridge while retaining its group-mention/private-message behavior.

GitHub source reading and publication use the official [Issues REST API](https://docs.github.com/en/rest/issues/issues), [Search REST API](https://docs.github.com/en/rest/search/search), and [repository contents API](https://docs.github.com/en/rest/repos/contents). No GitHub web-upload endpoint is reverse-engineered.
