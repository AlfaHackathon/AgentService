# Agent insight title contract

Personal `EffectDraft.title` and saved revision `title` are optional nullable strings, at most 180 characters. Legacy reads/replay and `no_insight` diagnostics do not require a manufactured title. A provided new native title is a nonblank single line and is preserved verbatim, independently of the full conclusion. The producer never truncates or copies the body to invent a title.

The native model tool adds only one optional nullable `title` scalar. Its instructions request a short grounded qualitative title without opaque IDs. InsightService is authoritative for requiring titles on newly published writes and for numeric-title rules; internal diagnostics may retain an honest unproven numeric phrase without publishing it.

The existing optional `calculationClaimQuote` may name the exact decimal-and-unit span in title, conclusion, or both. It still produces one four-field `calculationClaim`; there is no additional title claim object. The quote must occur at least once, and exactly once in each field where present, with complete token boundaries. An absent quote in the other field is not fabricated. Reusing an identical quote in both fields is allowed; Insight independently validates each field against the same canonical result/unit/period and its remaining numeric text.

A title containing 800 with an independently computed result of 8000 remains a lexical claim of 800. It is rejected with the existing safe `CONCLUSION_CLAIM_VALUE_MISMATCH` feedback until the agent explicitly corrects it. No floating-point evaluation, copied historical calculation, automatic wording change, or universal NLP validation is added.

`TITLE_REQUIRED`, `TITLE_INVALID`, and `TITLE_NUMERIC_REQUIRES_CALCULATION` are allowlisted safe machine feedback. Raw upstream title/message suffixes are not passed to the model. Authoritative title requirements run after exact legacy receipt replay in InsightService; Agent read DTOs remain compatible with omitted/null titles.

The existing exact and bounded synthetic wire fixtures retain their 65536-byte guard and required 1024-byte reserve; repeated instruction descriptions are shortened without removing source text, assessments, unknowns or history. No frontend, parser, deployment, model service or external environment changes are included.

Release order: pause and drain all analysis writers, including jobs and chat; deploy InsightService, then AgentService; verify both services, then resume writers. An unpaused rolling update is not write-compatible because the new backend requires a title for newly published insights. Public readers consume `currentRevision.title` and history-item `revision.title`; legacy null/absent titles have no body-derived fallback.
