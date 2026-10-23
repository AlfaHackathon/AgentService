import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { flowRequestSchema } from '../contracts/flow.ts';
import { sameInstant, timestampSchema } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
export async function admitNewsEvent(
  context: Pick<FlowContextClient, 'material' | 'saveMaterial'>,
  raw: unknown,
) {
  const event = z
    .strictObject({
      source: z.string().trim().min(1).max(200),
      externalId: z.string().trim().min(1).max(1000),
      title: z.string().trim().min(1).max(1000),
      text: z.string().max(200000),
      publishedAt: timestampSchema,
      knownAt: timestampSchema.optional(),
      correctsVersionId: z.string().min(1).max(200).optional(),
      textCompleteness: z.enum(['full', 'lead', 'unknown']).default('lead'),
      sourceUrl: z.url().optional(),
    })
    .parse(raw);
  const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const materialId = `news-${hash([event.source, event.externalId]).slice(0, 40)}`;
  const versionId =
    'v-' +
    hash([
      event.title,
      event.text,
      event.publishedAt,
      event.correctsVersionId ?? null,
      ...(event.sourceUrl ? [event.sourceUrl] : []),
    ]).slice(0, 40);
  // Retried delivery reuses the original observation time instead of changing an immutable version.
  let saved: z.infer<typeof materialSchema>;
  try {
    saved = await context.material(materialId, versionId);
  } catch (error) {
    if (!(error instanceof NewsAnalysisError) || error.status !== 404) throw error;
    const observedAt = event.knownAt ?? new Date().toISOString();
    const material = {
      materialId,
      versionId,
      sourceId: event.source,
      kind: 'news',
      title: event.title,
      text: event.text,
      knownAt: observedAt,
      publishedAt: event.publishedAt,
      correctsVersionId: event.correctsVersionId ?? null,
      companyIds: [],
      bankProfileIds: [],
      provenance: {
        acquisition: 'event_payload',
        sourceUrl: event.sourceUrl ?? null,
        retrievedAt: observedAt,
        textCompleteness: event.textCompleteness,
        originVersionId: null,
        locator: event.externalId,
      },
    };
    try {
      saved = await context.saveMaterial(material);
    } catch (conflict) {
      // Two Kafka partitions/processes may admit the same event concurrently.
      // The winner owns knownAt; the loser must reuse it instead of inventing
      // a second observation time or pausing a valid duplicate forever.
      if (!(conflict instanceof NewsAnalysisError) || conflict.status !== 409) throw conflict;
      saved = await context.material(materialId, versionId);
    }
  }
  if (
    saved.materialId !== materialId ||
    saved.versionId !== versionId ||
    saved.sourceId !== event.source ||
    saved.kind !== 'news' ||
    saved.companyIds.length ||
    saved.bankProfileIds.length ||
    saved.title !== event.title ||
    saved.text !== event.text ||
    !saved.publishedAt ||
    !sameInstant(saved.publishedAt, event.publishedAt) ||
    (saved.correctsVersionId ?? null) !== (event.correctsVersionId ?? null)
  )
    throw new NewsAnalysisError(
      409,
      'NEWS_EVENT_CONFLICT',
      'Stored material does not match the admitted publication',
    );
  return flowRequestSchema.parse({
    newsMaterialId: materialId,
    newsVersionId: versionId,
    asOf: saved.knownAt,
    textCompleteness:
      saved.provenance?.textCompleteness === 'excerpt'
        ? 'unknown'
        : (saved.provenance?.textCompleteness ?? 'unknown'),
  });
}
