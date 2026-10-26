import { describe, expect, it } from 'vitest';
import { OwnerContextClient } from '../src/news-analysis/retrieval/owner-context.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const personId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const knownAt = '2026-10-26T10:00:00.0000000Z';
const asOf = '2026-10-26T10:00:00.0000001Z';
const bankData = {
  orgType: 'opaque-org',
  okfsName: 'opaque-ownership',
  companyAgeYearsGradation: '3–5',
  ecoMarkLabel: 'unknown-code',
  mainOkvedCode: '01.11.01',
  mainOkvedName: 'Synthetic industry',
  negativeMark: 'N-as-source',
  amountWorkersFnsGradation: '11–20',
  amountWorkersSparkGradation: '21–30',
  clType: 'opaque-type',
  clProductRkoMark: '01',
  clProductGarMark: '0',
  clProductLoaMark: '1',
  clProductLeaMark: 'Y',
  clProductDepMark: 'false-as-source-string',
  clProductZppMark: '',
  ftsFlag: 'opaque-flag',
  ftsCountryName: 'Synthetic country',
  factoringMark: null,
  revenueCompany: '000123456789012345678901234567890.12345678901234567890',
  groupId: foreign,
  city: 'Synthetic city',
  region: 'Synthetic region',
};
const bankProfile = {
  companyId,
  revisionId: 'bank-capture-r1',
  knownAt,
  bankData,
  sourceId: 'company-bank-profile',
  sourceRefs: [
    {
      materialId: `company-bank-${companyId}`,
      versionId: 'capture-r1',
      contentHash: 'a'.repeat(64),
    },
  ],
  provenance: {
    acquisition: 'event_payload',
    sourceUrl: null,
    retrievedAt: knownAt,
    textCompleteness: 'full',
    originVersionId: null,
    locator: null,
  },
};
const sourceAccount = {
  userId,
  sourcePersonId: personId,
  companyId,
  revisionId: 'source-r1',
  knownAt,
  contentHash: 'b'.repeat(64),
  sourceOwner: 'user-service',
  serviceGeography: { cityName: 'Source service city', rcName: null },
  provenance: { sourceId: 'source-people', versionId: 'v1', contentHash: 'c'.repeat(64) },
};
const viewer = {
  userId,
  companyId,
  revisionId: 'viewer-r1',
  knownAt,
  contentHash: 'd'.repeat(64),
  sourceOwner: 'user-service',
  role: { id: foreign, name: 'Финансист', isDefault: false },
  serviceGeography: { cityName: null, rcName: 'Service office' },
  provenance: { sourceId: 'source-viewer', versionId: 'v1', contentHash: 'e'.repeat(64) },
};
const paymentActivity = {
  companyId,
  sourceId: 'logical-payments',
  sourceVersionId: 'manifest-v1',
  sourceContentHash: 'f'.repeat(64),
  asOf,
  currency: 'RUB',
  period: { basis: 'since_january_1', year: null, end: null },
  incoming: {
    payAmt: '99999999999999999999999999999999.123456789',
    payCnt: '999999999999999999999999999999',
    observedRowCount: '1',
  },
  outgoing: { payAmt: '-0.00000000001', payCnt: '0', observedRowCount: '1' },
  selfTransfer: { payAmt: '1000.00', payCnt: '10', observedRowCount: '1' },
  coverage: { complete: null, observedRowCount: '3', watermark: '9007199254740993' },
  provenance: { sourceKnownAt: knownAt, observedKnownAt: knownAt, basis: 'observed_source_rows' },
};
const base = {
  companyUrl: 'https://company.fixture/company-service',
  userUrl: 'https://user.fixture/user-service',
  secret: 'synthetic-owner-secret',
};

