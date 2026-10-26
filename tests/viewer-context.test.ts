import { describe, expect, it, vi } from 'vitest';
import { AssistantServiceClients } from '../src/client-assistant/service-clients.ts';
import { AssistantToolSession, initialAssistantState } from '../src/client-assistant/session.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyId = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = '2026-10-26T00:00:00Z';
function setup(name: string | null) {
  const state = {
    owner: userId as string | null,
    membership: companyId,
    fail: false,
    viewerCompany: companyId,
  };
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    calls.push(url);
    expect(new Headers(options?.headers).get('X-Internal-Secret')).toBe('fixture-secret');
    if (url.pathname.includes('/by-user/'))
      return Response.json({
        id: state.membership,
        name: 'Synthetic company',
        bankProfileId: null,
      });
    if (url.pathname.includes('/knowledge/companies/'))
      return Response.json({
        companyId,
        revisionId: 'p1',
        name: 'Synthetic company',
        description: 'Declared',
        bankProfileId: null,
        industryCodes: [],
        exposures: [],
        knownAt: at,
        sourceRefs: [],
      });
    if (url.pathname.endsWith('/viewer-context')) {
      if (state.fail) return Response.json({ error: 'private upstream failure' }, { status: 503 });
      return Response.json({
        userId,
        companyId: state.viewerCompany,
        role:
          name === null
            ? null
            : {
                id: other,
                name,
                isDefault: name === 'Ген директор',
                email: 'do-not-forward@example.test',
              },
        observedAt: at,
        email: 'do-not-forward@example.test',
        hashedPassword: 'do-not-forward',
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const client = (service: string) =>
    new ServiceClient(`http://fixture/${service}-service`, 'fixture-secret', fetcher);
  const clients = new AssistantServiceClients(
    client('company'),
    client('context'),
    client('insight'),
    client('user'),
  );
  const analyze = vi.fn(async () => {
    throw new Error('Viewer reads must not analyze');
  });
  const session = new AssistantToolSession(
    chatId,
    { ...initialAssistantState(), asOf: at },
    async () => ({ owner: async () => state.owner, clients, analyzer: { analyze } }),
    () => {},
  );
  return { state, clients, calls, session, analyze };
}

describe('trusted viewer framing context', () => {
  it.each(['Финансист', 'Ген директор', null])(
    'delivers exact assigned role %s with company profile and no PII or canonical writes',
    async (name) => {
      const s = setup(name);
      const output = await s.session.profile();
      expect(output).toMatchObject({
        viewer: {
          status: 'available',
          context: { userId, companyId, role: name === null ? null : { name }, observedAt: at },
        },
      });
      expect(JSON.stringify(output)).not.toContain('do-not-forward');
      const call = s.calls.find((url) => url.pathname.endsWith('/viewer-context'));
      expect(call?.pathname).toBe(`/user-service/internal/users/${userId}/viewer-context`);
      expect(call?.searchParams.get('companyId')).toBe(companyId);
      expect(s.analyze).not.toHaveBeenCalled();
    },
  );
  it('does not read a viewer without a persisted chat owner', async () => {
    const s = setup('Финансист');
    s.state.owner = null;
    await expect(s.session.profile()).rejects.toMatchObject({ code: 'ASSISTANT_NO_OWNER' });
    expect(s.calls).toEqual([]);
  });
  it('keeps unavailability distinct from a known null role and rejects foreign scope', async () => {
    const s = setup(null);
    s.state.fail = true;
    expect(await s.session.profile()).toMatchObject({ viewer: { status: 'unavailable' } });
    s.state.fail = false;
    s.state.viewerCompany = other;
    await expect(s.session.profile()).rejects.toMatchObject({ code: 'VIEWER_CONTEXT_SCOPE' });
  });
});
