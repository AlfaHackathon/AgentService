import { type Message, normalizeContext } from '@earendil-works/pi-ai';
import { afterEach, expect, it } from 'vitest';
import { createModelProvider } from '../src/config/model.ts';
import { compactNewsToolFeedback } from '../src/config/tool-feedback.ts';
import { createHttpService } from './helpers/http-service.ts';

const tools = [
  'submit_news_analysis',
  'plan_news_insights',
  'assess_evidence_relevance',
  'extract_source_signals',
  'review_source_signals',
  'project_role_actions',
];
function fixture(
  tool = 'submit_news_analysis',
  diagnostics = '  - /drafts/0/category: must be null or a declared category',
) {
  const args = {
    drafts: [
      {
        category: 'null',
        sourceHandles: ['s0', 's1'],
        unknowns: ['Точная экспозиция неизвестна.'],
        quote: 'SYNTHETIC exact original quote.',
      },
    ],
  };
  const assistant: Message = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name: tool, arguments: args }],
    api: 'openai-completions',
    provider: 'project',
    model: 'test-model',
    stopReason: 'toolUse',
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const error: Message = {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: tool,
    isError: true,
    timestamp: 2,
    content: [
      {
        type: 'text',
        text: `Validation failed for tool "${tool}":\n${diagnostics}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
      },
    ],
  };
  const context = normalizeContext({
    messages: [
      {
        role: 'user',
        content:
          'FULL ORIGINAL; unknown exposure; immutable version v1/hash. Never fabricate a zero.',
        timestamp: 0,
      },
      assistant,
      error,
    ],
  });
  return { args, assistant, error, context };
}

it.each(tools)(
  'compacts only duplicated schema feedback for %s without mutating evidence, assistant arguments or durable context',
  (tool) => {
    const { context } = fixture(tool);
    const before = structuredClone(context);
    const output = compactNewsToolFeedback(context);
    expect(context).toEqual(before);
    expect(output.messages.slice(0, -1)).toEqual(context.messages.slice(0, -1));
    expect(output.messages.at(-1)).toMatchObject({
      role: 'toolResult',
      isError: true,
      toolCallId: 'call-1',
      content: [{ type: 'text', text: expect.stringContaining('category') }],
    });
    expect(JSON.stringify(output.messages.at(-1))).not.toContain('SYNTHETIC exact original quote.');
    expect(JSON.stringify(output.messages[1])).toContain('SYNTHETIC exact original quote.');
    expect(JSON.stringify(output.messages[1])).toContain('"category":"null"');
  },
);

it.each([
  'success',
  'source-tool',
  'domain-422',
  'wrong-id',
  'wrong-name',
  'mismatched-arguments',
  'malformed-tail',
  'format-drift',
  'user-data',
] as const)('leaves %s messages untouched', (variation) => {
  const { context, error } = fixture();
  if (error.role !== 'toolResult' || error.content[0]?.type !== 'text')
    throw new Error('Invalid fixture');
  if (variation === 'success') error.isError = false;
  if (variation === 'source-tool') error.toolName = 'context_read_original';
  if (variation === 'domain-422')
    error.content[0].text =
      '{"status":"invalid","code":"ECONOMIC_OBJECT_BINDING","httpStatus":422}';
  if (variation === 'wrong-id') error.toolCallId = 'other-call';
  if (variation === 'wrong-name') error.toolName = 'plan_news_insights';
  if (variation === 'mismatched-arguments')
    error.content[0].text = error.content[0].text.replace(
      '"category": "null"',
      '"category": "risk"',
    );
  if (variation === 'malformed-tail') error.content[0].text += ' malformed';
  if (variation === 'format-drift')
    error.content[0].text = error.content[0].text.replace(
      'Received arguments:',
      'New SDK argument format:',
    );
  if (variation === 'user-data')
    context.messages.push({ role: 'user', timestamp: 3, content: error.content[0].text });
  // normalizeContext retains transcript message objects; rebuild after modifying fixture.
  context.messages[2] = error;
  if (variation === 'user-data') error.isError = false;
  const before = structuredClone(context);
  expect(compactNewsToolFeedback(context)).toBe(context);
  expect(context).toEqual(before);
});

it('bounds many Unicode diagnostics without trimming any source or assistant argument', () => {
  const diagnostics = Array.from(
    { length: 80 },
    (_, i) => `  - /drafts/${i}/category: ${'Ошибка схемы. '.repeat(100)}`,
  ).join('\n');
  const { context } = fixture('submit_news_analysis', diagnostics);
  const output = compactNewsToolFeedback(context);
  const error = output.messages.at(-1);
  if (error?.role !== 'toolResult' || error.content[0]?.type !== 'text')
    throw new Error('Missing feedback');
  expect(Buffer.byteLength(error.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
  expect(error.content[0].text).toContain('"issueCount":80');
  expect(error.content[0].text).toContain('"detailsOmitted":true');
  expect(error.content[0].text).not.toContain('\uFFFD');
  expect(output.messages.slice(0, -1)).toEqual(context.messages.slice(0, -1));
});

it('prioritizes one error per draft ahead of redundant root and first-draft errors', () => {
  const { context, args, error } = fixture(
    'submit_news_analysis',
    [
      '  - conclusion: schema is false',
      '  - status: schema is false',
      '  - impact: schema is false',
      '  - root: must not have additional properties',
      '  - drafts.0.conclusion: required',
      '  - drafts.0.status: required',
      '  - drafts.0.impact: required',
      '  - drafts.1: must be object',
    ].join('\n'),
  );
  Object.assign(args, { conclusion: 'Synthetic misplaced conclusion' });
  if (error.role !== 'toolResult' || error.content[0]?.type !== 'text')
    throw new Error('Invalid fixture');
  error.content[0].text =
    error.content[0].text.slice(0, error.content[0].text.indexOf('\n\nReceived arguments:\n')) +
    `\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
  const before = structuredClone(context);
  const output = compactNewsToolFeedback(context);
  const message = output.messages.at(-1);
  if (message?.role !== 'toolResult' || message.content[0]?.type !== 'text')
    throw new Error('Missing feedback');
  const feedback = message.content[0].text;
  expect(feedback).toContain('drafts.0.conclusion');
  expect(feedback).toContain('drafts.1: must be object');
  expect(feedback).toContain('Use {drafts:[{...}]}');
  expect(feedback).toContain('never at top-level');
  expect(Buffer.byteLength(feedback, 'utf8')).toBeLessThanOrEqual(512);
  expect(context).toEqual(before);
  expect(output.messages.slice(0, -1)).toEqual(context.messages.slice(0, -1));
});

it('matches the latest preceding assistant call for a reused id and leaves a mismatched old error intact', () => {
  const { context, assistant } = fixture();
  if (assistant.role !== 'assistant' || assistant.content[0]?.type !== 'toolCall')
    throw new Error('Invalid fixture');
  const latest = structuredClone(assistant);
  const part = latest.content[0];
  if (part?.type !== 'toolCall') throw new Error('Invalid fixture');
  part.arguments = { drafts: [] };
  context.messages.splice(2, 0, latest);
  expect(compactNewsToolFeedback(context)).toBe(context);
});

const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
it.each(['stream', 'streamSimple'] as const)(
  'projects schema errors through provider %s and preserves transport options',
  async (method) => {
    const bodies: string[] = [];
    const service = await createHttpService(async (request) => {
      expect(request.headers.get('X-Fixture')).toBe('same-option');
      bodies.push(await request.text());
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    servers.push(service);
    const provider = createModelProvider({
      LLM_BASE_URL: `${service.url}/v1`,
      LLM_API_KEY: 'fake-only',
      LLM_MODEL: 'test-model',
    });
    const model = provider.getModels()[0];
    if (!model) throw new Error('Missing fixture model');
    const { context } = fixture();
    const before = structuredClone(context);
    await provider[method](model, context, {
      apiKey: 'fake-only',
      headers: { 'X-Fixture': 'same-option' },
      signal: AbortSignal.timeout(1000),
    }).result();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('TOOL_ARGUMENT_SCHEMA');
    expect(bodies[0]).not.toContain('Received arguments:');
    expect(bodies[0]).toContain('Точная экспозиция неизвестна.');
    expect(context).toEqual(before);
  },
);
