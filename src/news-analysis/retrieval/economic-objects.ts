import { isProfileSignal } from '../contracts/declared-profile.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { Source } from './source-catalog.ts';

export type EconomicObjectBinding = {
  handle: string;
  economicObjectId: string;
  companyId: string;
  evidence: {
    sourceHandle: string;
    materialId: string;
    versionId: string;
    contentHash: string;
    quote: string;
  }[];
};

// Literal identifiers only. No aliases, previous-effect inference, or invented IDs.
export function economicObjectCatalog(
  sources: Source[],
  companyId: string,
  asOf: string,
): EconomicObjectBinding[] {
  const objects: EconomicObjectBinding[] = [];
  for (const [index, source] of sources.entries()) {
    if (
      source.kind !== 'company' ||
      isProfileSignal(source) ||
      !source.companyIds.includes(companyId) ||
      instantAfter(source.knownAt, asOf)
    )
      continue;
    for (const match of source.text.matchAll(
      /(?<![\p{L}\p{N}])(?:loan|credit agreement|contract|agreement|за[её]м|займ|кредит|договор|контракт|лот|заказ)[\s№:«"“]*(?:ID[\s:]+|No\.?[\s:]+)?([\p{L}\p{N}][\p{L}\p{N}_./-]{1,80})/giu,
    )) {
      const id = match[1]?.replace(/[.,;:]+$/u, '');
      if (!id || !(/[0-9]/.test(id) || /^[A-ZА-ЯЁ_-]{3,}$/.test(id))) continue;
      let object = objects.find((o) => o.economicObjectId === id);
      if (!object) {
        if (objects.length >= 32) continue;
        object = { handle: `e${objects.length}`, economicObjectId: id, companyId, evidence: [] };
        objects.push(object);
      }
      if (
        object.evidence.length < 16 &&
        !object.evidence.some((e) => e.sourceHandle === `s${index}`)
      )
        object.evidence.push({
          sourceHandle: `s${index}`,
          materialId: source.materialId,
          versionId: source.versionId,
          contentHash: source.contentHash,
          quote: match[0],
        });
    }
  }
  return objects;
}

export function selectedEconomicObject(
  handle: string | null,
  catalog: EconomicObjectBinding[],
  sourceHandles: string[],
  exposureHandles: string[],
  monetary: boolean,
): string | null {
  if (handle === null && !monetary) return null;
  const selected = catalog.find((object) => object.handle === handle);
  if (
    !selected?.evidence.some(
      (e) => sourceHandles.includes(e.sourceHandle) && exposureHandles.includes(e.sourceHandle),
    )
  )
    throw new NewsAnalysisError(
      422,
      'ECONOMIC_OBJECT_BINDING',
      'Select a documented economicObjectHandle and cite its own exposure source in both draft and applicability. If unavailable, preserve a qualitative unknown without calculation.',
    );
  return selected.economicObjectId;
}
