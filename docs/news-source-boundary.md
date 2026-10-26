# Контракт внешних материалов

Новый Kafka ID adapter по parser `f20738c` описан отдельно: [Kafka reference → admission](kafka-parser-news-id.md). Таблица ниже фиксирует исторический контракт `558025d`; поиск discovery и новый Kafka admission имеют разные пределы.

Адаптер AgentService использует перечисленные ниже методы WebNewsParserService.

## Уже существующий контракт

| Возможность | Работающий контракт по коду | Практический предел |
|---|---|---|
| Поиск сохранённых новостей | GET `/news-parser-service/internal/news/search?search=...&limit=...` → `Source,ExternalId,Title,Text,PublishedAt` | Поиск title/text в Mongo, свежие первыми. Нет URL, StoredAt, исходной версии и полноты текста в ответе. |
| Внешний поиск TASS | GET `/news-parser-service/internal/news/tass-search?search=...&limit=...` → `ExternalId,Title,Lead,Url,PublishedAt` | Реальный proxy через ITassClient, без сохранения; 503 при недоступности. Lead не является полным оригиналом. |
| Фоновая лента и событие | TASS worker → Mongo → Kafka `news-parser.news`; `NewsEventMessage(Source,ExternalId,Title,Text,PublishedAt)` | `Text = item.Subtitle`. Уникальная пара Source/ExternalId не даёт истории исправлений: TryAdd пропускает уже имеющийся ID. |

Основания: [контроллер](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Controllers/NewsInternalController.cs), [NewsService](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Services/NewsService.cs), [Mongo repository](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Repositories/NewsRepository.cs), [Kafka DTO](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/Api/Contracts/Kafka/NewsEventMessage.cs), [README источников](https://github.com/AlfaHackathon/WebNewsParserService/blob/558025d07358723550fbc5991f8212411ce08293/README.md). RBC и Alfa указаны как TODO; из этого не следует поддержка их исследований или PDF.

Все internal методы используют X-Internal-Secret. `NEWS_SERVICE_URL` задаёт base URL с префиксом, секрет остаётся в окружении. В model tools нет произвольного HTTP или URL для загрузки. Внешний поиск доступен только planner, который получает публичную новость и публичные материалы; company/role banking context в него не передаётся.

## Поведение адаптера

Flue planner может вызвать `news_search_external_publications` с channel stored/tass. Адаптер возвращает исходные поля, ссылку когда она дана, observedAt, publishedAt, `textCompleteness=lead`, `originVersion=null`, observationHash и явные capabilities=false для fullText/publisherVersions/corrections/alfaResearch. Повтор такой же наблюдаемой выдачи даёт тот же observationHash, изменение lead — другой hash. Это проверка конкретного наблюдения, а не назначение версии оригиналу.

Ответ фильтруется по publication time относительно asOf, но время первоначального получения parser API не раскрывает. Поэтому результат остаётся **discovery candidate**, его нельзя цитировать как загруженный точный оригинал или исторически известное банковское основание. Он автоматически не записывается в ContextService. Такой предел предотвращает появление второго владельца версий оригинала.

Company agent получает `context_find_company_facts` и `context_read_original` для реально загруженных разрешённых версий. Planner также получает `context_search_public_materials`. Role agent читает точные версии только из уже разрешённых host-ом facts. Новые sources/objects выдаются как typed handles; backend продолжает проверять refs, canonical writes, арифметику и состояние. Сервисы не являются самостоятельными LLM-аналитиками.

ContextService сохраняет provenance для новых импортов и загрузок: acquisition, sourceUrl, retrievedAt, textCompleteness, originVersionId, locator. `uploaded` отмечает предоставленный PDF, включая конкретную страницу/OCR. `event_payload` обозначает приём события с текущим неполным контрактом. `news_service` допускает сохранение исходного versionId, но сам такой upstream API пока отсутствует. Старые записи не переписаны.
