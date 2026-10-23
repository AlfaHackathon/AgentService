import { describe, expect, it } from 'vitest';
import { checkNewsBoundaries, newsBoundaryViolations } from '../scripts/check-news-boundaries.ts';

describe('news analysis dependency boundaries', () => {
  it('keeps the actual feature within its declared dependency direction', () => {
    expect(checkNewsBoundaries()).toEqual([]);
  });

  it.each([
    ['contracts/bad.ts', "import { NewsFlow } from '../application/news-flow.ts'"],
    ['contracts/bad.ts', "type X = import('../reasoning/agent-runner.ts').Task"],
    ['application/bad.ts', "export { createFlowReasoner } from '../reasoning/flow-reasoner.ts'"],
    ['application/bad.ts', "const runtime = import('@flue/runtime')"],
    [
      'retrieval/bad.ts',
      "import { createConfiguredNewsAnalysis } from '../composition/configuration.ts'",
    ],
    [
      'transport/http/bad.ts',
      "import { NewsAnalyzer } from '../../application/company-analysis.ts'",
    ],
    ['application/bad.ts', "import { ContextClient } from '../retrieval/context-client.ts'"],
    ['application/bad.ts', "import { Hono } from 'hono'"],
    ['everything.ts', 'export const unowned = true'],
  ])('rejects forbidden dependencies in %s', (file, source) => {
    expect(newsBoundaryViolations(`src/news-analysis/${file}`, source)).toHaveLength(1);
  });

  it('permits application ports without loading their HTTP implementation', () => {
    expect(
      newsBoundaryViolations(
        'src/news-analysis/application/example.ts',
        "import type { ContextClient } from '../retrieval/context-client.ts'",
      ),
    ).toEqual([]);
  });
});
