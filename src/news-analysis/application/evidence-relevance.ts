import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import type { evidenceInventorySchema } from '../contracts/depth.ts';
import { type Relevance, relevanceSchema } from '../contracts/relevance.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
export async function inspectEvidenceRelevance(
  context: FlowContextClient,
  inventory: z.infer<typeof evidenceInventorySchema>,
  classify: (sources: z.infer<typeof materialSchema>[]) => Promise<Relevance>,
): Promise<Relevance | undefined> {
  const own = inventory.sources.filter((s) => s.sourceId !== 'provided-bank-csv');
  if (!inventory.completeForLoadedScope || !own.length || own.length > 8) return undefined;
  const sources: z.infer<typeof materialSchema>[] = [];
  for (const ref of own) {
    const s = await context.material(ref.materialId, ref.versionId);
    if (
      sourceKey(s) !== sourceKey(ref) ||
      s.kind !== 'company' ||
      !s.companyIds.includes(inventory.companyId) ||
      instantAfter(s.knownAt, inventory.asOf)
    )
      throw new Error('Relevance evidence scope mismatch');
    sources.push(s);
    if (JSON.stringify(sources).length > 60000) return undefined; // unknown => deep; never truncate a document to prove irrelevance
  }
  const result = relevanceSchema.parse(await classify(sources));
  if (
    result.length !== own.length ||
    new Set(result.map((r) => sourceKey(r.sourceRef))).size !== own.length ||
    result.some(
      (r) =>
        !sources.some(
          (s) =>
            sourceKey(s) === sourceKey(r.sourceRef) &&
            (r.status === 'unknown' || (r.quote.length > 0 && s.text.includes(r.quote))),
        ),
    )
  )
    throw new Error('Relevance assessment must cover every exact original and quote its text');
  return result;
}
