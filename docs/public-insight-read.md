# Публичное чтение инсайтов для фронтенда

Этот контракт реализован в ветке `codex/public-insight-read-20261025` поверх company-importance. Наличие кода/локальных HTTP-тестов не означает публикацию маршрутов на production. Gateway/nginx ingress проверяется отдельно после релиза. Новых портов, CORS, ACL и генерации эта ветка не добавляет.

## Вызовы

Внешний клиент использует Bearer через существующий AuthGateway. Agent получает проверенный `X-User-Id` внутри доверенной сети и сам запрашивает текущий membership CompanyService. Клиент не присылает `companyId`, `personId`, `asOf` или внутренний секрет. Direct Agent ingress не предназначен для публичного доступа.

| Метод и путь | Для чего |
| --- | --- |
| `GET /agent-service/insights` | Главная: последние 5 personal-карточек; лента с фильтрами |
| `GET /agent-service/insights/{kind}/{id}` | Деталь personal или general; ID брать из ленты |
| `GET /agent-service/insights/personal/{id}/history` | Отдельная страница ревизий personal; общая история general пока отсутствует |

Лента: `kind=personal` по умолчанию либо `general`; `limit=1..20` (по умолчанию 5), `cursor` (не разбирать), `newsMaterialId`. Для personal также `status` (сохранённая строка, не новый UI enum), `mechanism` (из существующего question enum), `minImportance=1..5` (только новая обоснованная оценка). History: `limit=1..20`, по умолчанию 10, `cursor`. У detail query-параметров нет. Неизвестные и повторные параметры отвергаются.

```http
GET /agent-service/insights?kind=personal&limit=5&minImportance=3
Authorization: Bearer <client-token>
```

Ответ ленты: `{companyId, items, nextCursor, exhaustive:false}`. Personal сортируется по времени создания текущей ревизии DESC, затем ID DESC. General: последний разрешённый completed/partial job для каждой пары news/version, затем updatedAt/job ID/индекс DESC. History сортируется по sequence DESC. Курсор связан с компанией, видом и фильтрами (history — также ID). При изменении фильтров или после обновления данных начать с первой страницы; это живая лента, не фиксированный snapshot между запросами. `exhaustive:false` не является счётчиком или признаком полного поиска. Страница может быть пустой при ненулевом `nextCursor`: приватные по источникам карточки отфильтрованы, продолжайте курсор.

## DTO и отображение

Personal:

```text
kind: "personal"
id: canonical question/effect ID
companyId, newsMaterialId, literalObjectRef
currentRevision: {
  revisionId, previousRevisionId, newsVersionId, newsMaterialId?, asOf, createdAt,
  conclusion, status, publicationClass?, question?, assessment?, trigger?, sourceRefs,
  companyImportance: {score: 1..5|null, rationale, evidenceRefs} | null,
  impact: {metric, amountBasis, economicObjectId, evidenceStatus} | null
}
requiresReassessment: boolean
sources: SourceMetadata[]
indicators: Indicator[]    // 0 или 1
indicatorAvailability: {reason, explanation}
```

`currentRevision` — явный публичный allowlist, не сериализация внутренней записи целиком. Нет modelExplanation, raw AST/результата расчёта, legacy importance/urgency/novelty. Assessment сохраняет основания, условия и unknowns; статусы/прогнозы не превращаются в подтверждённые факты. Для history: `{companyId, insightId, items:[{revision, sources, indicators, indicatorAvailability}], nextCursor}`. Исторические права на источники проверяются по текущему membership; текущий requiresReassessment консервативно подавляет показатели истории тоже.

Importance: 1 низкая, 2 умеренная, 3 требует внимания, 4 высокая, 5 критичная. Это важность решения для этой компании, не confidence, размер денежного эффекта или знак риска/возможности. `score:null` означает не оценено; rationale объясняет причину. Внешний `companyImportance:null` означает отсутствие нового assessment в старой записи. Старый `impact.importance` не используется как fallback и не показывается вторым числом. Массового backfill нет. При `requiresReassessment=true` рядом с исторической оценкой показать необходимость пересмотра, не выдавать её за свежую.

General:

```text
kind: "general"
id: opaque stored job/index reference
companyId, newsMaterialId, newsVersionId, asOf, updatedAt
textCompleteness: "full" | "lead" | "unknown"
companyStatus: "completed" | "failed" | "pending"
requiresReassessment: null
insight: {title, conclusion, mechanism, applicability[], exclusions[], unknowns[], sourceRefs[], signalIds?, quality?}
sources, indicators: [], indicatorAvailability
```

Это существующий общий результат job, отфильтрованный отдельно для текущей компании. Нет новой сущности/ревизий general, checkpoint, receipt других компаний, role views или общего companyImportance. `quality.priority`, если есть, относится к общему выводу и не заменяет companyImportance. `requiresReassessment:null` означает, что текущая актуальность общего snapshot не оценена; asOf/версия сохранены честно. Старые разрешённые general ID продолжают открываться, даже если в ленте уже появился новый job. General-показатели компании не вычисляются.

## Условный блок показателей

`indicators` — projection одного существующего сохранённого расчёта. Нет обязательного EBITDA/margin, генерации метрик или повторного вычисления. Например, иллюстративное синтетическое значение:

```json
{
  "name": "Изменение расходов",
  "metric": "expense_delta",
  "value": "15600",
  "unit": "RUB",
  "period": "2026-11",
  "baselinePeriod": null,
  "evidenceStatus": "conditional",
  "sourceRefs": [{"materialId":"synthetic-own","versionId":"v1","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
  "arithmeticOnly": true
}
```

