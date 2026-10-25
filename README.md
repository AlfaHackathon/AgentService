# AgentService

Основание агентного сервиса AlfaHackathon: TypeScript, Node 24, Flue 2.3, Hono и PostgreSQL.
Пользователь общается с ClientAssistantAgent; CompanyResearchAgent, InsightAgent и ScenarioAgent
зарегистрированы для внутреннего запуска. Новостной pipeline использует ещё три Flue-агента:
NewsPlannerAgent, CompanyConsequencesAgent и RoleProjectionAgent и вызывает API CompanyService, ContextService и InsightService.

CompanyService владеет профилями компаний, группами, людьми, явными ролями, выбором компаний и сегментами.
ContextService владеет версиями материалов и поиском. InsightService владеет вопросами,
расчётами, решениями глубины, сохранённым состоянием, приоритетами и ролевыми проекциями.
AgentService выполняет Flue-рассуждение, вызовы инструментов и продолжение заданий.
Определения агентов подключают наборы из `src/news-analysis/reasoning/tools/`;
регистрация инструментов находится в этих модулях, отдельно от определений агентов.

Разговорный `ClientAssistantAgent` отдельно подключает `src/client-assistant/tools.ts`:
`assistant_company_profile`, `assistant_search_context`, `assistant_read_original`,
`assistant_news_insights`, `assistant_analyze_news`, `assistant_search_news`,
`assistant_read_news`. News search требует отдельного Context catalog endpoint,
которого нет в проверенном Context master; exact read использует существующий news resolve.
[Контракт и статус зависимости](docs/client-assistant-news-contract.md). Остальные tools вызывают существующие
Company/Context/Insight API через типизированные локальные клиенты. Публичный chat HTTP/SSE
контракт не меняется; новые backend endpoints и shared-package API не добавлены.

Runtime `AgentProps.id` связывается с владельцем в каталоге chats; `message.uid` не является
пользовательской identity. Перед каждым tool проверяется текущий membership через
CompanyService `/internal/companies/by-user/{ownerId}`. Company/time/bank profile задаёт host,
не модель; отсутствие владельца, membership или конфигурации возвращает явный отказ.
Группы и ролевые grants не расширяют этот scope. Оригинал читается только по handle из scoped
поиска с повторной проверкой company/hash/version/knownAt. Внешний web search не подключён. Поиск новостей возвращает company-bound `newsHandle`;
чтение и выбор для анализа повторно проверяют exact version/hash/public scope/asOf.
Lead/excerpt/unknown не объявляются полным текстом. `assistant_analyze_news` принимает
либо newsHandle, либо прежнюю пару newsMaterialId/newsVersionId, без смешивания selectors.

Ручной анализ запускается только по явному запросу пользователя для своей компании и существующей
публичной версии новости, через прежний single-company `NewsAnalyzer`. Пересмотр по новому
основанию использует проверенный `triggerSourceHandle`; канонические drafts разговорная модель
не пишет. Сохранённый receipt переиспользуется, а не выдаётся за новый пересмотр. Результат tool —
краткая квитанция; текущие эффекты читаются отдельно с company scope, без NewsFlow checkpoint,
общего job result или ролевых проекций. При потере ответа проверяется receipt, автоматического
повтора анализа с неопределённым исходом нет.

На пользовательское сообщение: до 8 tools и одного нового анализа, 24000 символов на ответ и
60000 суммарно. Поиск возвращает до 6 hits и 24 handles; пропущенные refs отмечаются явно.
Оригиналы не обрезаются: слишком большой ответ возвращает `OUTPUT_BUDGET`. Effects ограничены
8 записями с `hasMore`/`nextOffset`; параметры offset/limit позволяют продолжить чтение или
уменьшить страницу. Неполная выдача не доказывает нулевое влияние. Сообщения upstream errors
не передаются модели дословно. Эти ограничения и ошибки не отключают обычный чат.

## Новостное состояние и продолжение

Native result содержит `question={mechanism,frame,unit,targetPeriod,baselinePeriod,basis}` и
`assessment={conditions,unknowns}`. `frame` отделяет `event_only`, `absolute`, `budget_delta`;
периоды имеют ISO-формат/`unknown`, бюджетный baseline можно обозначить `budget:2026-11`.
Агент связывает handles с буквальным объектом и источниками; InsightService нормализует вопрос и назначает устойчивый key. Для существующего вопроса модель
выбирает handle `q0`; историю, predecessor IDs и операции хранилища она не задаёт.
Разные механизмы и базы сравнения сохраняются отдельно.

