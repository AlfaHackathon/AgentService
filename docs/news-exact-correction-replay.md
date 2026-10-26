# Exact-data correction replay без моделей

Исходный SYNTHETIC-CORRECTION-SIZE-FIXTURE.json: 128134 bytes, SHA256 432a6ee87d97b12ab9b7668aca2476e76956f9771da4d900784a715beeff2d41. CORRECTION-SIZE-BREAKDOWN.json: 3551 bytes, SHA256 e6e3b5ec35e2fb743219cee348c79e74717e00eb15319447db19c748c1108fc6. Данные целиком синтетические; producer выполнил secret audit. Оба исходных файла проверены и сохранены с Library identity/version. В tests/fixtures/exact-company-proposal-correction.json включены только необходимые retained значения и проверочные hashes; Library IDs, transfer URLs и remote filesystem paths туда не переносятся.

## Что воспроизведено

Retained native input 22261 UTF-8 bytes и arguments 13116 bytes восстановлены без изменения содержимого. Fixture-only containers восполняют storage metadata, не участвующие в model projection; до исправления regenerated native text совпал байт-в-байт с retained text. Сгенерированная SDK schema error также совпала с retained error 16449 bytes. Первый fake model ответ содержит категории risk, строку "null", строку "null". Вторая явно исправленная fake submission содержит JSON null; production не выполняет coercion.

Измеряется полный JSON HTTP body после настоящей SDK сериализации, включая system, tools, user context, assistant arguments и tool feedback; HTTP headers не входят в этот размер. Installed SDK: @flue/runtime 2.3.0, pi-ai 1.3.0. Fake OpenAI provider model=test-model, maxTokens=8192, contextWindow=128000, reasoning=off; company service tools включены. Все transport вызовы идут только на localhost. Никаких настоящих service/model credentials или запросов к runtime.

| Источник кода | Initial body | Correction body | Итог |
| --- | ---: | ---: | --- |
| PR20 tree 2cc80ca586cbc7d7efc0ce978d616e087222c740 | 51305 | 82537 | rejected >65536 |
| schema feedback e74331f | 51305 | 65606 | rejected, превышение 70 bytes |
| feedback + historical refs 19bb963 | 49926 | 64227 | accepted 3 drafts, запас 1309 bytes |

В exact fixture 13 повторов 3 unloaded identities. Historical projection уменьшает native input 22261→20747 bytes; обратная проекция восстанавливает все исходные значения, включая originals, question identities, conditions/dependsOn, assumptions, unknowns и source refs. s*-grants не расширяются. Correction error 341 bytes вместо 16449. Ответы сохраняют все 3 conclusions/statuses/unknowns/source bindings, calculations не придумываются.

## Постоянная регрессия

`npm test -- tests/news-exact-correction.test.ts` использует обычный in-process runtime и localhost fake HTTP provider. Проверяются hashes retained input/arguments, обратимость aliases, отсутствие silent coercion, сохранение предыдущих assistant arguments, explicit corrected submission, 3 полных drafts и полный body <= 65536−1024. Дополнительный резерв 1024 bytes — acceptance теста; runtime guard остаётся 65536 и не ослабляется.

## Границы доказательства

Оригинальные historical HTTP bodies и top-level provider options не были сохранены; точные размеры четырёх прошлых local denials восстановить нельзя. Таблица — новый model-free replay exact retained данных на установленном SDK с явно указанными test provider options. Реальный endpoint/model alias и неизвестные дополнительные options не выдаются за сохранённые. Размер body не равен token context budget. SDK/config изменения требуют повторного wire test.

Это подтверждает исправление обнаруженного механизма для retained случая. Это не live LLM quality/full-flow PASS. General/company job state, прошлые revisions/history и разрешения не менялись; budget 78/78 остаётся закрытым. Frozen-only e74331f отдельно развёртывать нельзя. Перед будущим запуском нужен combined tree и пересборка scoped runner, использующего обновлённый createModelProvider. Публикация/merge/deploy выполняются отдельно после координации; cloud их не выполнял.
