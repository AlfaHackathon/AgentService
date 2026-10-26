# Parser source URL preservation

The parser companion adds nullable `url` to get-by-id/stored-search DTOs from `NewsDocument.Url`. This branch validates that optional owner-supplied HTTP(S) URL, rejects userinfo, whitespace/control/backslash, relative addresses and length >4096, and forwards it as `sourceUrl` to Context admission. No URL is constructed from Mongo/publisher/material IDs. Legacy absent/null URL leaves the admission payload unchanged.

Stored discovery preserves the same URL as `sourceUrl`; Tass discovery validates the same safe URL contract. Lead completeness and publisher-version limitations remain unchanged. Exact material provenance remains authoritative for Insight's public anchor field; discovery observations are not citable historical originals.

No new Kafka fields, Mongo-ID remapping, source spelling changes, retry changes, DB, LLM calls or stored-card edits. URL affects Context's existing material version identity; do not blanket replay or regenerate old cards as part of deployment. Existing no-URL material remains no-URL.

Focused verification: 43 tests across `news-parser-reference`, `news-parser-admission`, `news-source-links`; `npm run typecheck`, `npm run check` and `npm run build` pass. The admission integration uses the real consumer/flow and mocked HTTP ports, verifies sourceUrl in Context POST, durable job-before-ack and stable replay, with model calls forbidden. Full DB-dependent suite was not run and no database was created.

Source-only companion to InsightService `codex/insight-source-links-20261026` and WebNewsParserService `codex/parser-source-url-20261026`. Root owns coordinated integration and the single deployment writer.

## Independent combined candidate

`codex/agent-plaintext-context-source-links-combined-20261026` adds this source-link patch onto PR27 commit `6146a8dfe29805a3e748e180dee4a9c543af20d8` (tree `d0ab1bd2835ec6ee90ef582add26001c94d8dbd7`). Owner context from PR25, structural feedback from PR26, plain-text guards/prompts and the test environment isolation fix from PR27 are preserved byte-for-byte. Frozen PR27/PR28 branches are not changed.

Combined verification: 570 tests across 52 files pass with no database or external model calls. Excluded database-related files: `chats.test.ts`, `application.test.ts`, `flue.test.ts`, `socket-database-cleanup.test.ts`; built/live database integration is not run. Typecheck, Biome, boundaries and build pass. This candidate pairs with Insight's independent plain-text/source-links combined candidate and the small parser PR5. The current WS release is not gated on these independent source-link candidates. Root owns final native/integration/deployment decisions.
