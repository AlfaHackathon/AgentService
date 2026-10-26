import { z } from 'zod';
import type { EffectDraft, materialSchema } from './analysis.ts';
import { NewsAnalysisError } from './errors.ts';
import { type companyProfileSchema, declaredProfileSchema } from './flow.ts';
import { instantAfter } from './timestamps.ts';

type Source = z.infer<typeof materialSchema>;
type Profile = z.infer<typeof companyProfileSchema>;
export const declaredProfileSourceId = 'company-operational-declared-profile';
export function isProfileSignal(source: Pick<Source, 'sourceId'>): boolean {
  return source.sourceId === declaredProfileSourceId || source.sourceId === 'provided-bank-csv';
}
const refKey = (ref: { materialId: string; versionId: string; contentHash: string }) =>
  JSON.stringify([ref.materialId, ref.versionId, ref.contentHash]);
const snapshotSchema = z.strictObject({
  companyId: z.uuid(),
  ...declaredProfileSchema.omit({ sourceRefs: true }).shape,
});

// A mutable operational row is never substituted into a historical analysis.
export function validateDeclaredProfile(
  profile: Profile,
  sources: Source[],
  companyId: string,
  asOf: string,
): void {
  const invalid: () => never = () => {
    throw new NewsAnalysisError(
      502,
      'DECLARED_PROFILE_SOURCE',
      'The declared profile does not match its exact company snapshot and knowledge time.',
    );
  };
  if (profile.companyId.toLowerCase() !== companyId || instantAfter(profile.knownAt, asOf))
    invalid();
  if (!profile.declaredProfile) return;
  const { sourceRefs, ...fields } = profile.declaredProfile;
  const ref = sourceRefs[0];
  if (!ref) invalid();
  const source = sources.find((source) => refKey(source) === refKey(ref));
  if (
    !source ||
    source.sourceId !== declaredProfileSourceId ||
    source.kind !== 'company' ||
    source.companyIds.length !== 1 ||
    source.companyIds[0]?.toLowerCase() !== companyId ||
    source.bankProfileIds.length !== 0 ||
    instantAfter(source.knownAt, profile.knownAt) ||
    instantAfter(source.knownAt, asOf) ||
    !profile.sourceRefs.some((ref) => refKey(ref) === refKey(source))
  )
    invalid();
  try {
    const captured = snapshotSchema.safeParse(JSON.parse(source.text));
    const expected = snapshotSchema.parse({ companyId, ...fields });
    if (!captured.success || JSON.stringify(captured.data) !== JSON.stringify(expected)) invalid();
  } catch {
    invalid();
  }
}

// Profile declarations can establish relevance, never a loan, budget or financial exposure.
export function validateProfileExposure(draft: EffectDraft, sources: Source[]): void {
  const applicability = draft.assessment?.applicability;
  const draftRefs = new Set(draft.sourceRefs.map(refKey));
  const refs = new Set((applicability?.sourceRefs ?? draft.sourceRefs).map(refKey));
  const cited = sources.filter((source) => draftRefs.has(refKey(source)));
  const exposure = sources.filter((source) => refs.has(refKey(source)));
  if (
    cited.some((source) => source.sourceId === declaredProfileSourceId) &&
    !exposure.some((source) => source.kind === 'company' && !isProfileSignal(source)) &&
    (applicability?.basis === 'documented_exposure' ||
      !!draft.calculation ||
      draft.impact?.evidenceStatus === 'supported' ||
      draft.impact?.evidenceStatus === 'conditional')
  )
    throw new NewsAnalysisError(
      422,
      'DECLARED_PROFILE_EXPOSURE',
      'Declared profile fields are relevance signals, not documentary financial exposure. Preserve unknown exposure without a calculation, or cite an actual own document.',
    );
}