`NewsAnalyzer` запрашивает готовую session у InsightService со `stateVersion`, делает до двух адресных доборов
по максимум трём запросам, затем отправляет атомарный пакет с `expectedStateVersion`.
Добор прекращается при отсутствии нового оригинала, исчерпанном доступном корпусе или бюджете;
queries/полученные версии/stopReason сохраняются в receipt. Отсутствие основания остаётся unknown.

HTTP-клиенты читают пакетный ответ ошибки ContextService/InsightService `{errorMessage}`
и прежний `{code,message}` для middleware. При конфликте HTTP 409 во время записи
applicability receipt InsightService решает, требуется ли глубокий анализ.
Подготовка predecessor IDs и проверка атомарной записи выполняются в InsightService.
`/internal/execution/company-plan` определяет анализ компании и сохранённую глубину;
`/internal/projections/job` формирует canonical heads, ролевые проекции и coverage по durable checkpoint.
Agent не собирает банковский scope и доменные итоги локально.

`companyBudget` ограничивает одну lease-партию. Job с оставшимися адресатами получает `partial`
и подхватывается worker после перезапуска; сохранённые plan/receipts переиспользуются.
Предыдущие адресаты читаются из canonical question index страницами по 256.
`SourceChangePump` читает журналы материалов ContextService и знаний CompanyService,
получает готовые задания через `/internal/execution/source-jobs`, ставит их в durable queue
и затем продвигает отдельный CAS cursor каждого журнала в InsightService.
Повторный добор для зарегистрированной компании определяет `/internal/execution/company-watch`. Новые версии оснований инициируют пересмотр с `trigger`; изменения
группы/роли — `projectionOnly` refresh общего состояния без нового company reasoning.

InsightService агрегирует группы по сопоставимым mechanism/frame/baseline/basis/unit/period. Устаревшие основания
исключаются из известных subtotal и ролевых действий; gaps блокируют полный итог.
Ролевая модель получает разрешённые факты и канонически отображённые Decimal-результаты;
исходное `modelExplanation` остаётся в audit receipt. CSV-связь человека не создаёт роль/grant.

## Локальный запуск

Требуются Node >=24 и PostgreSQL. Из каталога AgentService:

```sh
npm ci
```

Скопируйте `.env.example` в `.env`, задайте endpoint, ключ и ID модели, DATABASE_URL.
LLM endpoint должен поддерживать OpenAI Chat Completions с SSE; указанный base URL используется
как есть. Метаданные context window/max tokens задавайте по выбранной модели. Значения стоимости
в custom provider равны нулю: денежная оценка runtime в этой конфигурации не рассчитывается.

```sh
docker compose up -d postgres
npm run dev
```

Dev-сервер слушает http://localhost:5173. Миграция каталога чатов и таблицы Flue подготавливаются
при старте. Приложение прекращает запуск, если БД или обязательная конфигурация недоступны.
Прикладные миграции можно применить отдельно: `npm run migrate`. Запускайте команды из корня сервиса.

Для локального запуска в контейнерах: `docker compose up --build`. AgentService слушает порт 3000
только внутри Docker-сети, host-port не публикуется. Внешний вход в кластере — через AuthGateway.
Compose использует отдельный named volume PostgreSQL. Пароль в DATABASE_URL должен быть URL-encoded;
для примера Compose задавайте POSTGRES_PASSWORD без специальных символов URL.

## Идентификация

