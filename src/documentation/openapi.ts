import { z } from 'zod';
import { createChatSchema, updateChatSchema } from '../chats/schema.ts';
import { publicCardSchema, publicFeedSchema, publicHistorySchema } from '../insights/schemas.ts';
import {
  analysisReceiptSchema,
  analysisRequestSchema,
} from '../news-analysis/contracts/analysis.ts';
import { flowRequestSchema, jobSchema } from '../news-analysis/contracts/flow.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const json = (schema: object) => ({ 'application/json': { schema } });
const response = (description: string, schema?: object) => ({
  description,
  ...(schema ? { content: json(schema) } : {}),
});
const body = (schema: object) => ({ required: true, content: json(schema) });
const query = (name: string, schema: object, description = '', required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});
const id = (name: string, uuid = false) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', ...(uuid ? { format: 'uuid', pattern: '^[0-9a-f-]+$' } : {}) },
});
const chatId = id('chatId', true);
const publicSecurity = [{ GatewayBearer: [] }];
const internalSecurity = [{ InternalSecret: [] }];
const errors = {
  '400': response(
    'Invalid input/cursor. Metadata errors use error/issues; native errors have their own error object.',
  ),
  '401': response('Gateway token rejected or trusted user context missing.'),
  '404': response(
    'Chat not found/not owned; native stream absent before first send; or uid mismatch.',
  ),
  '409': response(
    'Archived chat, conflicting idempotency key, or create-only uid condition failed.',
  ),
  '413': response('Request body exceeds 64 KiB.'),
  '500': response('Request failed; no successful result is implied.'),
};
const publicOperation = <T extends object>(summary: string, rest: T) => ({
  tags: ['Public chat — Bearer via AuthGateway'],
  security: publicSecurity,
  summary,
  ...rest,
});
const internalOperation = <T extends object>(summary: string, rest: T) => ({
  tags: ['Internal — service credential required'],
  security: internalSecurity,
  summary,
  description: 'Service-to-service only. A user Bearer token does not grant internal access.',
  ...rest,
});
const insightResponses = (schema: object) => ({
  '200': response('Scoped read result; Cache-Control: private, no-store', schema),
  '400': response('Invalid query, repeated parameters or mismatched cursor.'),
  '401': response('Gateway token rejected or trusted user context missing.'),
  '403': response('Current company membership required.'),
  '404': response('Insight not found or exact cited source is outside current permissions.'),
  '502': response(
    'Stored read/source contract, hash, knowledge time or evidence mismatch; no successful empty result implied.',
  ),
  '503': response(
    'Dependency unavailable, not configured, or source read budget exceeded; reduce page size for SOURCE_READ_BUDGET.',
  ),
});
const nativeDescription =
  'Flue 2.3.0 native protocol. Prefer @flue/sdk@2.3.0. Offsets/cursors are opaque. An SSE disconnect does not cancel server work. Render visible user/assistant text parts, not reasoning or raw tools.';

