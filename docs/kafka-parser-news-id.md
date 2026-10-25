# Kafka news ID → parser GET → Context admission

Source contract проверен по WebNewsParserService `f20738c37b448b720b3a2e3c3f0b206c9f12f5cd`. Это внутренний ingress adapter AgentService; новых публичных маршрутов, parser изменений, прав доступа и модельных вызовов он не добавляет.

## Вход и чтение

Новый Kafka envelope в `news-parser.news`:

```json
{"Source":"Tass","Id":"0123456789abcdef01234567"}
```

Также принимается целиком camelCase `{source,id}`. Source — Tass/Rbc/Alfa (case-insensitive validation); смешанные/лишние routing/company поля отвергаются. Id — ровно 24 hex-символа Mongo ObjectId, в HTTP path приводится к lowercase. Это НЕ publisher ExternalId, Context materialId или версия публикации. Kafka payload ограничен существующим 1 MiB.

При обработке reference consumer вызывает injected reader:

```http
GET ${NEWS_SERVICE_URL}/internal/news/{id}
X-Internal-Secret: <existing service credential>
Accept: application/json
```

`NEWS_SERVICE_URL` — существующий configured base с префиксом, например `http://web-news-parser-service:8080/news-parser-service`. URL берётся только из server configuration, не из Kafka/model/client. Запрещены credentials/query/fragment в base URL; redirects не выполняются. Права/секрет берутся из существующей service-to-service границы; Bearer пользователя сюда не передаётся.

Ожидаемый ответ parser:

```json
{"source":"Tass","externalId":"publisher-id","title":"News title","text":"","publishedAt":"2026-10-25T00:00:00Z"}
```

Проверяются source и его соответствие Kafka reference, непустые bounded publisher ID/title, text <=200000 символов, timestamp. Source comparison case-insensitive, но для admission сохраняется исходное spelling Kafka Source: adapter не меняет молча историческую identity. Расхождение source — отказ. Дополнительные поля parser DTO не превращаются в доверенные version/completeness/URL.

## Admission и ack

Reader формирует существующий normalized payload:

```text
{source, externalId, title, text, publishedAt, textCompleteness:"lead"}
```

Mongo ID сюда не переносится. Источником `externalId` служит ответ parser, а не Mongo ID. Далее используется неизменённый `NewsFlow.ingest`:

1. `POST /context-service/internal/news/admit` сохраняет точную наблюдаемую версию и возвращает newsMaterialId/newsVersionId/asOf.
2. `POST /insight-service/internal/news-jobs` сохраняет durable job на этих IDs.
3. Только после обоих успешных шагов и проверки актуальности Kafka batch выполняется commit offset+1.

Resolver находится под существующим consumer heartbeat. При утрате batch/heartbeat во время чтения новое admission не начинается; незавершённая/неопределённая доставка не подтверждается. Broker ack failure оставляет возможность повторной доставки; Context/job сохраняют существующую дедупликацию одинакового admission content. Локальный wire test исполняет реальные NewsFlow/Context/Job clients с fake HTTP dependencies и блокирует worker.start, поэтому он не запускает анализ.

Старые полные envelope `{Source,ExternalId,Title,Text,PublishedAt}` и camelCase остаются совместимыми для replay. Для них parser GET не выполняется; source spelling и прежняя identity не переписываются.

## Ошибки и бюджеты

Parser GET: максимум 3 попытки, 5 секунд на попытку с общим deadline 15 секунд, backoff 250/500 ms. Network/timeout, 408, 429 и 5xx допускают ограниченный retry. Размер HTTP body проверяется потоком до JSON parse: максимум 1 MiB, независимо от Content-Length. Нет общей изменяемой deadline между сообщениями.

- Некорректный Kafka ID/envelope: существующее `INVALID_EVENT`, partition paused, ack отсутствует.
- Нет configured reader для нового envelope: `INGRESS_REJECTED`, ack отсутствует. Legacy-only режим без NEWS_SERVICE_URL сохраняется; для новых references URL обязателен.
- Parser 401/403, 404, несовместимый DTO/source или oversized/invalid JSON: постоянный ingress rejection, partition paused без ack. После исправления конфигурации/источника нужен контролируемый restart/recovery consumer; сообщения не пропускаются автоматически.
- Transient read failure после retry budget: sanitized `PARSER_NEWS_UNAVAILABLE`, без ack; broker replay остаётся возможен. Не печатаются secret, payload и raw upstream error/body.
- Context/job failure и неизвестный результат ack используют прежнюю durable admission/replay семантику.

## Честные ограничения источника

Текущий parser GET не сообщает completeness, StoredAt, immutable publisher version, correction relation или URL. Поэтому текст остаётся **lead contract**, даже если фактически был scraped full body. Пустой text допускается. Mongo ID не назначается material/version ID; версия появляется только после Context admission. Это версия наблюдения, не доказательство publisher version или текста на момент Kafka event.

Mongo документ изменяемый: повторное чтение того же Id может вернуть другое содержание. Если оно изменилось между неизвестным исходом обработки и replay, может появиться новая Context version/job. Гарантируется at-least-once admission наблюдаемого content; exactly-once historical snapshot по Mongo reference текущий producer/API не обеспечивают. Adapter не выдумывает исправления и не скрывает это ограничение.

## Release / rollback

- Parser GET должен быть доступен на существующем внутреннем ingress (source ref выше); backend configuration NEWS_SERVICE_URL + существующий INTERNAL_SECRET должны совпадать.
- Kafka включается только существующим `NEWS_KAFKA_ENABLED=true` по решению release owner. Этот patch сам ничего не включает, не запускает SourceChangePump/consumer и не меняет broker offsets.
- Без новых migrations/dependencies/ports/ACL. Agent-only deployment; Context admission и Insight job APIs прежние.
- Откат к старому Agent снова делает новые двухполевые references неподдерживаемыми: они будут blocked без ack. Offset reset/skip не является частью rollback.
- Это закрывает ingress adapter, не подтверждает live Kafka/full NewsFlow качество. Проверки в этой ветке model-free, unit fixtures; production не трогается.
