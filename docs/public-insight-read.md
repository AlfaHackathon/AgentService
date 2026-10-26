# Breaking cutover: insight reads belong to InsightService

This AgentService candidate **removes** the old public insight read facade. It is prepared on the separate `codex/remove-insight-read-20261025` branch from `1573b6231eacfa47c1849f40e68bc965313a86aa`; it is not a deployment or a change to the frozen Kafka adapter candidate.

## Route map

| Removed Agent route | Owning Insight route |
| --- | --- |
| `GET /agent-service/insights` | `GET /insight-service/insights` |
| `GET /agent-service/insights/{kind}/{id}` | `GET /insight-service/insights/{kind}/{id}` |
| `GET /agent-service/insights/personal/{id}/history` | `GET /insight-service/insights/personal/{id}/history` |

The Insight cutover preserves the suffix/query, scoped DTO and status semantics, including nullable category until its separate contract is integrated. Its API contract and source authorization belong to InsightService. Do not call internal read endpoints from a browser or send `X-Internal-Secret` to a client.

Agent no longer mounts, authenticates or redirects these insight paths; ordinary requests return 404 with no Location header regardless of whether user/Bearer headers are present. There is no alias, proxy, redirect, feature flag or fallback to the old facade. Agent OpenAPI no longer advertises insight read paths, card/feed/history schemas or a public-insights tag. This is an intentional breaking change; consumers must switch the service prefix.

The five removed `src/insights` modules had no remaining consumers outside the old facade, its tests and its OpenAPI imports. Their implementation remains in Git history; domain read behavior and authorization are maintained in the owning InsightService candidate.

## Chat and service integration stay available

- Existing `/agent-service/chats` metadata and `/agent-service/agents/assistant/{chatId}` admission/history/SSE/abort remain unchanged.
- `assistant_news_insights` remains a company-scoped tool of the main chat agent, using the existing server-only service clients. It is not the removed REST card facade.
- News analysis, internal service tools, company reasoning and canonical write contracts remain unchanged. No source SQL, Context contract, roles, models or Kafka transport changes are included here.

## Release gates and ordering

Prepare this source removal now; **release it only after** the new Insight public endpoints pass their full native gates and gateway smoke with authorized synthetic users. Neither this branch nor its tests prove that new endpoints are deployed.

1. Verify the owning Insight candidate: native restore/build/tests/publish, trusted identity/current membership, exact source/company/bank ACL and safe public projection, pagination/detail/history and documented nullable fields.
2. Verify the new `/insight-service/insights…` paths through the existing gateway for authenticated, unauthenticated, wrong-company and unavailable-dependency cases. Keep existing network/ACL policy; no new ports or browser credentials.
3. Switch the client service prefix and verify its feed, personal/general detail and personal history. Start fresh pagination requests at cutover rather than assuming cross-service cursor compatibility.
4. Only then release this Agent removal candidate. Smoke old Agent paths returning 404 without redirects and existing chat admission/history/SSE plus `assistant_news_insights` still working.

If the new owner has not passed these checks, hold the Agent removal release. This task does not merge, deploy or modify frontend/gateway/InsightService. The frozen parser adapter branch is separate. No automatic data deletion/backfill or offset change is needed for this route removal.

## Verification in this candidate

- Unit absence matrix covers old feed/detail/history paths with anonymous, Bearer, trusted-user and malformed-user headers, across GET/HEAD/POST/PUT/PATCH/DELETE: 404, no redirect and no database access.
- Agent OpenAPI is validated without the removed paths/components; chat and internal news documentation remain.
- Built-process fixture verifies old paths return 404 without facade dependency or model requests, while chat auth/list remain functional and existing background admission probes remain unchanged. Existing conversational tool tests continue to cover `assistant_news_insights` scope and returned saved revisions.
- Standard unit fixtures use embedded PGlite or fake protocol/HTTP services. No real model calls or external database environment is required. Build/unit success does not substitute for the owning Insight native and gateway cutover checks.