Контракт соответствует [AuthGateway](https://github.com/AlfaHackathon/AuthGateway/tree/codex/agent-service-sse):
gateway проверяет пользовательский токен, зачищает входящие identity-заголовки и передаёт
`X-User-Id` / `X-User-Role`. AgentService берёт GUID владельца из `X-User-Id` и проверяет
принадлежность чата. Для текущих операций роль не меняет проверку владельца.

JWT, ключи подписи, issuer/audience и вызовы auth-service в AgentService отсутствуют.
Без корректного gateway user ID пользовательские операции возвращают 401; Bearer сам по себе
не заменяет контекст gateway. Сервис должен оставаться во внутренней сети за gateway.
Локальный dev слушает только 127.0.0.1; для прямой проверки можно явно передать тестовый X-User-Id.

Все пути имеют префикс `/agent-service`, gateway передаёт их без удаления префикса, как у UserService.
Маршрут `/agent-service/{**catch-all}` и настройки SSE подготовлены в отдельных ветках
`codex/agent-service-sse` репозиториев AuthGateway и cluster. Nginx и YARP сохраняют
префикс, query string и внешний Host, отключают буферизацию потокового ответа.
Сервис публикуется отдельно в ветке `codex/agent-service-base` репозитория AgentService.
Инструкции подключения сайта и сквозной тест находятся в README и tests репозитория cluster.

## Чаты и протокол

| Метод | URL | Назначение |
|---|---|---|
| POST | /agent-service/chats | Создать чат, JSON `{}` или `{"title":"Название"}` |
| GET | /agent-service/chats?archive=active&limit=20 | Свои чаты; archive: active/archived/all, nextCursor для следующей страницы |
| GET | /agent-service/chats/:id | Метаданные своего чата |
| PATCH | /agent-service/chats/:id | Изменить `title` и/или `archived` |
| POST | /agent-service/agents/assistant/:id | Native отправка Flue, HTTP 202 |
| GET | /agent-service/agents/assistant/:id?view=history | Native история Flue |
| GET | /agent-service/agents/assistant/:id?view=updates&live=sse | Native поток; SDK управляет offset и переподключением |
| POST | /agent-service/agents/assistant/:id/abort | Остановить активную и ожидающую работу чата |
| GET | /agent-service/health | Жив ли HTTP-процесс |
| GET | /agent-service/ready | Доступна ли БД |

Чат сначала создаётся через POST /agent-service/chats. Произвольный ID на native URL не создаёт каталог автоматически.
Владение проверяется для чтения, HEAD, отправки и abort; чужие чаты возвращают 404.
В новом чате native history возвращает 404 до первого сообщения — интерфейс показывает пустой диалог.
Архив запрещает новые отправки, сохраняет чтение и остановку; `{"archived":false}` восстанавливает чат.
updatedAt — последнее принятое сообщение или изменение метаданных, а не время генерации ответа.

Raw HTTP body отправки:

```json
{"kind":"user","body":"Привет","idempotencyKey":"уникальный-ключ-доставки"}
```

Публичный endpoint принимает текстовые user messages до 32000 символов, JSON body до 64 KiB.
Поддержаны native uid и idempotencyKey; initialData, signals и вложения через публичный чат не принимаются.
При повторной доставке используйте тот же idempotencyKey и тот же ввод. Новый вопрос получает новый ключ.
202 означает приём, а не готовый ответ. Разрыв SSE не отменяет работу и не требует повторной отправки.
Abort относится ко всей conversation, включая очередь.

Клиент использует `@flue/sdk`: createFlueClient → send → read/observe/history/abort. Для интерфейса
отображайте только user/assistant text parts; reasoning и диагностические parts не являются текстом ответа.
Тестовый CLI выводит текст потоком:

```sh
# Через gateway: AGENT_SERVICE_TOKEN — существующий токен, AGENT_SERVICE_URL — адрес gateway с /agent-service.
npm run chat
npm run chat -- <существующий-chat-id>
```

По умолчанию CLI обращается к http://localhost/agent-service через gateway. Для прямого локального
dev задайте AGENT_SERVICE_URL=http://localhost:5173/agent-service и AGENT_SERVICE_USER_ID (GUID).
В таком режиме CLI передаёт тестовый заголовок вместо токена. Ключ LLM остаётся настройкой модели.

## Фоновые боты

Внутри работающего runtime используйте стандартные init/dispatch Flue. Для ручного локального запуска:

```sh
npx flue run src/agents/company-research.ts --id research-example --message "Переданный контекст компании"
```

CLI загружает .env и db.ts. Не запускайте CLI и сервер одновременно для одной и той же conversation.
У каждого фонового задания должен быть собственный ID; публичных HTTP-маршрутов фоновых ботов нет.
Определения агентов лежат в src/agents, инструкции — в src/instructions, модель — в src/config/model.ts.

## Внутренняя обработка новости

`POST /agent-service/internal/news-analysis` принимает
`{companyId,bankProfileId?,newsMaterialId,newsVersionId,asOf}`. `companyId` — GUID
приложения; `bankProfileId` — отдельный необязательный `U_*`. Технический user ID
или роль Auth не устанавливает компанию, должность и document ACL.

Этот маршрут требует **отдельный** `X-Internal-Secret`. Пользовательский Bearer или
`X-User-Id` его не заменяет. Нужны непустой `INTERNAL_SECRET`,
`COMPANY_SERVICE_URL=http://.../company-service`,
`CONTEXT_SERVICE_URL=http://.../context-service` и
`INSIGHT_SERVICE_URL=http://.../insight-service`; клиенты добавляют `/internal/...`.
Отсутствующая/невалидная новая конфигурация отключает только эту интеграцию с 503.
Секрет не попадает в model input и не пересылается через redirects.

Конечный процесс в `src/news-analysis` проверяет сохранённую квитанцию анализа до
reasoning, читает полный доступный ContextBundle и actual current revisions через
HTTP. Reasoner заменяемый. Этапы выполняются агентами Flue:
`NewsPlannerAgent`, `CompanyConsequencesAgent` и `RoleProjectionAgent` в
`src/agents/news-analysis.ts`. Оркестратор вызывает `init → dispatch → read`;
каждый этап получает отдельную conversation, чтобы контексты компаний и ролей
не объединялись. Инструмент результата имеет Valibot-схему, пишет именованную
data part и возвращает `terminate: true`, завершая успешный этап без второго
запроса для подтверждения. Доменные данные дополнительно проверяются Zod.
Прямых `createModels().complete()` в reasoner нет. `pi-ai` остаётся только в
`src/config/model.ts`: это штатный API custom provider самого Flue для нашего
OpenAI-compatible шлюза, а также зависимость `@flue/runtime`.
Provider-side strict sampling и forced tool choice не заявляются. Один
вызов работает с одной уже выбранной компанией; обход всего реестра моделью здесь
не реализован. Контекст свыше 180 000 сериализованных символов отклоняется с 422
без отсечения документов. Пропуск, ошибка, неструктурированный ответ и upstream
failure не становятся пустым успешным инсайтом. Отдельного прикладного retry/repair
нет; Flue может продолжить модельный turn после ошибки аргументов инструмента.
Результат принимается при ровно одном успешном итоговом вызове за ответ; перед ним агент может вызвать разрешённые сервисные инструменты. Итог должен быть единственным инструментом в своём model turn. Невалидный аргумент допускает штатное исправление Flue; дополнительные успешные итоги отклоняются. Повтор попытки
submission отключён (`maxAttempts: 1`), ожидание ограничено 180 секундами, после
таймаута выполняется durable abort. Транспортные повторы остаются политикой Flue.

`npm run news:worker` поднимает тот же Flue runtime с PostgreSQL (`DATABASE_URL`)
перед запуском обработчика. В Vite/собранном AgentService runtime уже создаётся
Flue, второй runtime внутри обработчиков не запускается. `NEWS_TRACE_DIRECTORY`
сохраняет события conversation вместо сырого ответа отдельного LLM SDK.

Каждый draft содержит `effectKey,literalObjectRef,conclusion,status,sourceRefs` и
необязательное дерево `calculation`. Source refs — точные
`{materialId,versionId,contentHash}` из переданного контекста, включая текущую
news-version. Existing effect сохраняет буквальную identity; actual previous
revision задаёт оркестратор, не модель. InsightService проверяет источники и
атомарно сохраняет весь batch с квитанцией, включая `drafts:[]`. Оставшиеся вне
ответа прежние эффекты не удаляются и не обнуляются. Decimal-арифметика и domain
state принадлежат InsightService; корректность исходных экономических оснований
не следует из успешной записи или расчёта.

Ответ содержит сохранённую квитанцию и `reasoningInvoked`. Повтор версии не
вызывает модель; после следующего исправления возвращает исторические ревизии
этого анализа с `resultSemantics=saved_analysis_revisions_not_latest_heads` и не
откатывает актуальное состояние. Последние heads читаются через InsightService
GET effects. Изменение `asOf`/bankProfileId уже обработанной версии возвращает
конфликт. Внутри одного процесса одинаковые одновременные команды разделяют
выполняемый вызов; распределённый lease между несколькими AgentService не
реализован. Атомарность/идемпотентность хранения остаётся у InsightService.

`tests/news-analysis.test.ts` проверяет маршрут через настоящие HTTP-клиенты и
управляемые upstream servers. `tests/news-reasoner.test.ts` вызывает настоящий
provider adapter через локальный Chat Completions/SSE stub. Это проверка протокола
и состояния, не доказательство качества live-модели или поиска адресатов.

Для отдельного трёхпроцессного HTTP-прогона без рабочей chat-БД:

```sh
node --experimental-strip-types tests/helpers/news-tracer-server.ts
```

Нужны вышеуказанные service URLs/secret и свободный `PORT` (по умолчанию 5183).
Этот **тестовый** entrypoint использует тот же router/orchestrator/HTTP-clients,
но явно управляемый fixture reasoner: `local-contract-104`, `LOT-104`, 104 единицы,
300 → 450 (`v1`) → 360 (`v2`); `v3` возвращает пустой draft batch. Источники и
хэши берутся из настоящего ContextService, revisions сохраняет настоящий
InsightService. Защищённый `GET /__test/reasoning-calls` показывает число вызовов и
`adapter=controlled_fixture_not_live_model`. Этот endpoint и fixture не входят в
production app. Реальные суммы/договоры/полномочия из такого прогона не выводятся.

## Сборка и эксплуатация

### Новостной worker

`npm run news:worker` запускает тот же news flow на `127.0.0.1:5184`, с PostgreSQL для Flue.
Нужны `INTERNAL_SECRET`, `COMPANY_SERVICE_URL` (с `/company-service`), `CONTEXT_SERVICE_URL` (с `/context-service`), `INSIGHT_SERVICE_URL`
(с `/insight-service`) и существующие `LLM_*`. ContextService использует Qdrant и локальный
embedding/reranker sidecar. InsightService разрешает источники через ContextService и хранит
канонические effects, immutable receipts и lease/checkpoint новостных jobs.

`POST /agent-service/internal/news-analysis/events` принимает исходную новость; `/news` ставит
задание по существующей версии материала. `GET /jobs/:jobId` возвращает checkpoint/result.
`completed` означает завершённую обработку, а полнота выбранных областей указана отдельно
в `coverage.completeForSelectedScopes`. Поиск адресатов остаётся `discoveryExhaustive=false`.
Ошибки компаний/роли переводят job в `failed`; внутренний
`POST /insight-service/internal/news-jobs/:jobId/retry` повторяет только неуспешные компании,
сохраняет план и успешные receipts и пересобирает затронутые ролевые проекции.

Групповые итоги используют канонические числа только при совместимых metric/basis/unit/period
и явном sourced aggregation rule. Пропущенный старый эффект сохраняется в InsightService и
перечисляется в `unrevisedEffectIds`, блокируя полный итог. Пустой receipt не доказывает нулевого
вклада. `contextComplete` сохраняется в receipt, включая replay; старое отсутствующее поле
считается неизвестной полнотой. Это полнота набора источников, не доказательство экономического вывода.

Роли получают только source-complete разрешённые facts. Группа передаётся роли целиком только
при разрешении всех компаний, источников и фактов её проекции; узкий grant не раскрывает сводку
других компаний. Membership и право чтения задаёт backend, а не название должности.

`NEWS_TRACE_DIRECTORY` включает локальные traces этапов: conversation ID, `elapsedMs`, события,
provider `usage` и ошибки. Traces содержат предоставленные исходники/ответы; храните их как
служебные данные с тем же доступом. Настроенные LLM/internal/database credentials редактируются.
Нулевая `usage.cost` в custom-provider metadata означает отсутствие настроенного тарифа, не бесплатность вызовов.

Многозапросный `/internal/context/retrieve` имеет HTTP-бюджет 120 секунд: локальный CPU
reranker обслуживает параллельные компании последовательно. Обычные запросы сохраняют
15-секундный бюджет; истечение срока возвращает `UPSTREAM_TIMEOUT`.
Предварительные повторные identities могут быть исправлены финальной проверкой. Дословные
аспекты одного качественного риска компании с `evidenceStatus=unknown` объединяются с
сохранением источников; деньги, договоры и конфликтующие статусы не объединяются.

```sh
npm run typecheck
npm run check
npm test
npm run test:built
npm run build
npm start
```

Production читает переменные процесса, без автоматической загрузки .env. Для ручного запуска с файлом:
`node --env-file=.env dist/service.mjs`. Переменная PORT задаёт порт (по умолчанию 3000).
Артефакту нужны production node_modules, migrations и sql рядом с dist. Dockerfile включает их.
Все прикладные SQL-запросы лежат в sql/chats, sql/migrations, sql/connection и sql/transactions;
TypeScript загружает их при инициализации модулей и передаёт значения параметрами.
Flue обрабатывает завершение процесса и закрывает PostgreSQL pool через адаптер.

Развёртывание — одна реплика. PostgreSQL сохраняет состояние, но не разрешает два живых владельца
одной conversation. При замене процесса исключите перекрытие владельцев; для Kubernetes используйте
стратегию Recreate. Публичную выдачу через отдельный origin настраивает входной proxy; CORS production
здесь не открыт. HTTPS и проверка пользовательских токенов принадлежат входному gateway.

Каталог chats хранит только метаданные. История, принятые submissions и состояние принадлежат Flue;
дублирующей таблицы messages нет. Архивирование не удаляет native-историю.
Логи содержат request ID, метод/маршрут/статус/длительность и квитанции приёма с conversation/submission ID.
Тексты запросов, ответы и токены прикладное логирование не записывает.

## Проверки

Тесты используют PostgreSQL WASM (PGlite), официальный @flue/postgres и тестовый HTTP Chat Completions
endpoint. Проверяются SQL, контекст gateway, владение, архив, пагинация, реальный native SDK/SSE, независимые
диалоги, повторная доставка, остановка, ошибки модели и продолжение после замены runtime.
Тестовые модель и БД не являются fallback рабочего приложения. Ключ реального LLM для тестов не нужен.

`test:built` предварительно собирает сервис и запускает настоящий Node-процесс через TCP с pg.
Проверяет миграции, перезапуск и восстановление принятой работы после аварийного завершения.
Тестовый PG socket использует pool max=1 из-за одной underlying-сессии PGlite; рабочий pool
по умолчанию равен 10 и настраивается DATABASE_POOL_MAX (1–100). Эта проверка не заменяет
проверку Docker-образа или многосессионного обычного PostgreSQL при развёртывании.

Для прогона этих же проверок на обычном PostgreSQL явно задайте TEST_DATABASE_URL — адрес
отдельной проверочной БД. Будет использован настоящий pg pool с 10 соединениями. Проверки
применяют миграции, создают тестовые диалоги и перезапускают только свой дочерний Node-процесс.

`npm run test:live` читает `.env`, собирает сервис и проверяет его на указанной DATABASE_URL
с настоящей моделью из LLM-настроек. Проверяет gateway-контекст, каталог/архив, поток, память
диалога, повторную доставку, изоляцию чатов и запуск трёх фоновых ботов через Flue CLI.
Этот прогон создаёт тестовые чаты и делает реальные обращения к модели; обычный `npm test`
модель не вызывает.

Источники API: [Agents](https://flueframework.com/docs/guide/building-agents/),
[Routing](https://flueframework.com/docs/guide/routing/), [Database](https://flueframework.com/docs/guide/database/),
[SDK](https://flueframework.com/docs/sdk/overview/), [Node](https://flueframework.com/docs/guide/node-target/).
Структура определений и общих настроек ориентируется на [flue-agents](https://github.com/getsentry/flue-agents);
его старый API 0.11 заменён API Flue 2.

### Типизированные инструменты профильных агентов

Три агента `news-planner`, `company-consequences`, `role-projection` сохраняются. Planner получает `news_search_external_publications` (существующие stored/TASS lead search) и `context_search_public_materials`; company — `context_find_company_facts`; чтение точного разрешённого оригинала доступно через `context_read_original`. Роль может читать только версии из уже прошедших host grant-проверку facts. Сервисы выполняют поиск, чтение, хранение и валидацию; смысловой анализ выполняют Flue-агенты.

На этап: максимум 4 реальных сервисных операции, 2 поиска по загруженному корпусу и 2 внешних поиска внутри общего лимита. State/counters/catalog хранятся в `usePersistentState`. Дубликат запроса, отсутствие новых источников или превышение контекста прекращают соответствующий поиск. Фиксированные company/asOf и разрешённый каталог задаёт host. Модель не получает произвольных URL, SQL, credentials или прав записи. Новый источник расширяет source/object handles только после проверенного tool result. Native reasoner не запускает прежний host follow-up по финальному JSON; реальный добор теперь вызывает модель.

`NEWS_SERVICE_URL` — optional base URL существующего WebNewsParserService с `/news-parser-service`. Без него tool возвращает `news_service_not_configured`. Нынешние два API возвращают lead observations, без publisher version/full text. Их observationHash не является source ref оригинала; такие candidates не сохраняются как подтверждённые первоисточники. Подробности работающего контракта и необходимых изменений: [news-source-boundary.md](docs/news-source-boundary.md).

`retrievalLimit` (1–12, optional) в news job ограничивает первоначальный top-k; полный текст выбранных документов не обрезается, а профиль и связанные новые версии могут расширить набор. Context возвращает новейшие известные версии выбранного материала вместе с историческим попаданием. При равном knownAt opaque version IDs не сортируются как время: сохраняются все кандидаты; correction lineage и содержимое проверяет агент. SearchHit.relatedVersions отделяет эти refs от refs старого excerpt.

У новых event imports сохраняется provenance: event_payload, полученная ссылка (если она есть в HTTP import), время получения, полнота текста и исходный ExternalId. Локальные PDF загружаются в Context как uploaded/excerpt с явным locator; автоматическое внешнее получение PDF не заявляется.

### Kafka: получение события и долговечное задание

Consumer принимает текущий `NewsEventMessage` WebNewsParserService из `news-parser.news`: `Source`, `ExternalId`, `Title`, `Text`, `PublishedAt` (также поддержан camelCase). `Text` может быть пустым: upstream заполняет его из Subtitle. Материал сохраняется как `event_payload/lead`, без выдуманных URL и версии издателя.

Для включения задайте `NEWS_KAFKA_ENABLED=true`, `KAFKA_BROKERS=host:port` (несколько через запятую), существующие `INTERNAL_SECRET`, `COMPANY_SERVICE_URL`, `CONTEXT_SERVICE_URL`, `INSIGHT_SERVICE_URL` и конфигурацию модели. Все экземпляры используют один стабильный `NEWS_KAFKA_GROUP_ID` (default `agent-service-news-v1`), отдельный от других потребителей. `NEWS_KAFKA_TOPIC` default `news-parser.news`; `NEWS_KAFKA_FROM_BEGINNING=true` читает историю только при отсутствии сохранённого offset группы. Broker address должен быть доступен из контейнера/процесса AgentService, включая адреса из advertised listeners. TLS/SASL переменные перечислены в [.env.example](.env.example).

Порядок: Kafka → точная версия материала в ContextService → долговечное news job в InsightService → ручной commit следующего offset → фоновый Flue-анализ → сохранённый инсайт. Подтверждение Kafka означает сохранённое задание; его завершение проверяется через `/internal/news-analysis/jobs/:id`. Повторная доставка использует прежнее время наблюдения и job ID. Ошибка backend/commit оставляет событие для повторной обработки. Это at-least-once доставка с идемпотентной записью.

Невалидный JSON/контракт или постоянный отказ ingress приостанавливает раздел без commit и без пропуска следующих записей. `/agent-service/ready` возвращает 503; защищённый `GET /agent-service/internal/news-analysis/kafka` показывает topic/partition/offset/hash и состояние consumer. Полный payload и секреты в логи consumer не выводятся. Оператор устраняет причину и перезапускает consumer; невалидную запись необходимо отдельно разобрать и согласованно исправить/карантинировать до возобновления. Автоматического DLQ или пропуска нет; один перезапуск не исправит невалидную запись.

`npm start` и Docker запускают `dist/service.mjs`: он дожидается остановки news consumer, затем Flue. Сгенерированный Flue `dist/server.mjs` не используется как entry сервиса.

Правила идентичности бизнес-вопроса, unknown/conditional, бюджетов и фактической глубины: [news-mechanism-rules.md](docs/news-mechanism-rules.md).

Границы TypeScript-модуля, владельцы admission/lease/company execution/projections,
импорты для интеграции и автоматическая проверка зависимостей:
[news-analysis-architecture.md](docs/news-analysis-architecture.md).

Текущий протокол: отдельный реестр сигналов, повторное использование по версии источника, полный ОКВЭД, проверка тематической связи собственных документов и автоматический OCR — [правила механизма](docs/news-mechanism-rules.md).
### Внешний HTTPS origin

Если TLS завершается на nginx, задайте `PUBLIC_ORIGIN=https://api.cheremha.ru`.
Сервис использует этот origin для native absolute URLs, включая streamUrl квитанции.
Пути, query string и тело запроса сохраняются; forwarded-заголовки клиента не
определяют origin. При отсутствии настройки используются исходные URLs запроса,
как при локальной HTTP-разработке. Значение должно содержать только HTTP(S) origin
без credentials, пути, query string или fragment.
