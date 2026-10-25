import { z } from 'zod';

export const insightCategories = ['risk', 'opportunity', 'event'] as const;
export const insightCategorySchema = z
  .enum(insightCategories)
  .describe(
    'Risk (Риск): supported adverse effect for scope; opportunity (Возможность): supported beneficial effect; event (Событие): established significant event without a directional effect. Null means unclassified, uncertain, mixed without a supported predominant effect, or legacy. Independent of kind, importance, epistemic status and provenance.',
  );
export const categoryPolicy = `Для каждого вывода явно верни category: risk, opportunity, event или null. Category описывает доказанный характер вывода для его scope (компания для personal, указанный сегмент/условия для general): risk — обоснованный неблагоприятный эффект; opportunity — обоснованный благоприятный эффект; event — значимое подтверждённое событие без направленного эффекта. Если направление не установлено или эффекты смешанные без доказанного преобладающего эффекта, category=null. Event не fallback для uncertainty, прогноза или нехватки данных. Не выбирай risk по умолчанию для смешанных эффектов. Не выводи category из kind, importance, status, publicationClass, знака числа или provenance. Сохраняй условия и эпистемический статус отдельно; не выдумывай экспозицию или итоговый net effect ради категории.`;
