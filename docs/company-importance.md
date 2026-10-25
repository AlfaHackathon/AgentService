# Company importance — additive revision contract

`companyImportance` is the authoritative new per-company decision-importance assessment. It is persisted in an Insight revision, not calculated by the browser. Context and frontend code do not change.

```json
{
  "companyImportance": {
    "score": 4,
    "rationale": "An own-company dependency and a documented decision deadline require prompt review.",
    "evidenceRefs": [{"materialId":"synthetic-own","versionId":"v1","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
  }
}
```

The example is illustrative, not a production row. Score: 1 low, 2 moderate, 3 needs attention, 4 high, 5 critical. These are ordinal judgments based on company materiality, urgency and directness of impact, not confidence, financial amount, or risk/opportunity sign. A non-null score requires exact cited own-company evidence; public news/market context alone cannot establish it. Rationale is nonblank, at most 2000 characters; evidenceRefs at most 16 and a subset of this draft's exact sourceRefs.

Insufficient company basis: `{"score":null,"rationale":"Company exposure and materiality are not established.","evidenceRefs":[]}`. Null is not score 1. New native reasoning is instructed to supply the object, including null when necessary; omitted objects remain accepted for existing producers/history.

## One rating, legacy compatibility

Existing `impact.importance` (0..5) is a numeric input to the legacy confidence-weighted ranking formula alongside urgency/novelty. It has no evidence/rationale contract. It is not a second independently assessed new rating.

When companyImportance is present and impact exists, the native host sets `impact.importance = companyImportance.score ?? 0`; Insight rejects contradictory payloads. Zero here is a compatibility ranking contribution when no new score is assessed. This rule does NOT establish the meaning of historical zeros. Without companyImportance, legacy payloads/ranking remain unchanged. Never backfill a new score/rationale from old importance/priority, and never map historical zero to null by guessing. Priority still differs from companyImportance because it also reflects evidence/urgency/novelty; its formula is unchanged.

## Read contract and frontend mapping

- Internal detail: `GET /insight-service/internal/effects/{effectId}` → `currentRevision.companyImportance`, and each `history[].companyImportance`.
- Internal snapshot: `GET /insight-service/internal/effects?companyId=…&newsMaterialId=…` → `effects[].currentRevision.companyImportance`.
- Internal canonical projection: `POST /insight-service/internal/projections/canonical-facts` → `facts[].revision.companyImportance`; company receipts/job projections retain the revision too.
- Existing `assistant_news_insights` tool returns `effects[].currentRevision.companyImportance`, with the usual server owner→membership/company checks.

Frontend badge uses only score 1..5 from this object, explanation uses rationale. Missing object or null score displays “not assessed”; do not derive it from legacy impact.importance or priority. Respect revision/asOf and outer requiresReassessment; a stale revision's rating is not a fresh reassessment. Evidence links require the same server-side source access checks as other citations.

These REST routes remain INTERNAL and require `X-Internal-Secret`; never put it in frontend code. The public chat remains Bearer→AuthGateway→Agent and can narrate tool results. There is currently NO public insight feed/detail REST facade for cards. That missing public read facade is an explicit frontend integration dependency; this slice does not implement it or claim browser availability.

## Storage, OpenAPI, rollout

No new SQL column/table or migration: the optional field is serialized into existing revision JSON TEXT and canonical receipts. Missing fields deserialize as absent/null; C# omits a null object when serializing, preserving legacy hash input and avoiding invented backfill. Score changes belong to new revisions, never edits of history or a forced replay rewrite.

This branch starts from master after the existing Swagger changes were merged. Agent's imported Zod analysis schema and Insight's reflected DTO automatically expose this field; no second spec or docs route is introduced, and the published Swagger branches are not rewritten. Nullable score bounds are verified in standalone generated schemas; native full-service Swagger validation still belongs to the merged-candidate gates.

Deploy compatible Insight reader/validator/writer first, then Agent producer. Old Agent writers remain accepted. Do not deploy new Agent against an old Insight that silently ignores the additive field. No live model calls are needed for contract tests; native Insight PostgreSQL/MVC gates must run in the authorized package-enabled executor before deployment.
