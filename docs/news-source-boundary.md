# Граница внешних материалов и фактическая готовность

Код проверен 23.10.2026 на commit `558025d07358723550fbc5991f8212411ce08293` репозитория AlfaHackathon/WebNewsParserService. Локальная копия `.scratch/reference-WebNewsParserService` прочитана без изменений. Адаптер AgentService использует только перечисленные ниже существующие методы; публикации, деплоя и изменений WebNewsParserService не было.

## Уже существующий контракт

| Возможность | Работающий контракт по коду | Практический предел |
|---|---|---|
| Поиск сохранённых новостей | GET `/news-parser-service/internal/news/search?search=...&limit=...` → `Source,ExternalId,Title,Text,PublishedAt` | Поиск title/text в Mongo, свежие первыми. Нет URL, StoredAt, исходной версии и полноты текста в ответе. |
| Внешний поиск TASS | GET `/news-parser-service/internal/news/tass-search?search=...&limit=...` → `ExternalId,Title,Lead,Url,PublishedAt` | Реальный proxy через ITassClient, без сохранения; 503 при недоступности. Lead не является полным оригиналом. |
| Фоновая лента и событие | TASS worker → Mongo → Kafka `news-parser.news`; `NewsEventMessage(Source,ExternalId,Title,Text,PublishedAt)` | `Text = item.Subtitle`. Уникальная пара Source/ExternalId не даёт истории исправлений: TryAdd пропускает уже имеющийся ID. Готового consumer bridge в AgentService не добавлено. |

Основания: [контроллер](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Controllers/NewsInternalController.cs), [NewsService](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Services/NewsService.cs), [Mongo repository](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Repositories/NewsRepository.cs), [Kafka DTO](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Contracts/Kafka/NewsEventMessage.cs), [README источников](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/README.md). RBC и Alfa указаны как TODO; из этого не следует поддержка их исследований или PDF.

Все internal методы используют X-Internal-Secret. `NEWS_SERVICE_URL` задаёт base URL с префиксом, секрет остаётся в окружении. В model tools нет произвольного HTTP или URL для загрузки. Внешний поиск доступен только planner, который получает публичную новость и публичные материалы; company/role banking context в него не передаётся.

## Что реализовано в доступных рабочих деревьях

Flue planner действительно может вызвать `news_search_external_publications` с channel stored/tass. Адаптер возвращает исходные поля, ссылку когда она дана, observedAt, publishedAt, `textCompleteness=lead`, `originVersion=null`, observationHash и явные capabilities=false для fullText/publisherVersions/corrections/alfaResearch. Повтор такой же наблюдаемой выдачи даёт тот же observationHash, изменение lead — другой hash. Это проверка конкретного наблюдения, а не назначение версии оригиналу.

Ответ фильтруется по publication time относительно asOf, но время первоначального получения parser API не раскрывает. Поэтому результат остаётся **discovery candidate**, его нельзя цитировать как загруженный точный оригинал или исторически известное банковское основание. Он автоматически не записывается в ContextService. Такой предел предотвращает появление второго владельца версий оригинала.

Company agent получает `context_find_company_facts` и `context_read_original` для реально загруженных разрешённых версий. Planner также получает `context_search_public_materials`. Role agent читает точные версии только из уже разрешённых host-ом facts. Новые sources/objects выдаются как typed handles; backend продолжает проверять refs, canonical writes, арифметику и состояние. Сервисы не являются самостоятельными LLM-аналитиками.

ContextService сохраняет provenance для новых импортов и загрузок: acquisition, sourceUrl, retrievedAt, textCompleteness, originVersionId, locator. `uploaded` отмечает предоставленный PDF, включая конкретную страницу/OCR. `event_payload` обозначает приём события с текущим неполным контрактом. `news_service` допускает сохранение исходного versionId, но сам такой upstream API пока отсутствует. Старые записи не переписаны.

## Необходимое изменение upstream — предложение, не готовый API

До получения полного требуемого сценария WebNewsParserService должен стать владельцем неизменяемого оригинала публикации и его версий. Конкретные изменения по нынешнему коду:

- Дополнить хранимый материал и выдачу явными original URL, publication time, retrieval time, completeness full/lead/excerpt/unknown, media type и source kind (news/author analysis/forecast). Позиция аналитика сохраняет автора и дату; прогноз не превращается в факт результата компании.
- Ввести стабильную идентичность материала у источника, opaque immutable versionId и contentHash точного полученного оригинала. Исправление должно ссылаться на действительную предыдущую версию. Нынешний unique Source/ExternalId и ранний return в TryAdd нужно заменить версионной моделью с идемпотентностью доставки.
- Предоставить разрешённое чтение **точной версии** и ограниченный поиск/добор первоисточника через этот сервис, с честным unavailable/not_found/lead_only. Endpoint names этого будущего контракта здесь не назначаются.
- Добавить отдельные реально реализованные адаптеры публичной аналитики/прогнозов и разрешённых PDF. Нынешний TASS proxy не считается их поддержкой. Предоставленные локальные PDF продолжают идти через upload материалов.
- Расширить event/outbox контракт точными source/version/provenance полями и согласовать подтверждение доставки. Только после этого подключать Kafka consumer; существующий POST `/events` не объявляется Kafka bridge.
- ContextService хранит/индексирует проекцию той же source material/version, не создаёт независимый номер оригинала. InsightService получает exact refs и ведёт вопросы/зависимости/пересмотр; AgentService ведёт долговечную оркестрацию и смысловой анализ через инструменты.

Эти изменения WebNewsParserService не внесены и не задеплоены. Текущий разрешённый объём изменений — AgentService/ContextService/InsightService. Для живого вызова имеющихся lead-search методов также нужен адрес запущенного сервиса; он был запрошен, но в текущем окружении не задан. Docker daemon, локальные parser/Mongo/Kafka не запущены. Проход Flue → HTTP-контракт проверен обычным тестом с контролируемым ответом, а не выдан за обращение к работающему внешнему источнику.
