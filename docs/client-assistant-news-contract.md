# ClientAssistant: admitted news discovery/read

## Implementation and dependency status

This AgentService slice adds `assistant_search_news`, `assistant_read_news` and a
`newsHandle` selector on the existing `assistant_analyze_news`. No public chat
routes, frontend, parser, ingestion worker, dispatcher or feedback are changed.

Base checked on 2026-10-25: AgentService master
`3904be7fdd60ad8551646134c1102ad70ea4cb8d`, ContextService master
`c4e7e74095310b3d094e2142abc350f939f6a70d`. Fresh remote heads were unchanged;
none of their published branches provides this catalog. Context search excludes
news. Its existing `/internal/news/resolve` supports exact reads, but there is no
admitted news search endpoint. **Search is not operational against that Context
master until the separate dependency below is implemented.** A missing endpoint
returns `ASSISTANT_NEWS_SEARCH_UNAVAILABLE`, never an empty/exhaustive corpus.
Tests here use fake services and a fake analyzer, not live retrieval or models.

## Separate ContextService dependency (not implemented in this branch)

Add exactly one internally authenticated read endpoint:

```http
POST /context-service/internal/news/search
X-Internal-Secret: <server-only>
Content-Type: application/json

{"query":"ключевая ставка","asOf":"2026-10-25T10:00:00Z","limit":6}
```

Strict request: trimmed nonempty query, <=2000 characters; explicit valid asOf;
limit 1..6. No user/company IDs, URLs, acquisition or arbitrary search scope.
This is a bounded lexical catalog of already admitted public news, not an
embedding/rerank query, external search or company relevance claim.

```json
{
  "asOf": "2026-10-25T10:00:00Z",
  "exhaustive": false,
  "hits": [
    {
      "materialId": "news-example",
      "versionId": "version-example",
      "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sourceId": "example-publisher",
      "kind": "news",
      "title": "Изменение ставки",
      "knownAt": "2026-10-25T09:00:00Z",
      "publishedAt": "2026-10-25T08:00:00Z",
      "companyIds": [],
      "bankProfileIds": [],
      "provenance": {
        "acquisition": "event_payload",
        "sourceUrl": "https://publisher.example/news",
        "retrievedAt": "2026-10-25T09:00:00Z",
        "textCompleteness": "lead",
        "originVersionId": null,
        "locator": null
      }
    }
  ]
}
```

Each hit is the existing MaterialVersion DTO **without text**, with canonical
stored provenance and hash. Null/absent provenance remains unknown. Required
scope fields must not be omitted. Filter `kind=news`, `knownAt <= asOf`, empty
companyIds AND bankProfileIds before returning anything. Select the latest
permitted correction version per material at asOf; match query on that version,
so an obsolete matching predecessor does not masquerade as a current hit. Order
stably by knownAt descending, then materialId/versionId, return <=limit.

Preserve provenance; do not label leads full, invent publisher version IDs or
load URLs. Use a parameterized bounded database query, not an unbounded scan in
the agent or Qdrant's company/market projection. Keep existing internal-secret
middleware. Invalid requests -> 400; unavailable storage -> normal service error;
no matches -> 200 with empty hits and exhaustive=false. Never replace a failed
lookup with empty success. This endpoint does not admit sources or invoke agents.

Existing read dependency is unchanged:
`POST /context-service/internal/news/resolve` with
`{newsMaterialId,newsVersionId,asOf}` -> MaterialVersion including stored text.
No new Context read endpoint is needed.

Context acceptance: private/bank-scoped/future/non-news versions excluded;
latest permitted correction chosen before text matching; deterministic limits;
exact hash/provenance; asOf boundary at 100ns precision; missing results distinct
from backend failure; no embeddings/rerank/network acquisition. Agent fixtures
validate the response contract but do not prove a Context implementation exists.

## Agent contract

1. `assistant_search_news({query})` returns at most six candidates with opaque
   `newsHandle`, title, dates, provenance, textCompleteness, server asOf and
   exhaustive=false. It never returns full text or starts analysis.
2. `assistant_read_news({newsHandle:"n0"})` resolves the saved exact version at
   the original search snapshot, rechecks public scope/hash/time and returns the
   stored original plus explicit completeness. A stored original can be only a
   lead/excerpt; absent provenance means unknown, not full.
3. On explicit user request, `assistant_analyze_news({newsHandle:"n0"})` rechecks
   the selection and calls the existing single-company NewsAnalyzer. Legacy
   `{newsMaterialId,newsVersionId}` remains accepted. Exactly one selector is
   required; mixed/partial selectors and caller company/time fields are rejected.
   Optional triggerSourceHandle retains its existing company/market semantics.

Owner/membership are reread per tool. Handles are tied to the chat's current
company and exact material/version/hash/search-asOf; they cannot be used after a
company switch. The bounded news catalog keeps 24 handles, separate from context
`s*` handles; missing/evicted handles require search again. Existing conversations
without newsSources remain readable. No public news allowance is added to the
existing company/market `assistant_read_original` or trigger source path.

Analyze uses current server message asOf and the selected immutable source,
checks it against the original search snapshot, and retains existing receipt
replay/unknown-outcome behavior. It does not force fresh reasoning for an already
saved version. Existing call/output/analysis budgets apply. Oversized originals
return OUTPUT_BUDGET; they are not silently truncated. Search/read do not alter
canonical domain state. Explicit user request remains the existing agent
instruction, not a newly implemented host consent/action framework.

## Verification

Fake-dependency tests cover search -> exact read -> selected analysis, scope/hash/
version/time mismatches, bank-only scope, company change, handle isolation/eviction,
old state, lead/unknown provenance, missing catalog, budgets and exclusive tool
selectors. Native Flue tool advertisement is checked using the existing local
protocol stub; it is not an LLM or semantic quality evaluation.
