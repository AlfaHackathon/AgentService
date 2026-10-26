# Ограниченная обратная связь для исправления schema errors

Наблюдавшийся сбой: company-proposal вернул строки `"null"` вместо JSON `null` в category. Валидация их правильно отвергла. pi-ai 1.3.0 добавил в текст ошибки полный повтор аргументов; следующий запрос превысил локальные 65536 UTF-8 bytes до транспорта.

## Изменение

Проекция перед OpenAI provider API (`stream` и `streamSimple`) сокращает только известную форму SDK schema error для news result tools. Проверяются isError, имя инструмента, ID предшествующего assistant call, точный prefix/separator и структурное равенство повторённых JSON arguments исходному call. Неизвестный формат, неверный ID/name, несовпадающий JSON, обычная ошибка сервиса или domain 422 остаются неизменными.

Текст такой ошибки заменяется диагностикой до 512 UTF-8 bytes: representative issue на каждый путь, число исходных issues и явная отметка пропущенных подробностей. Полная schema уже находится в tools. Union errors одного пути не дублируются. При избытке diagnostics список ограничивается; это ограничение текста ошибки, а не исходных фактов.

Не изменяются полные оригиналы, quotes, identity/catalog/handles, previous questions, условия, unknowns и исходный assistant tool call с неверными arguments. Durable history/trace сохраняет исходную ошибку; сокращается только outbound model projection. Строка `"null"` не преобразуется; модель должна явно отправить исправленный tool call. Validation, максимум submissions, budget/byte guards и ACL сохранены. SDK/node_modules не изменяются.

## Проверки и границы

Native fake-provider regression с включёнными company service tools: context 4755 bytes, previousQuestions 15326, весь phase input 22643, неверные arguments 13125 bytes. Это synthetic model-shape fixture, близкий к измеренному runtime breakdown; это не копия remote payload. Проверяется весь сериализованный HTTP body, включая system/tools/assistant arguments. Первый wire запрос — 51186 bytes, исправление — 65510 bytes при включённых service tools (без проекции этот механизм воспроизведён как oversized). Более тяжёлый вариант с arguments 17349 bytes остаётся ошибкой по тому же 65536-byte guard; все evidence и unknowns сохранены, JSON null принимается только после явной исправленной отправки.

Отдельные fixtures проверяют остальные news result tools, negative cases, Unicode, неизменность transcript и оба provider API. Эта мера не гарантирует, что любой полный context и любой ответ модели поместятся в 64 KiB: runtime wire guard остаётся обязательным. При изменении SDK error format проекция оставляет исходную ошибку, а не обрезает произвольные данные.

Ранее выявленный повтор originals при context_read_original исследован в отдельном локальном worktree и не включён в этот patch: он не является подтверждённой причиной последнего сбоя. Live модели не запускались, job/revision/history не исправлялись вручную. Exact synthetic fixture теперь получен и проверен по исходному SHA256. Replay выявил, что schema-feedback fix отдельно всё ещё даёт65606 bytes; необходим также historical-reference projection. Подробности и границы — в news-exact-correction-replay.md.

Дополнительный аудит фаз: 6 native fixtures / 9 HTTP запросов. Planner 11327 bytes, relevance 6108, extraction/review 7404/10340, legacy segments 15297/16359, inventory segments 14381/15852, role 5140. В пределах этих bounded fixtures неожиданных повторов полных originals нет; повторные цитаты review необходимы и сохраняются. Inventory segments по действующему контракту используют проверенные quotes вместо полного market text. Это не заявление о гарантии semantic recall или размера произвольных данных.
