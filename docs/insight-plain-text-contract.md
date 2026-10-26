# Generated insight plain text

New native personal drafts and general insights must use plain text in `title` and `conclusion`. The shared result-tool guard runs only for `submit_news_analysis` and `plan_news_insights`, before normalization or persistent signal-plan updates. It checks `drafts`, `generalInsights`, and the wrapped `plan.generalInsights`; a coverage-only patch has no new display text.

The bounded literal policy rejects `**`/`__`, unambiguous single emphasis, any backtick, line-start tilde fences and ATX headings, inline/reference Markdown links and images, and HTTP(S) URLs. It is validation, not Markdown stripping or a general Markdown parser. Bullet/blockquote detection is deliberately excluded. Plain paragraphs, decimal claim spans, negative values and single multiplication operators remain exact. Originals, source URLs in metadata, evidence quotes, assessment facts, unknowns and old read DTOs are not rewritten or refined.

An invalid generated field raises HTTP 422 code `INSIGHT_PLAIN_TEXT_REQUIRED` with its generated bounded field path, without echoing the text. Known upstream feedback uses a fixed safe instruction; unknown `INSIGHT_PLAIN_TEXT_` prefixes are suppressed. Native schema fields and persisted claim identity remain unchanged. The agent must explicitly repair the text; the host never invents or strips content.

Model-free tests cover personal/general correction, wrapped signal-plan correction before persistent normalization, literal pattern detection, paragraphs/arithmetic preservation, source quotes and legacy read compatibility. Existing full UTF-8 request tests retain the 65536-byte limit and 1024-byte reserve. No live model, external database, frontend or parser changes are part of this slice.
