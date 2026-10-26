# Исторические refs в model-facing previousQuestions

Дополнение к frozen schema-feedback fix e74331f. Оно не изменяет тот commit и ещё не опубликовано.

Загруженные exact refs уже представлены s*-handles. Повторяющиеся незагруженные materialId/versionId/contentHash в previousQuestions и их conditions/applicability допускают отдельную lossless упаковку: unavailableReferenceCatalog с u*-aliases и availability=not_loaded. Уникальные незагруженные refs сохраняют прежний inline формат. Две версии или разные hash не объединяются.

u* не добавляется в sourceCatalog, SDK enum sourceHandles, host scope или разрешения. Это ссылки на identity отсутствующего в текущем phase оригинала, а не новые доказательства. Попытка цитировать u0 отвергается. Для новых подтверждений необходим обычный разрешённый retrieval/read; оригинал нельзя восстановить из ID.

Не меняются question handles/identity/literalObjectRef, conclusions, conditions/dependsOn, applicability/assumptions, unknowns, тексты оригиналов и исходный input. Host companyScope/questions сохраняет полные typed refs. Proposed drafts, importance и toolTrace сохраняют прежнюю упаковку; этот slice относится только к previousQuestions.

Каталог выбирается только при уменьшении UTF-8 размера JSON-escaped model content с учётом дополнительной инструкции. Если накладные расходы больше экономии, сохраняется прежний wire shape. Никаких обрезок истории, эвристического сокращения текстов, повышения 65536-byte guard или coercion значений.

Model-free native fixtures: proposal+final с двумя историческими versions/hashes, смешанные loaded/unloaded refs; все questions/unknowns/conditions восстановимы. u0 в sourceHandles получает schema error, затем explicit corrected submission. Дополнительно проверены unique-ref fallback, overhead fallback и mixed inline/catalog applicability при неизменном nonhistorical toolTrace.

Стресс-fixture использует 5 исторических вопросов с повторяющимися refs. Экономия относительно восстановленного inline encoding больше 14 KiB (с консервативным резервом512bytes на инструкцию); это реконструкция serialised wire, не замер remote payload. Исходный schema-feedback fixture, где исторических refs нет, НЕ получает экономии и остаётся с запасом26bytes. Exact fixture теперь проверен: combined correction 64227 bytes (запас 1309), тогда как frozen-only 65606 bytes не проходит. Это заново сериализованный SDK body с retained данными; исходный historical HTTP body не сохранялся. См. news-exact-correction-replay.md.

LLM calls0, новых окружений0, production writes0. Публикация и deployment не выполняются; frozen e74331f остаётся отдельным кандидатом.
