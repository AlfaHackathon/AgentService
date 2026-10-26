# Проверка полноты final и компактный review context

Source fix поверх Agent master `3b03db9`. Это изменение producer admission и model prompt; публичные API, Insight persistence, parser и frontend не меняются.

## Final calculation

Воспроизведён случай: proposal содержал расчёт эффекта, final сохранял тот же денежный вопрос и forecast с суммой в conclusion, но опускал calculation. Optional calculation в общем legacy DTO остаётся совместимым; проверка final теперь сопоставляет точный `businessQuestionKey(literalObjectRef, question)` с typed preliminary drafts.

Если retained количественный вопрос имел proposal calculation, final обязан явно вернуть итоговый calculation. Разрешено исправить выражение: байтовое равенство формул не требуется. Формула из proposal автоматически не копируется. Можно полностью отозвать предварительный draft либо явно отказаться от оценки: `status=unknown`, `impact.evidenceStatus=unknown` и непустые structured `assessment.unknowns`. Такой отказ должен иметь честный качественный conclusion. `FINAL_CALCULATION_REQUIRED` — исправляемая 422 до canonical prepare/save.

Guard исполняется внутри native result tool, после native phase и в analyzer перед prepare/save, включая альтернативные reasoner adapters. Proposal передаётся сервером только как основание проверки, а не доверяется model output. Company importance независима: неизвестный масштаб бизнеса допускает score null с rationale даже при обоснованном локальном расчёте.

Это не универсальный NLP verifier всех денежных упоминаний. Документированный номинал, даты и честные historical quotations без calculation допустимы; правило не запрещает любое число в тексте. Отличающиеся question identities не сопоставляются эвристически; менять identity ради обхода запрещено в correction instructions, существующие object/question/evidence guards остаются обязательными.

## Компактный company prompt

Одинаковые exact source refs в preliminary drafts, previous questions и retrieval trace представлены существующими source handles. Catalog содержит material/version/hash, полные originals сохранены в context. Conditions, unknowns, questions, retrieval queries/rounds и arithmetic feedback остаются доступными. Не загружаемые исторические refs сохраняются отдельно как unavailable refs; они не получают фиктивный handle.

Это semantic projection известных полей, без общей JSON-pointer compression платформы. Хранимые typed drafts, history и source evidence не переписываются. SourceHandles в submit остаётся обязательным; отсутствующие handles не заполняются автоматически.

На model-free fake transport воспроизводится missing-handles → correction. Проверяется размер полного UTF-8 wire request, включая feedback, относительно guard 65536 bytes. Общий production лимит не увеличивается и не заменяется новым глобальным cap. Большие обязательные originals не обрезаются: прежняя mandatory-context budget проверка завершает phase до model call. Два malformed final submissions завершаются без сохранения. Повторы SDK после локального transport denial — отдельный механизм; этот patch не меняет общую retry policy.

## Проверки и релизные границы

Unit fixtures покрывают silent final omission, явную неизвестность, неконсистентный unknown, отзыв draft, исправленную формулу, qualitative principal, nullable importance, отсутствие prepare/save при отказе, native correction, missing sourceHandles, UTF-8 correction budget и unavailable historical evidence.

LLM/production calls для этих проверок не нужны. Полный набор gates и точный tree указываются в release handoff после выполнения.

Patch не ремонтирует старую ошибочную revision. Retry job пропускает completed компании; одинаковые company/news/version повторно возвращают receipt. Для проверки исправления нужен честный новый synthetic news/source version либо действительный reassessment trigger. Нельзя подставлять fake nonce, удалять историю или автоматически восстанавливать старый расчёт/importance. Runtime и изменение deployment выполняет release owner отдельно.
