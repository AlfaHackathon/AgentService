# Границы новостного анализа

`src/news-analysis` остаётся feature-модулем Node 24 / TypeScript / Flue. HTTP API,
Kafka producer contract сохранён. Доменные операции вызывают API CompanyService / ContextService / InsightService.
Новая структура отражает направление зависимостей и разные причины изменения кода.

| Каталог | Владелец обязанности | Основные точки входа |
| --- | --- | --- |
| `contracts` | Wire schemas, сохранённые checkpoint/receipt, форма business-question, timestamps, ошибки | `analysis.ts`, `flow.ts`, `news-event.ts`, `questions.ts` |
| `application` | Оркестрация Flue и заданий; не загружает Flue или сетевые клиенты во время исполнения | `company-analysis.ts`, `news-flow.ts` |
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
- `company-selection.ts` вызывает CompanyService: ранжирование, раскрытие групп,
  явные роли и сегменты принадлежат CompanyService. Agent сохраняет результат выбора в checkpoint.
- `company-run.ts` запрашивает решение глубины у InsightService, регистрирует watch до canonical receipt,
  исполняет компанию и догоняет source changes. Enqueue предшествует продвижению
  watch cursor; ограниченная пачка catch-up остаётся незавершённой до следующего запуска.
- `job-projection.ts` запрашивает canonical facts и группы у InsightService и собирает
  checkpoint результата. `role-projection.ts` передаёт ролевому reasoner только
  готовую разрешённую проекцию InsightService. Read grants проверяет backend.
- `draft-validation.ts` проверяет привязку drafts к точным версиям источников,
  triggering news и привязку handles к источникам до preview/commit. Применимость,
  predecessor IDs, глубину и канонические проекции проверяет InsightService.
- `segment-policy.ts` проверяет полноту ответа модели, source/segment coverage
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

Проверки AgentService покрывают wire contracts, source binding, segment batching, бюджеты, retry и вызовы доменных API. Правила компаний и расчётов проверяются в сервисах-владельцах. Дополнительные application
seam tests проверяют конкурентное admission и порядок watch → receipt → enqueue → cursor,
включая восстановление после неуспешного enqueue. Отрицательные boundary fixtures
проверяют, что нарушение направления зависимостей действительно обнаруживается.