function setup(
  values: { bank?: unknown; payments?: unknown; account?: unknown; viewer?: unknown } = {},
) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    let value: unknown;
    if (url.pathname.includes('/bank-profiles/'))
      value = values.bank === undefined ? bankProfile : values.bank;
    else if (url.pathname.includes('/payment-activity/'))
      value = values.payments === undefined ? paymentActivity : values.payments;
    else if (url.pathname.endsWith('/source-accounts/by-pair'))
      value = values.account === undefined ? sourceAccount : values.account;
    else if (url.pathname.endsWith('/viewer-context'))
      value = values.viewer === undefined ? viewer : values.viewer;
    else throw new Error('Unexpected fixture URL');
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { fetcher, calls };
}
const missing = () => new Response('{}', { status: 404 });

describe('owner declared context boundary without model or live services', () => {
  it('preserves all 23 raw bank fields and keeps viewer data out of the company block', async () => {
    const f = setup();
    const result = await new OwnerContextClient(base, f.fetcher).company(companyId, asOf);
    expect(result.bankProfile?.bankData).toEqual(bankData);
    expect(Object.keys(result.bankProfile?.bankData ?? {})).toHaveLength(23);
    expect(result.paymentActivity).toBeNull();
    expect(result).not.toHaveProperty('viewer');
    expect(result).not.toHaveProperty('role');
    expect(result.usage.evidence).toBe('declared_context_not_documentary_proof');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url.searchParams.get('asOf')).toBe(asOf);
    expect(f.calls[0]?.init?.method).toBe('GET');
    expect(new Headers(f.calls[0]?.init?.headers).get('X-Internal-Secret')).toBe(base.secret);
  });

  it('loads payments only for the exact configured source/version and preserves strings and unknown metadata', async () => {
    const f = setup();
    const client = new OwnerContextClient(
      {
        ...base,
        payments: {
          sourceId: paymentActivity.sourceId,
          sourceVersionId: paymentActivity.sourceVersionId,
        },
      },
      f.fetcher,
    );
    const result = await client.company(companyId, asOf);
    expect(result.paymentActivity).toEqual(paymentActivity);
    expect(result.paymentActivity?.period).toEqual({
      basis: 'since_january_1',
      year: null,
      end: null,
    });
    expect(result.paymentActivity?.coverage.complete).toBeNull();
    expect(result.paymentActivity?.selfTransfer.payAmt).toBe('1000.00');
    const call = f.calls.find((c) => c.url.pathname.includes('payment-activity'));
    expect(call?.url.searchParams.get('sourceId')).toBe(paymentActivity.sourceId);
    expect(call?.url.searchParams.get('sourceVersionId')).toBe(paymentActivity.sourceVersionId);
  });

  it('retains bank 404/payment 404 as unknown and makes no fallback or capture calls', async () => {
    const f = setup({ bank: missing(), payments: missing() });
    const result = await new OwnerContextClient(
      { ...base, payments: { sourceId: 'source', sourceVersionId: 'version' } },
      f.fetcher,
    ).company(companyId, asOf);
    expect(result.bankProfile).toBeNull();
    expect(result.paymentActivity).toBeNull();
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => c.init?.method === 'GET')).toBe(true);
  });

  it('does not select or guess a payment version from incomplete configuration', async () => {
    const f = setup();
    const result = await new OwnerContextClient(
      { ...base, payments: { sourceId: '', sourceVersionId: 'version' } },
      f.fetcher,
    ).company(companyId, asOf);
    expect(result.paymentActivity).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('resolves F/company through by-pair before reading the resolved account viewer and sanitizes F', async () => {
    const f = setup();
    const result = await new OwnerContextClient(base, f.fetcher).recipient(
      personId,
      companyId,
      asOf,
    );
    expect(f.calls.map((c) => c.url.pathname)).toEqual([
      '/user-service/internal/source-accounts/by-pair',
      `/user-service/internal/users/${userId}/viewer-context`,
    ]);
    expect(f.calls[0]?.url.searchParams.get('sourcePersonId')).toBe(personId);
    expect(f.calls[1]?.url.searchParams.get('companyId')).toBe(companyId);
    expect(result?.sourceAccount.userId).toBe(userId);
    expect(result?.sourceAccount.contentHash).toBe(sourceAccount.contentHash);
    expect(result?.viewer).toEqual(viewer);
    expect(result?.sourceAccount.serviceGeography.cityName).toBe('Source service city');
    expect(result?.sourceAccount).not.toHaveProperty('sourcePersonId');
    expect(JSON.stringify(result)).not.toContain(personId);
  });

  it('does not infer userId for non-UUID person IDs or an unconfigured User service', async () => {
    const f = setup();
    const client = new OwnerContextClient(base, f.fetcher);
    expect(await client.recipient('legacy-person-tag', companyId, asOf)).toBeNull();
    expect(
      await new OwnerContextClient(
        { companyUrl: base.companyUrl, secret: base.secret },
        f.fetcher,
      ).recipient(personId, companyId, asOf),
    ).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('distinguishes absent mapping from absent viewer without fabricating role or viewer coverage', async () => {
    const missingMapping = setup({ account: missing() });
    expect(
      await new OwnerContextClient(base, missingMapping.fetcher).recipient(
        personId,
        companyId,
        asOf,
      ),
    ).toBeNull();
    expect(missingMapping.calls).toHaveLength(1);
    const missingViewer = setup({ viewer: missing() });
    const result = await new OwnerContextClient(base, missingViewer.fetcher).recipient(
      personId,
      companyId,
      asOf,
    );
    expect(result?.sourceAccount.userId).toBe(userId);
    expect(result?.viewer).toBeNull();
  });

  it.each([
    { account: { ...sourceAccount, sourcePersonId: foreign } },
    { account: { ...sourceAccount, companyId: foreign } },
    { account: { ...sourceAccount, knownAt: '2026-10-26T10:00:00.0000002Z' } },
    { viewer: { ...viewer, userId: foreign } },
    { viewer: { ...viewer, companyId: foreign } },
    { viewer: { ...viewer, knownAt: '2026-10-26T10:00:00.0000002Z' } },
  ])('rejects recipient scope/time mismatches at 100ns precision', async (values) => {
    const f = setup(values);
    await expect(
      new OwnerContextClient(base, f.fetcher).recipient(personId, companyId, asOf),
    ).rejects.toMatchObject({ status: 502, code: 'DECLARED_CONTEXT_SCOPE' });
    if ('account' in values) expect(f.calls).toHaveLength(1);
  });

  it.each([
    { viewer: { ...viewer, email: 'synthetic@example.invalid' } },
    { viewer: { ...viewer, hashedPassword: 'not-a-real-hash' } },
    { viewer: { ...viewer, allowedCompanyIds: [foreign] } },
    { viewer: { ...viewer, contentHash: `${'d'.repeat(64)}\n` } },
    { viewer: { ...viewer, knownAt: `${knownAt}\n` } },
    { viewer: { ...viewer, serviceGeography: { cityName: '\0', rcName: null } } },
    { account: { ...sourceAccount, role: viewer.role } },
    { bank: { ...bankProfile, bankData: { ...bankData, clProductRkoMark: true } } },
    { bank: { ...bankProfile, bankData: { ...bankData, mainOkvedCode: undefined } } },
  ])(
    'rejects PII/ACL fields, missing nullable fields, flag coercion and invalid hashes',
    async (values) => {
      const f = setup(values);
      const client = new OwnerContextClient(base, f.fetcher);
      const work =
        'bank' in values
          ? client.company(companyId, asOf)
          : client.recipient(personId, companyId, asOf);
      await expect(work).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_CONTRACT' });
    },
  );

  it.each([
    { ...bankProfile, companyId: foreign },
    { ...bankProfile, knownAt: '2026-10-26T10:00:00.0000002Z' },
    { ...bankProfile, provenance: { ...bankProfile.provenance, retrievedAt: asOf } },
  ])('rejects bank scope/time/provenance mismatches', async (bank) => {
    const f = setup({ bank });
    await expect(
      new OwnerContextClient(base, f.fetcher).company(companyId, asOf),
    ).rejects.toMatchObject({ status: 502, code: 'DECLARED_CONTEXT_SCOPE' });
  });

  it.each([
    { ...paymentActivity, companyId: foreign },
    { ...paymentActivity, sourceId: 'other-source' },
    { ...paymentActivity, sourceVersionId: 'other-version' },
    { ...paymentActivity, asOf: '2026-10-26T10:00:00.0000002Z' },
    {
      ...paymentActivity,
      provenance: {
        ...paymentActivity.provenance,
        observedKnownAt: '2026-10-26T10:00:00.0000002Z',
      },
    },
    {
      ...paymentActivity,
      provenance: { ...paymentActivity.provenance, sourceKnownAt: asOf, observedKnownAt: knownAt },
    },
  ])('rejects payment scope/version/asOf/provenance mismatches', async (payments) => {
    const f = setup({ payments });
    await expect(
      new OwnerContextClient(
        {
          ...base,
          payments: {
            sourceId: paymentActivity.sourceId,
            sourceVersionId: paymentActivity.sourceVersionId,
          },
        },
        f.fetcher,
      ).company(companyId, asOf),
    ).rejects.toMatchObject({ status: 502, code: 'DECLARED_CONTEXT_SCOPE' });
  });

  it('propagates membership denial and upstream failures without pretending they are missing', async () => {
    const f = setup({
      viewer: new Response(JSON.stringify({ code: 'NO_MEMBERSHIP', message: 'Synthetic denial' }), {
        status: 403,
      }),
    });
    await expect(
      new OwnerContextClient(base, f.fetcher).recipient(personId, companyId, asOf),
    ).rejects.toMatchObject({ status: 403, code: 'NO_MEMBERSHIP' });
    const bankFailure = setup({
      bank: new Response(
        JSON.stringify({ code: 'UNAVAILABLE', message: 'Synthetic unavailable' }),
        { status: 503 },
      ),
    });
    await expect(
      new OwnerContextClient(base, bankFailure.fetcher).company(companyId, asOf),
    ).rejects.toMatchObject({ status: 502, code: 'UNAVAILABLE' });
  });

  it('fails the complete combined budget rather than dropping any bank fields, payments or service geography', async () => {
    const f = setup({
      bank: { ...bankProfile, bankData: { ...bankData, orgType: 'x'.repeat(48000) } },
    });
    await expect(
      new OwnerContextClient(base, f.fetcher).company(companyId, asOf),
    ).rejects.toMatchObject({ status: 422, code: 'DECLARED_CONTEXT_BUDGET' });
    const recipient = setup({
      account: {
        ...sourceAccount,
        serviceGeography: { cityName: 'x'.repeat(16000), rcName: 'x'.repeat(16000) },
      },
      viewer: {
        ...viewer,
        serviceGeography: { cityName: 'x'.repeat(16000), rcName: 'x'.repeat(16000) },
      },
    });
    await expect(
      new OwnerContextClient(base, recipient.fetcher).recipient(personId, companyId, asOf),
    ).rejects.toMatchObject({ status: 422, code: 'DECLARED_CONTEXT_BUDGET' });
  });

  it('freezes configured payment identity and applies budget per complete block rather than client lifetime', async () => {
    const f = setup();
    const payments = {
      sourceId: paymentActivity.sourceId,
      sourceVersionId: paymentActivity.sourceVersionId,
    };
    const client = new OwnerContextClient({ ...base, payments }, f.fetcher);
    payments.sourceVersionId = 'changed-after-construction';
    expect((await client.company(companyId, asOf)).paymentActivity?.sourceVersionId).toBe(
      paymentActivity.sourceVersionId,
    );
    const bounded = new OwnerContextClient({ ...base, maximumCharacters: 3000 }, f.fetcher);
    for (let i = 0; i < 20; i++)
      expect((await bounded.company(companyId, asOf)).bankProfile?.bankData).toEqual(bankData);
  });
});
