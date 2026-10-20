# AgentService

Основание агентного сервиса AlfaHackathon: TypeScript, Node 24, Flue 2.3, Hono и PostgreSQL.
Четыре бота определены в коде. Пользователь общается с ClientAssistantAgent; CompanyResearchAgent,
InsightAgent и ScenarioAgent зарегистрированы для внутреннего запуска. Все работают с содержимым
своих диалогов. Внешние инструменты и предметные интеграции пока не подключены.

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

## Сборка и эксплуатация

```sh
npm run typecheck
npm run check
npm test
npm run test:built
npm run build
npm start
```

Production читает переменные процесса, без автоматической загрузки .env. Для ручного запуска с файлом:
`node --env-file=.env dist/server.mjs`. Переменная PORT задаёт порт (по умолчанию 3000).
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

Фактический локальный прогон и команды управления стендом: [docs/local-verification.md](docs/local-verification.md).

Источники API: [Agents](https://flueframework.com/docs/guide/building-agents/),
[Routing](https://flueframework.com/docs/guide/routing/), [Database](https://flueframework.com/docs/guide/database/),
[SDK](https://flueframework.com/docs/sdk/overview/), [Node](https://flueframework.com/docs/guide/node-target/).
Структура определений и общих настроек ориентируется на [flue-agents](https://github.com/getsentry/flue-agents);
его старый API 0.11 заменён API Flue 2.
