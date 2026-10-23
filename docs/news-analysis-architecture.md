# Границы новостного анализа

`src/news-analysis` остаётся feature-модулем Node 24 / TypeScript / Flue. HTTP API,
Kafka producer contract и протоколы ContextService / InsightService сохраняются.
Новая структура отражает направление зависимостей и разные причины изменения кода.

| Каталог | Владелец обязанности | Основные точки входа |
| --- | --- | --- |
| `contracts` | Wire schemas, сохранённые checkpoint/receipt, business-question identity, timestamps, ошибки | `analysis.ts`, `flow.ts`, `news-event.ts`, `questions.ts` |
| `application` | Use cases и проверяемые правила анализа; не загружает Flue или сетевые клиенты во время исполнения | `company-analysis.ts`, `news-flow.ts` |
| `retrieval` | Типизированные upstream API, source windows/catalog, допуск evidence в бюджеты | `context-client.ts`, `insight-client.ts`, `flow-clients.ts`, `tool-evidence.ts` |
| `reasoning` | Flue invocation/retry, prompts, преобразование model output, read-only tools | `company-reasoner.ts`, `flow-reasoner.ts`, `agent-runner.ts`, `service-tools.ts` |
| `transport/http` | Hono ingress и общий HTTP primitive: authentication, deadline, replay-safe retry, error mapping | `routes.ts`, `service-client.ts`, `settings.ts` |
| `transport/kafka` | Kafka lifecycle, partition pause, offset commit после admission, readiness | `consumer.ts` |
| `composition` | Создание конкретных адаптеров, запуск и остановка runtime | `configuration.ts` |

Определения агентов остаются в `src/agents/news-analysis.ts`, где их обнаруживает Flue.
Они используют schemas/validators/tools из feature-модуля; application получает
reasoner через `NewsReasoner` / `FlowReasoner`, без импорта конкретного агента.

## Разделённые обязанности

- `news-flow.ts` владеет lease, сериализацией checkpoint writes, bounded concurrency,
  этапами планирования/сегментации и итоговым статусом задания.
- `news-admission.ts` принимает публикацию, вычисляет прежние immutable IDs,
  разрешает конкурентный 409 через чтение победившей версии и возвращает параметры
  задания с оригинальным `knownAt`. Он не запускает worker и не знает Kafka.
- `company-selection.ts` объединяет retrieval ranks, группы, явные роли и страницы
  прежних получателей с сохранением company budget.
- `company-run.ts` выбирает глубину, регистрирует watch до canonical receipt,
  исполняет компанию и догоняет source changes. Enqueue предшествует продвижению
  watch cursor; ограниченная пачка catch-up остаётся незавершённой до следующего запуска.
- `job-projection.ts` читает актуальные canonical heads, отмечает stale effects,
  строит coverage и ролевые представления. `role-projection.ts` отдельно проверяет
  read grants, время, хеши и все источники до вызова ролевого reasoner.
- `draft-validation.ts` проверяет привязку drafts к точным версиям источников,
  triggering news, applicability и conditions до preview/commit.
- `segment-policy.ts` владеет чистыми правилами membership, source/segment coverage
  и обновления сохранённых batches. `segment-analysis.ts` выполняет retrieval и
  пополняет durable inventories, вызывая переданный reasoner. `signal-cache.ts`
  проверяет пригодность законченного inventory без зависимости от reasoning.
- `service-client.ts` отделяет retry/deadline/auth от typed API операций.
  CAS lease/cursor POST не получают replay retry; прежние тайм-ауты сохранены.
- `tool-evidence.ts` отделяет допуск evidence и character budgets от Flue hooks.
  `contracts/news-event.ts` декодирует producer payload без загрузки KafkaJS.
  Persisted depth/relevance/signal schemas также не загружают исполняемые use cases.

## Проверка направления зависимостей

`npm run check:boundaries` разбирает TypeScript AST, включая re-export, dynamic
import и inline type import. Он также входит в `npm run check` и тесты.

Contracts зависят только от contracts и библиотек schemas/стандартной библиотеки.
Application использует contracts, свои use cases и чистые source-catalog/source-units;
upstream clients допускаются только как type imports. Retrieval использует contracts
и HTTP primitive. Reasoning использует contracts/retrieval и определения Flue agents.
Transport видит application только через type imports. Composition связывает реализации.
Проверка намеренно не переносит весь TypeScript-сервис в соглашения C#.

## Верификация без модели

Обычные `npm test`, `npm run typecheck`, `npm run check`, `npm run build` и
`npm run test:built` используют тестовые настройки и не требуют платного LLM.
`test:live` — отдельный сценарий с реальной моделью; рефакторинг не запускает его
и не возобновляет предыдущий Kafka/LLM worker.

Существующие regression suites проверяют wire contracts, identity, unknown/conditional,
source binding, глубину, segment batching, бюджеты и retry. Дополнительные application
seam tests проверяют конкурентное admission и порядок watch → receipt → enqueue → cursor,
включая восстановление после неуспешного enqueue. Отрицательные boundary fixtures
проверяют, что нарушение направления зависимостей действительно обнаруживается.
