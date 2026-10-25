# Insight category contract

`category` is separate from `kind=personal|general`, company importance (1–5), epistemic `status` / `evidenceStatus`, `publicationClass`, and source provenance.

| Value | Label | Scope-relative meaning |
| --- | --- | --- |
| `risk` | Риск | Evidence supports an adverse effect for the stated company or general segment/conditions. |
| `opportunity` | Возможность | Evidence supports a beneficial effect for that scope. |
| `event` | Событие | An established significant event without a directional effect. |
| `null` | Unclassified | Direction is unknown, effects are mixed with no supported predominant effect, or the record predates classification. |

The model must explicitly supply one of these values for every new company draft and general insight, including segment/signal planners and reviewers. Existing source binding, applicability and evidence validation still apply. `event` is never an uncertainty fallback. A conditional directional scenario may have a category only when its direction is grounded for its explicitly stated scope/conditions; the category does not make the scenario an observed fact. Mixed effects may be split only when they are independently supported, distinct conclusions; otherwise use null. Never infer a category from financial amount signs, priority, keywords, source acquisition, or generic news sentiment. The API validates the enum, not the truth of natural-language classifications; no additional LLM call is introduced.

## Wire and persistence

- Personal analysis draft: `drafts[].category`; persisted immutably as `EffectRevision.category`, returned in `currentRevision.category` and history `items[].revision.category` by the public facade.
- General reasoning: `generalInsights[].category`; preserved through segment plans, checkpoints and `checkpoint.result.generalInsights[]`. Public feed/detail expose `insight.category`.
- Both public DTOs use explicit field allowlists. No inference at read time, no schema migration, no historical rewrite/backfill. Omitted legacy fields become JSON null in the public API; omitted fields on legacy producer requests remain accepted for rolling compatibility.
- InsightService validates category in drafts and the known general checkpoint plan/result/segment-batch locations before storage. Category participates in the existing immutable revision/request identity hash.

## Frontend read contract

`GET /agent-service/insights?kind=personal&category=risk` or `?kind=general&category=opportunity`. Omit `category` for all saved categories including legacy null. The filter accepts exactly one of `risk|opportunity|event`; `category=null`, empty/unknown values and repeated parameters are invalid. No null-only filter is introduced.

Filtering happens in InsightService before pagination over current personal revisions or insights in the latest eligible general job; it does not search old revisions or fall back to an older matching job. Legacy/null records do not match a named category. The cursor binds category with the other filters, company and kind; changing category while reusing a cursor is a 400. Detail/history retain their existing paths and source authorization; category adds no visibility rights. Query validation is reflected in Swagger.

Both services must be released together for category filtering; an older InsightService cannot enforce the new filter. New required model output does not rewrite already stored jobs. No frontend/parser changes, live model calls or external database are needed by this change.
