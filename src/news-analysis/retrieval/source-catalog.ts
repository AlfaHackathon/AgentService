import type { ContextBundle, StoredEffect } from '../contracts/analysis.ts';

export type Source = ContextBundle['news'];
export type ObjectBinding = { handle: string; literal: string; sourceHandles: string[] };
export const sourceKey = (s: Pick<Source, 'materialId' | 'versionId' | 'contentHash'>) =>
  JSON.stringify([s.materialId, s.versionId, s.contentHash]);

export function objectCatalog(
  sources: Source[],
  companyId: string,
  previous: Pick<StoredEffect, 'literalObjectRef'>[] = [],
  existing: ObjectBinding[] = [],
): ObjectBinding[] {
  const objects = existing.map((o) => ({ ...o, sourceHandles: [...o.sourceHandles] }));
  if (!objects.length)
    objects.push({ handle: 'o0', literal: `company:${companyId}`, sourceHandles: [] });
  for (const [i, source] of sources.entries())
    for (const found of source.text.matchAll(
      /(?:договор|контракт|лот|заказ)[\s№:«"“]*([\p{L}\p{N}][\p{L}\p{N}_./-]{1,80})/giu,
    )) {
      const literal = found[1]?.replace(/[.,;:]+$/u, '');
      if (!literal || !(/[0-9]/.test(literal) || /^[A-ZА-ЯЁ_-]{3,}$/.test(literal))) continue;
      const old = objects.find((o) => o.literal === literal);
      if (old) {
        if (!old.sourceHandles.includes(`s${i}`)) old.sourceHandles.push(`s${i}`);
      } else objects.push({ handle: `o${objects.length}`, literal, sourceHandles: [`s${i}`] });
    }
  for (const prior of previous)
    if (!objects.some((o) => o.literal === prior.literalObjectRef))
      objects.push({
        handle: `o${objects.length}`,
        literal: prior.literalObjectRef,
        sourceHandles: [],
      });
  return objects;
}
