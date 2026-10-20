# Проверка локального стенда — 20 октября 2026

## Стенд

- Обычный PostgreSQL 18.6 из Ubuntu WSL, отдельный кластер `/tmp/alfahack-agent-service/data`.
- Адрес БД с Windows: `127.0.0.1:55432`, база `agent_service`, пользователь `agent`.
- Существующий PostgreSQL WSL на 5432 не изменялся.
- AgentService: http://127.0.0.1:3000/agent-service.
- Реальная модель: `gpt-6-luna`, endpoint `https://cliproxy.cheremha.ru/v1`.
- Подключения сохранены в локальном `.env`, исключённом из Git. Секреты в отчёт не включены.
- БД и сервис оставлены запущенными после проверки. Это локальный проверочный стенд;
  каталог данных находится в WSL `/tmp`, не является production-хранилищем и не имеет автозапуска.

## Результаты

| Проверка | Результат |
|---|---|
| Production build | Успешно |
| TypeScript typecheck | Успешно |
| Biome | Успешно |
| Обычный набор `npm test` | 17 из 17 |
| Собранный Node-сервис с обычным PostgreSQL, pool max=10 | 2 из 2 |
| Сервис с настоящей gpt-6-luna | 5 из 5 |
| Регрессия CLI при завершении stdin | 1 из 1 |
| Health/readiness оставленного процесса | HTTP 200, ok/ready |

Всего 25 автоматических проверок. На реальной модели проверены поток ответа,
продолжение диалога с запоминанием случайного маркера, изоляция второго чата и native
idempotencyKey. Через настоящий Flue CLI с этой же моделью выполнены CompanyResearchAgent,
InsightAgent и ScenarioAgent. Также проверены gateway-контекст, владение, изменение и архив чатов.

При проверке пользовательского CLI обнаружен ERR_USE_AFTER_CLOSE после получения ответа при EOF
на stdin. Исправлено повторное приглашение закрытой консоли: состояние закрытия теперь учитывается
перед prompt. Добавлен тест, воспроизводивший ошибку до исправления; после исправления тест прошёл.
Исходный запуск через pipe повторён на работающем сервисе с реальной моделью: ответ «работает», exit 0.

На обычном PostgreSQL отдельно проверены миграции, SSE, сохранение истории после перезапуска,
принудительное завершение процесса с активным и ожидающим сообщениями и их последующее
восстановление без повторной отправки клиентом. В этой проверке используется управляемый
тестовый LLM endpoint, чтобы воспроизводимо остановить выполнение перед сбоем.

Первоначальные HTTP-проверки передавали X-User-Id по контракту AuthGateway.
20.10.2026 дополнительно запущена реальная цепочка nginx 1.30.6 (:8088) → AuthGateway
на YARP 2.3.0 (:5080) → AgentService (:3000) → PostgreSQL и gpt-6-luna.
Пройдены 3 теста middleware Gateway и 2 сквозных теста `cluster/tests/agent-sse.mjs`:
поддельный identity без токена, чужая подпись JWT и доступ к чужому чату отклоняются;
admission содержит внешний streamUrl; SSE приходит 15 порциями за ~7 секунд
(175 text deltas), повторная отправка дедуплицируется, работают replay, история и abort.
В nginx для стенда изменены только Docker DNS, upstream и порт; настройки SSE взяты
из `cluster/nginx/nginx.conf`. Изменения Gateway и cluster находятся в отдельных
ветках `codex/agent-service-sse` от dev, без слияния.
В первоначальном прогоне Gateway пакет AlfaHackaton.Auth 1.3.0 был собран из
исходников организации: GitHub Packages отвергал доступный OAuth-токен с HTTP 403.
Этот прогон не подтверждает совместимость опубликованного NuGet-артефакта.
Локальный feed, архив пакета и его старые сборки удалены. С PAT classic выполнен
повторный restore в новый пустой кеш с `--no-http-cache --force`: источник пакета
в `.nupkg.metadata` — `https://nuget.pkg.github.com/AlfaHackathon/index.json`.
На опубликованном пакете заново прошли 3 теста Gateway и Release build без
предупреждений, затем 2 сквозных теста через nginx. Новый SSE-прогон получил
12 порций / 145 text deltas за ~5 секунд. Запущенный Gateway использует эту сборку.
Docker-образ не проверен: установленный Docker Desktop падает на инициализации Inference manager
с ошибкой Unix socket `dockerInference`. Системные настройки Docker не менялись; сервис проверен
как собранный Node-процесс с обычным PostgreSQL, без подмены БД на PGlite.

## Использование

Из каталога AgentService:

```powershell
npm run chat
```

В локальном `.env` CLI настроен на работающий порт 3000 и тестовый пользовательский GUID.
Прямой X-User-Id используется для локальной проверки; вход кластера остаётся через AuthGateway.

Проверка готовности:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/agent-service/ready
```

Обычный повторный запуск сервиса в терминале:

```powershell
node --env-file=.env dist/server.mjs
```

Запускайте его после остановки прежнего экземпляра: две копии runtime для одной conversation
не должны работать одновременно. PID текущего фонового Node-процесса записан в
`.test-data/service.pid`, stdout/stderr — в `.test-data/service.stdout.log` и
`.test-data/service.stderr.log`. Для остановки текущего фонового экземпляра:

```powershell
$agentProcessId = [int](Get-Content .test-data/service.pid)
Get-Process -Id $agentProcessId
Stop-Process -Id $agentProcessId
```

Проверка, остановка и запуск именно отдельного проверочного PostgreSQL:

```powershell
wsl -d Ubuntu -u postgres -- /usr/lib/postgresql/18/bin/pg_ctl -D /tmp/alfahack-agent-service/data status
wsl -d Ubuntu -u postgres -- /usr/lib/postgresql/18/bin/pg_ctl -D /tmp/alfahack-agent-service/data -m fast -w stop
wsl -d Ubuntu -u postgres -- /usr/lib/postgresql/18/bin/pg_ctl -D /tmp/alfahack-agent-service/data -l /tmp/alfahack-agent-service/server.log -o "-h 127.0.0.1 -p 55432 -k /tmp/alfahack-agent-service" -w start
```

Полный повтор живых проверок: остановить обычный AgentService, затем `npm run test:live`.