export function agentOpenApi() {
  const schema = (name: string, value: z.ZodType) => {
    const document = z.toJSONSchema(value, { unrepresentable: 'any' });
    // Zod recursive schemas use document-root $defs; each component has its own root.
    return JSON.parse(
      JSON.stringify(document, (key, entry: unknown) =>
        key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')
          ? `#/components/schemas/${name}/${entry.slice(2)}`
          : entry,
      ),
    );
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentService API',
      version: 'v1',
      description:
        'Public chat and current-company insight reads, plus separately secured internal news execution. Documentation does not change access or expose service credentials.',
    },
    servers: [{ url: '/agent-service' }],
    tags: [
      { name: 'Public chat — Bearer via AuthGateway' },
      { name: 'Public insights — Bearer via AuthGateway' },
      { name: 'Internal — service credential required' },
      { name: 'Operations' },
    ],
    paths: {
      '/insights': {
        get: {
          tags: ['Public insights — Bearer via AuthGateway'],
          security: publicSecurity,
          summary: 'Read a bounded current-company insight feed',
          description:
            'Company is resolved from current membership. No companyId/personId/asOf input. Private-source cards are omitted; follow nextCursor even after an empty page. exhaustive=false is not a total. Ordering: current revision createdAt DESC, id DESC; general latest permitted completed/partial job per news/version, updatedAt DESC, job id DESC, stored index DESC. Cursors are opaque and bound to company/kind/filters; restart after live updates. GET only; no model or source acquisition.',
          parameters: [
            query('kind', { enum: ['personal', 'general'], default: 'personal' }),
            query('limit', { type: 'integer', minimum: 1, maximum: 20, default: 5 }),
            query('cursor', { type: 'string', maxLength: 2048 }),
            query(
              'status',
              { type: 'string', maxLength: 100 },
              'Personal only; persisted status, not a normalized UI enum.',
            ),
            query(
              'mechanism',
              {
                type: 'string',
                enum: [
                  'financing_cost',
                  'refinancing_access',
                  'lease_cost',
                  'rent_indexation',
                  'demand',
                  'input_cost',
                  'investment',
                  'liquidity',
                  'tax',
                  'supply_capacity',
                  'labor_cost',
                  'deposit_income',
                ],
              },
              'Personal only.',
            ),
            query(
              'category',
              { type: 'string', enum: ['risk', 'opportunity', 'event'] },
              'Both kinds. Only saved categories match; legacy null is not inferred.',
            ),
            query('newsMaterialId', { type: 'string', maxLength: 200 }),
            query(
              'minImportance',
              { type: 'integer', minimum: 1, maximum: 5 },
              'Personal only. Authoritative assessed companyImportance only; old legacy values are not inferred.',
            ),
          ],
          responses: insightResponses(ref('InsightFeed')),
        },
      },
      '/insights/{kind}/{id}': {
        get: {
          tags: ['Public insights — Bearer via AuthGateway'],
          security: publicSecurity,
          summary: 'Read one permitted personal or general insight',
          description:
            'Personal id is the canonical effect/question id; currentRevision.revisionId identifies its revision. General id is an opaque stable stored-job/index reference, not a canonical general revision. General requiresReassessment=null means current freshness is unknown. Exact source hashes, saved knowledge time and current company/bank scope are checked before return. sources contain metadata and nullable safe sourceUrl, never original text. Importance null means not assessed. Indicators are zero or one saved sourced calculations, decimal strings; never compute new metrics or interpret null as zero. No bank-position label is inferred from generated prose.',
          parameters: [{ ...id('kind'), schema: { enum: ['personal', 'general'] } }, id('id')],
          responses: insightResponses(ref('InsightCard')),
        },
      },
      '/insights/personal/{id}/history': {
        get: {
          tags: ['Public insights — Bearer via AuthGateway'],
          security: publicSecurity,
          summary: 'Read bounded personal revision history within current permissions',
          description:
            'Newest sequence first; opaque cursor is bound to company and insight. General history is not implemented. Historical source access is rechecked now. Current requiresReassessment conservatively suppresses indicators in history too. No modelExplanation, raw calculation or unqualified numeric result, raw job checkpoints or other-company data.',
          parameters: [
            id('id'),
            query('limit', { type: 'integer', minimum: 1, maximum: 20, default: 10 }),
            query('cursor', { type: 'string', maxLength: 2048 }),
          ],
          responses: insightResponses(ref('InsightHistory')),
        },
      },
      '/health': {
        get: {
          tags: ['Operations'],
          responses: {
            '200': response('HTTP process alive', {
              type: 'object',
              properties: { status: { const: 'ok' } },
            }),
          },
        },
      },
      '/ready': {
        get: {
          tags: ['Operations'],
          responses: { '200': response('Ready'), '503': response('Database/runtime unavailable') },
        },
      },
      '/chats': {
        post: publicOperation('Create an owned chat before native send', {
          requestBody: body(ref('CreateChat')),
          responses: {
            ...errors,
            '201': {
              ...response('Chat created', ref('Chat')),
              headers: { Location: { schema: string, description: 'Relative chat metadata URL' } },
            },
          },
        }),
        get: publicOperation('List own chats', {
          parameters: [
            query('archive', {
              type: 'string',
              enum: ['active', 'archived', 'all'],
              default: 'active',
            }),
            query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
            query(
              'cursor',
              { type: 'string', maxLength: 512 },
              'Opaque nextCursor from the same archive filter.',
            ),
          ],
          responses: {
            ...errors,
            '200': response('Page ordered by updatedAt DESC, id DESC', ref('ChatPage')),
          },
        }),
      },
      '/chats/{chatId}': {
        get: publicOperation('Read own chat metadata', {
          parameters: [chatId],
          responses: { ...errors, '200': response('Chat', ref('Chat')) },
        }),
        patch: publicOperation('Rename, archive or restore own chat', {
          parameters: [chatId],
          requestBody: body(ref('UpdateChat')),
          responses: {
            ...errors,
            '200': response(
              'Updated chat; archive preserves history and abort access',
              ref('Chat'),
            ),
          },
        }),
      },
      '/agents/assistant/{chatId}': {
        post: publicOperation('Durably admit one user message', {
          description: `${nativeDescription} Raw HTTP body is flat; SDK send({message,...}) flattens it. 202 is admission, not completion. Retry an uncertain delivery with the same idempotencyKey and identical input. uid is an instance condition, never user identity. Attachments, signals and initialData are not accepted.`,
          parameters: [chatId],
          requestBody: body(ref('UserMessage')),
          responses: {
            ...errors,
            '202': {
              ...response('Durable admission; await submission settlement', ref('Admission')),
              headers: { Location: { schema: string }, 'Stream-Next-Offset': { schema: string } },
            },
          },
        }),
        get: publicOperation('Read history or native updates/SSE', {
          description: `${nativeDescription} view=history is the default and cannot be combined with offset/live. view=updates requires offset. SSE event:data contains a JSON ARRAY of native chunks; event:control carries streamNextOffset/upToDate. Deduplicate positions across reconnects; a conversation-reset replaces state. SSE stays open after completion; await submission-settled completed/failed/aborted. History 404 before the first admitted message is an empty new chat.`,
          parameters: [
            chatId,
            query('view', { enum: ['history', 'updates'], default: 'history' }),
            query('offset', string, 'Required only for updates: use a server-issued offset or -1.'),
            query(
              'live',
              { enum: ['sse', 'long-poll'] },
              'Updates only; omit for one JSON updates page.',
            ),
            query(
              'limit',
              { type: 'integer', minimum: 1 },
              'History window / reset snapshot window.',
            ),
            query(
              'before',
              string,
              'History older-page cursor; cannot combine with from/offset/live.',
            ),
            query('from', string, 'History cursor-inclusive window; cannot combine with limit.'),
          ],
          responses: {
            ...errors,
            '410': response(
              'History cursor no longer belongs to this stream generation; refresh the newest window.',
            ),
            '200': {
              description:
                'History snapshot/page or updates array depending on query. SSE is a streaming wire format, not a JSON reply.',
              headers: {
                'Stream-Next-Offset': {
                  schema: string,
                  description:
                    'JSON history/updates resume checkpoint; absent for older history pages. SSE sends checkpoints in control frames instead.',
                },
                'Stream-Up-To-Date': {
                  schema: string,
                  description:
                    'JSON/HEAD: present as true when caught up; SSE uses control frames.',
                },
              },
              content: {
                'application/json': {
                  schema: {
                    anyOf: [
                      ref('History'),
                      ref('HistoryPage'),
                      { type: 'array', items: ref('NativeChunk') },
                    ],
                  },
                },
                'text/event-stream': {
                  schema: { type: 'string' },
                  example:
                    'event: data\ndata: [{"type":"message-delta","conversationId":"opaque","messageId":"opaque","kind":"text","delta":"Hello","position":{"batch":4,"index":0}}]\n\nevent: control\ndata: {"streamNextOffset":"opaque-offset","upToDate":true}\n\n',
                },
              },
            },
          },
        }),
        head: publicOperation('Read native stream coordination headers', {
          parameters: [chatId],
          responses: {
            ...errors,
            '200': {
              description: 'No response body',
              headers: {
                'Stream-Next-Offset': { schema: string },
                'Stream-Up-To-Date': { schema: string },
              },
            },
          },
        }),
      },
      '/agents/assistant/{chatId}/abort': {
        post: publicOperation('Abort active and queued work of this owned conversation', {
          description:
            'aborted=true acknowledges stopping work; terminal settlement is asynchronous. Closing a client stream does not call abort. No rollback of already committed domain effects is promised.',
          parameters: [chatId],
          responses: {
            ...errors,
            '200': response('Abort acknowledgment', {
              type: 'object',
              required: ['aborted'],
              properties: { aborted: { type: 'boolean' } },
            }),
          },
        }),
      },
      '/internal/news-analysis': {
        post: internalOperation('Analyze one already selected company/news version', {
          requestBody: body(ref('AnalysisRequest')),
          responses: {
            '200': response(
              'Saved receipt; not a full discovery/fanout job',
              ref('AnalysisReceipt'),
            ),
            '400': response('Invalid request'),
            '403': response('Internal admission required'),
            '422': response('Invalid evidence/domain input'),
            '502': response('Analysis/upstream failed'),
            '503': response('Integration disabled'),
          },
        }),
      },
      '/internal/news-analysis/news': {
        post: internalOperation('Enqueue full news planning/selection/fanout', {
          requestBody: body(ref('FlowRequest')),
          responses: {
            '202': response('Job accepted', ref('JobAdmission')),
            '400': response('Invalid request'),
            '403': response('Internal admission required'),
            '502': response('Enqueue failed'),
            '503': response('Flow disabled'),
          },
        }),
      },
      '/internal/news-analysis/events': {
        post: internalOperation('Admit a news observation then enqueue its exact version', {
          requestBody: body(ref('NewsEvent')),
          responses: {
            '202': response('Job accepted; event route omits statusUrl', {
              type: 'object',
              required: ['jobId', 'status'],
              properties: { jobId: string, status: string },
            }),
            '400': response('Invalid event'),
            '403': response('Internal admission required'),
            '502': response('Admission/enqueue failed'),
            '503': response('Flow disabled'),
          },
        }),
      },
      '/internal/news-analysis/jobs/{jobId}': {
        get: internalOperation('Read durable job/checkpoint/result', {
          description:
            'Internal result can contain multiple companies and role data. Never proxy this response wholesale to a browser.',
          parameters: [id('jobId')],
          responses: {
            '200': response(
              'Job; generalInsights live inside checkpoint.plan/result',
              ref('NewsJob'),
            ),
            '403': response('Internal admission required'),
            '404': response('Job not found'),
            '502': response('Read failed'),
            '503': response('Flow disabled'),
          },
        }),
      },
      '/internal/news-analysis/kafka': {
        get: internalOperation('Read optional consumer status', {
          responses: {
            '200': response('Configured consumer status or status=disabled', { type: 'object' }),
            '403': response('Internal admission required'),
            '503': response('Integration disabled'),
          },
        }),
      },
    },
    components: {
      securitySchemes: {
        GatewayBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'User token validated by AuthGateway. Do not send client X-User-* headers. Agent trusts gateway identity and checks chat ownership.',
        },
        InternalSecret: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Internal-Secret',
          description: 'Service-to-service credential only. Never embed it in frontend code.',
        },
      },
      schemas: {
        CreateChat: schema('CreateChat', createChatSchema),
        UpdateChat: schema('UpdateChat', updateChatSchema),
        Chat: {
          type: 'object',
          required: ['id', 'agentKey', 'title', 'createdAt', 'updatedAt', 'archivedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            agentKey: { const: 'client-assistant' },
            title: string,
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            archivedAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        ChatPage: {
          type: 'object',
          required: ['items', 'nextCursor'],
          properties: {
            items: { type: 'array', items: ref('Chat') },
            nextCursor: { type: ['string', 'null'] },
          },
        },
        UserMessage: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'body'],
          properties: {
            kind: { const: 'user' },
            body: {
              type: 'string',
              minLength: 1,
              maxLength: 32000,
              description: 'Must contain non-whitespace text.',
            },
            uid: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        Admission: {
          type: 'object',
          required: ['streamUrl', 'offset', 'submissionId', 'uid'],
          properties: {
            streamUrl: { type: 'string', format: 'uri' },
            offset: string,
            submissionId: string,
            uid: string,
            deduplicated: { type: 'boolean' },
          },
        },
        Settlement: {
          type: 'object',
          required: ['submissionId', 'outcome'],
          properties: {
            submissionId: string,
            outcome: { enum: ['completed', 'failed', 'aborted'] },
            error: {},
            answeredBySubmissionId: string,
            timestamp: string,
          },
        },
        NativeMessage: {
          type: 'object',
          description:
            'Native SDK message; parts may be text/reasoning/data/dynamic-tool. Display only appropriate visible content.',
          required: ['id', 'role', 'purpose', 'display', 'parts'],
          properties: {
            id: string,
            role: { enum: ['user', 'assistant', 'system'] },
            purpose: string,
            display: { enum: ['visible', 'hidden', 'diagnostic'] },
            submissionId: string,
            parts: { type: 'array', items: { type: 'object' } },
          },
        },
        History: {
          type: 'object',
          required: ['v', 'conversationId', 'offset', 'messages', 'settlements'],
          properties: {
            v: { const: 1 },
            conversationId: string,
            offset: string,
            incarnation: string,
            messages: { type: 'array', items: ref('NativeMessage') },
            settlements: { type: 'array', items: ref('Settlement') },
            before: { type: ['string', 'null'] },
          },
        },
        HistoryPage: {
          type: 'object',
          required: ['v', 'conversationId', 'messages', 'before'],
          properties: {
            v: { const: 1 },
            conversationId: string,
            messages: { type: 'array', items: ref('NativeMessage') },
            before: { type: ['string', 'null'] },
          },
        },
        NativeChunk: {
          type: 'object',
          required: ['type'],
          description:
            'Flue 2.3.0 projection chunk, not a stable domain card event. Use SDK observation/reduction.',
          properties: {
            type: string,
            conversationId: string,
            position: {
              type: 'object',
              properties: { batch: { type: 'integer' }, index: { type: 'integer' } },
            },
          },
        },
        InsightCard: schema('InsightCard', publicCardSchema),
        InsightFeed: schema('InsightFeed', publicFeedSchema),
        InsightHistory: schema('InsightHistory', publicHistorySchema),
        AnalysisRequest: schema('AnalysisRequest', analysisRequestSchema),
        AnalysisReceipt: schema('AnalysisReceipt', analysisReceiptSchema),
        FlowRequest: schema('FlowRequest', flowRequestSchema),
        NewsJob: schema('NewsJob', jobSchema),
        JobAdmission: {
          type: 'object',
          required: ['jobId', 'status', 'statusUrl'],
          properties: { jobId: string, status: string, statusUrl: string },
        },
        NewsEvent: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'externalId', 'title', 'text', 'publishedAt'],
          description:
            'Context admission request (camelCase JSON); defaults textCompleteness to lead. Lead/unknown never implies a full publisher original. HTTP request remains bounded by 64 KiB.',
          properties: {
            source: string,
            externalId: string,
            title: string,
            text: string,
            publishedAt: { type: 'string', format: 'date-time' },
            knownAt: { type: 'string', format: 'date-time' },
            correctsVersionId: string,
            sourceUrl: { type: 'string', format: 'uri' },
            textCompleteness: { enum: ['full', 'lead', 'unknown'], default: 'lead' },
          },
        },
      },
    },
  };
}