Отображать value как Decimal string, не считать его JavaScript float. `"0"` — настоящий сохранённый ноль, неизвестное значение не становится нулём. Conditional означает условный расчёт; `arithmeticOnly:true` подтверждает только арифметику, не наступление события/оплату. Название, единица, период, baseline и evidence сохраняют смысл исходного расчёта. Для budget_delta без известной базы, неизвестного периода, неподтверждённого собственного основания, stale или отсутствующего расчёта список пуст. `indicatorAvailability.reason`: available / no_calculation / missing_result / stale_sources / insufficient_evidence / unknown_period / unknown_baseline / general_not_company_calculation; explanation пригодно для объяснения отсутствия блока.

## Источники и ссылка на оригинал

SourceMetadata: `{materialId,versionId,contentHash,sourceId,kind,title,knownAt,publishedAt,provenance}`. Provenance nullable: `{acquisition,sourceUrl,retrievedAt,textCompleteness,originVersionId}`. Полный текст, ACL arrays и internal locator не возвращаются. URL только из `MaterialVersion.provenance.sourceUrl`, только HTTP(S) без username/password; при отсутствии/неподходящем URL — null, из ID ничего не строится. Открытие ссылки фронтом не означает, что backend загрузил полный publisher original; lead/excerpt/unknown остаются такими.

Точный существующий внутренний resolve:

```http
GET /context-service/internal/material-versions/{materialId}/{versionId}
X-Internal-Secret: <service-only>
```

Для новости также существует внутренний `POST /context-service/internal/news/resolve` с `{newsMaterialId,newsVersionId,asOf}`. `assistant_read_news` и `assistant_read_original` уже возвращают `original.provenance.sourceUrl`. Эти внутренние endpoints не предназначены для браузера; фронт берёт ссылку из публичного `sources[].provenance.sourceUrl` после релиза facade. Bank position не выводится из AI-текста и отдельного искусственного bank-position поля здесь нет.

Перед выдачей каждой карточки Agent перечитывает точные версии источников и проверяет IDs/hash/knownAt<=saved asOf и текущий company/bank scope. Для general допускаются только публичные news/market без company/bank ACL и обязательный точный news anchor. Private-source карточка пропускается в feed; detail/history возвращают 404. Временная недоступность источника — ошибка, не успешная пустая лента.

## Ошибки, нагрузка и эксплуатация

Все успешные/ошибочные read-ответы `Cache-Control: private, no-store`. Public identity rejection использует существующий `{error:"Gateway user context required"}` (401); route errors — `{code,message}`:

| HTTP | Смысл |
| --- | --- |
| 400 | INVALID_REQUEST / INVALID_QUERY / INVALID_CURSOR: параметры или scope/filter binding курсора |
| 401 | Нет доверенной identity либо gateway отверг Bearer |
| 403 | COMPANY_MEMBERSHIP_REQUIRED |
| 404 | INSIGHT_NOT_FOUND: отсутствующая или недоступная по текущим правам карточка/история |
| 502 | INSIGHT_READ_CONTRACT / INSIGHT_SCOPE_MISMATCH / SOURCE_IDENTITY_MISMATCH / IMPORTANCE_EVIDENCE_MISMATCH / GENERAL_NEWS_ANCHOR |
| 503 | Зависимость/конфигурация недоступна, exact source отсутствует, либо SOURCE_READ_BUDGET (уменьшить limit) |

Не делать бесконечный retry; для 503 предложить повтор, source budget — меньшую страницу. GET не запускает jobs/LLM/embeddings/search/acquisition и не меняет доменное состояние. Максимум 64 уникальных точных версий на запрос, concurrency 4, общий deadline 15 секунд. SQL read-only с statement_timeout=2s. Полный source text читается внутренним adapter только для существующего material DTO, но не отдаётся фронту. При больших объёмах JSON feed queries могут упереться в timeout; дальнейшие индексы/projected read storage — отдельный шаг, не скрытая новая платформа.

Новые internal Insight маршруты: `/insight-service/internal/read/companies/{companyId}/personal`, `/personal/{id}`, `/personal/{id}/history`, `/general`, `/general/{id}` (везде GET + существующий internal secret middleware). Клиентский Bearer сам по себе не открывает internal API. Никаких изменений UserService, business role enum/default или login-user/person ACL mapping; отдельный контракт роли ведёт Артём.

## Релиз и ограничения

Сначала InsightService с internal read dependency и importance, затем AgentService с facade/importance. Context изменений не требует. SQL migrations/backfill новых таблиц нет. Нужна существующая БД со штатными таблицами questions/effects/revisions/validity/news_jobs и функцией insight_utc_ticks. При откате Insight раньше Agent feed даст 503, не пустой успех; безопаснее первым откатить Agent. Публичные пути должны пройти smoke через существующий gateway на синтетическом user с membership и разрешёнными источниками. Не открывать дополнительные порты и не передавать секрет браузеру.

Swagger Agent: существующий opt-in `/agent-service/swagger/index.html`, spec `/agent-service/swagger/v1/swagger.json`; новая public группа Bearer. Insight Swagger документирует новые internal reads и их DTO под InternalSecret. Включение Swagger не расширяет доступ к API.

Не реализованы write-actions/deepen/feedback/assignment, general revision history/current invalidation tracking, persona адаптация (ждём контракт Артёма), нормализованные UI status/category enums и общие bank-position labels. Обсудить карточку можно существующим чатом текстом со стабильным ID; структурированная card-action admission в этот slice не добавлена.

Category and filter: see [insight-category.md](insight-category.md). Personal `currentRevision.category` / history `revision.category` and general `insight.category` are nullable `risk|opportunity|event`, independent of kind and importance. Legacy values stay null.
