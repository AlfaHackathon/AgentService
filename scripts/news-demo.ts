// Clearly synthetic runnable example against the actual service APIs. No model responses are supplied.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { companyRunSchema } from '../src/news-analysis/contracts/flow.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const secret = process.env.INTERNAL_SECRET;
if (!secret) throw new Error('INTERNAL_SECRET required');
const context = process.env.CONTEXT_SERVICE_URL ?? 'http://127.0.0.1:5181/context-service';
const worker =
  process.env.NEWS_WORKER_URL ?? 'http://127.0.0.1:5184/agent-service/internal/news-analysis';
// Use a new identity for a fresh scenario; retain it for --correction and replay.
const newsMaterialId = process.env.NEWS_DEMO_NEWS_ID ?? 'demo-rate-news';
const insights = new InsightClient(
  process.env.INSIGHT_SERVICE_URL ?? 'http://127.0.0.1:5182/insight-service',
  secret,
);
const startedAt = Date.now();
async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret ?? '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const known = '2026-10-21T09:00:00Z';
const asOf = process.argv.includes('--correction')
  ? '2026-10-22T11:00:00Z'
  : '2026-10-22T10:00:00Z';
const version = process.argv.includes('--correction') ? 'v2' : 'v1';
const profiles = [
  {
    companyId: a,
    materialId: 'demo-steel-contract',
    name: 'СИНТЕТИЧЕСКИЙ Металл',
    description:
      'Производство металлоконструкций. Выданный кредит с плавающей ставкой, привязанной к ключевой ставке.',
    text: 'СИНТЕТИЧЕСКИЙ ДОГОВОР компании Металл. Договор К-204 подписан. Фактически выдано и остаётся непогашенным 12 000 000 RUB. До новости ключевая ставка 18% годовых. Договорная ставка равна ключевой плюс 2 процентных пункта без floor/cap. При изменении ключевой ставки с 1 ноября 2026 пересчёт договора происходит в тот же день. Для планового сравнения стандартного месяца использовать годовой процентный расход / 12. Комиссий нет. Сравнивать с исходной договорной ставкой 20% годовых. Это бюджетный run-rate, не фактически уплаченные проценты.',
    exposures: ['ключевая ставка', 'плавающий кредит'],
  },
  {
    companyId: b,
    materialId: 'demo-logistics-contract',
    name: 'СИНТЕТИЧЕСКАЯ Логистика',
    description:
      'Грузоперевозки. Кредит с фиксированной ставкой. Изменение ключевой ставки не меняет действующий договор.',
    text: 'СИНТЕТИЧЕСКИЙ ДОГОВОР компании Логистика. Договор Ф-80 подписан и выдан, остаток 6 000 000 RUB. Ставка фиксирована 19% годовых до конца 2027 года и не меняется вслед за ключевой. Иных кредитов или производных в этом полном примере нет. Снижение ключевой ставки не изменяет плановые расходы данного договора. Условий рефинансирования или права одностороннего пересмотра в документах нет.',
    exposures: ['фиксированный кредит', 'дизельное топливо'],
  },
  {
    companyId: c,
    materialId: 'demo-retail-profile',
    name: 'СИНТЕТИЧЕСКИЙ Магазин',
    description:
      'Розничная торговля. Кредиты и процентные обязательства отсутствуют в полном синтетическом примере.',
    text: 'СИНТЕТИЧЕСКИЙ ПОЛНЫЙ ПРОФИЛЬ компании Магазин. Продажа канцтоваров. Кредитов, займов и депозитов нет. Нет подтверждённых условий, позволяющих количественно связать новую ключевую ставку с продажами или издержками.',
    exposures: ['потребительский спрос'],
  },
];
const refs = new Map<string, { materialId: string; versionId: string; contentHash: string }>();
for (const profile of profiles) {
  const source = await post(context, '/internal/material-versions', {
    materialId: profile.materialId,
    versionId: '1',
    sourceId: 'synthetic-demo',
    kind: 'company',
    title: profile.name,
    text: profile.text,
    knownAt: known,
    publishedAt: known,
    correctsVersionId: null,
    companyIds: [profile.companyId],
    bankProfileIds: [],
  });
  const ref = {
    materialId: profile.materialId,
    versionId: '1',
    contentHash: String(source.contentHash),
  };
  refs.set(profile.companyId, ref);
  await post(context, '/internal/companies', {
    companyId: profile.companyId,
    revisionId: '1',
    bankProfileId: null,
    name: profile.name,
    description: profile.description,
    industryCodes: [],
    exposures: profile.exposures,
    knownAt: known,
    sourceRefs: [ref],
  });
}
const groupSource = await post(context, '/internal/material-versions', {
  materialId: 'demo-group-perimeter',
  versionId: '1',
  sourceId: 'synthetic-demo',
  kind: 'market',
  title: 'Синтетический явный периметр управленческой отчётности',
  text: `СИНТЕТИЧЕСКОЕ правило: группа demo-root включает собственную компанию ${a} и подгруппу demo-nested. Подгруппа включает ${a} и ${b}. Компания ${a} имеет два пути, учитывается один раз. Это полный периметр примера, управленческие расходы компаний суммируются только при совпадении валюты, периода, метрики и базиса.`,
  knownAt: known,
  publishedAt: known,
  correctsVersionId: null,
  companyIds: [],
  bankProfileIds: [],
});
const groupRef = {
  materialId: 'demo-group-perimeter',
  versionId: '1',
  contentHash: String(groupSource.contentHash),
};
await post(context, '/internal/groups', {
  groupId: 'demo-nested',
  revisionId: '2',
  name: 'СИНТЕТИЧЕСКАЯ подгруппа',
  knownAt: '2026-10-21T09:01:00Z',
  aggregationRule: 'sum_compatible_owner_effects',
  members: [
    { kind: 'company', id: a, sourceRefs: [groupRef] },
    { kind: 'company', id: b, sourceRefs: [groupRef] },
  ],
  sourceRefs: [groupRef],
});
await post(context, '/internal/groups', {
  groupId: 'demo-root',
  revisionId: '2',
  name: 'СИНТЕТИЧЕСКАЯ корневая группа',
  knownAt: '2026-10-21T09:01:00Z',
  aggregationRule: 'sum_compatible_owner_effects',
  members: [
    { kind: 'company', id: a, sourceRefs: [groupRef] },
    { kind: 'group', id: 'demo-nested', sourceRefs: [groupRef] },
  ],
  sourceRefs: [groupRef],
});
for (const role of [
  {
    personId: 'demo-cfo',
    companyId: a,
    role: 'Финансовый директор группы',
    responsibilities: ['Планирование расходов всей группы', 'Проверка кредитного бюджета'],
    allowedCompanyIds: [a, b],
    allowedMaterialIds: ['demo-steel-contract', 'demo-logistics-contract'],
  },
  {
    personId: 'demo-treasurer',
    companyId: b,
    role: 'Казначей компании Логистика',
    responsibilities: ['Платёжный календарь компании Логистика', 'Исполнение договора Ф-80'],
    allowedCompanyIds: [b],
    allowedMaterialIds: ['demo-logistics-contract'],
  },
]) {
  await post(context, '/internal/roles', {
    ...role,
    revisionId: '1',
    knownAt: known,
    sourceRefs: [refs.get(role.companyId)],
  });
}
await post(context, '/internal/material-versions', {
  materialId: newsMaterialId,
  versionId: version,
  sourceId: 'synthetic-central-bank',
  kind: 'news',
  title: 'СИНТЕТИЧЕСКОЕ объявление новой ключевой ставки',
  text:
    version === 'v1'
      ? 'СИНТЕТИЧЕСКАЯ НОВОСТЬ: ключевая ставка снижена с 18% до 16% годовых. Новая ставка начинает действовать 1 ноября 2026 года.'
      : 'СИНТЕТИЧЕСКОЕ ИСПРАВЛЕНИЕ прежнего сообщения: новая ключевая ставка с 1 ноября 2026 года составляет 16,5% годовых, а не 16%. Исходная ставка до изменения была 18%.',
  knownAt: asOf,
  publishedAt: asOf,
  correctsVersionId: version === 'v2' ? 'v1' : null,
  companyIds: [],
  bankProfileIds: [],
});
console.log(JSON.stringify({ seeded: true, synthetic: true, newsVersion: version }));
if (process.argv.includes('--seed-only')) process.exit(0);
const queued = await post(worker, '/news', {
  newsMaterialId,
  newsVersionId: version,
  asOf,
  groupIds: ['demo-root', 'demo-nested'],
  personIds: ['demo-cfo', 'demo-treasurer'],
  companyBudget: 8,
  textCompleteness: 'full',
});
console.log(JSON.stringify(queued));
let lastProgress = '';
const until = Date.now() + 15 * 60 * 1000;
while (Date.now() < until) {
  await delay(3000);
  const response = await fetch(`${worker}/jobs/${queued.jobId}`, {
    headers: { 'X-Internal-Secret': secret },
  });
  const job = (await response.json()) as {
    status: string;
    error?: string;
    checkpoint?: {
      companies?: unknown[];
      roleViews?: unknown[];
      result?: { coverage?: { completeForSelectedScopes?: boolean } };
    };
  };
  const progress = JSON.stringify({
    status: job.status,
    companies: job.checkpoint?.companies?.length ?? 0,
    roles: job.checkpoint?.roleViews?.length ?? 0,
  });
  if (progress !== lastProgress) console.log(progress);
  lastProgress = progress;
  if (job.status === 'completed' || job.status === 'failed') {
    console.log(
      JSON.stringify(job.checkpoint?.result ?? { status: job.status, error: job.error }, null, 2),
    );
    if (process.env.NEWS_DEMO_OUTPUT)
      await writeFile(process.env.NEWS_DEMO_OUTPUT, JSON.stringify(job, null, 2));
    if (job.status === 'completed' && job.checkpoint?.result?.coverage?.completeForSelectedScopes) {
      const result = z
        .object({
          companies: z.array(companyRunSchema),
          groups: z.array(
            z.object({
              groupId: z.string(),
              complete: z.boolean(),
              totals: z.array(
                z.object({ fullTotal: z.string().nullable(), effectIds: z.array(z.string()) }),
              ),
            }),
          ),
          roles: z.array(
            z.object({
              personId: z.string(),
              status: z.string(),
              facts: z.array(z.object({ companyId: z.string(), effectId: z.string() })),
              groups: z.array(z.object({ groupId: z.string() })),
              actions: z.array(z.object({ effectIds: z.array(z.string()) })),
              missingContext: z.array(z.string()),
            }),
          ),
        })
        .parse(job.checkpoint.result);
      assert.equal(result.companies.length, 3);
      const steel = result.companies.find((run) => run.companyId === a)?.receipt?.effects;
      assert.ok(steel && steel.length === 1, 'Exactly one K-204 consequence');
      const effect = steel[0];
      assert.ok(effect);
      const expectedAmount = version === 'v1' ? '-20000' : '-15000';
      assert.equal(effect.currentRevision.calculationResult, expectedAmount);
      for (const groupId of ['demo-root', 'demo-nested']) {
        const group = result.groups.find((group) => group.groupId === groupId);
        assert.ok(group?.complete);
        assert.equal(group.totals.length, 1);
        assert.equal(group.totals[0]?.fullTotal, expectedAmount);
        assert.deepEqual(group.totals[0]?.effectIds, [effect.effectId]);
      }
      for (const companyId of [b, c]) {
        const effects = result.companies.find((run) => run.companyId === companyId)?.receipt
          ?.effects;
        assert.ok(effects);
        assert.ok(
          effects.every(
            (e) =>
              e.currentRevision.calculationResult == null ||
              e.currentRevision.calculationResult === '0',
          ),
          'No invented numerical exposure',
        );
      }
      for (const role of result.roles) {
        assert.equal(role.status, 'completed');
        if (role.personId === 'demo-cfo') assert.ok(role.actions.length > 0);
        else
          assert.ok(
            role.actions.length > 0 || role.missingContext.length > 0,
            'An unaffected role can explain why no action is warranted',
          );
        const allowed = role.personId === 'demo-cfo' ? [a, b] : [b];
        assert.ok(role.facts.every((fact) => allowed.includes(fact.companyId)));
        const visibleIds = new Set(role.facts.map((fact) => fact.effectId));
        assert.ok(
          role.actions.every((action) => action.effectIds.every((id) => visibleIds.has(id))),
        );
        assert.deepEqual(
          role.groups.map((group) => group.groupId).sort(),
          role.personId === 'demo-cfo' ? ['demo-nested', 'demo-root'] : [],
        );
      }
      if (version === 'v2') {
        const actual = (
          await insights.getEffects({ companyId: a, newsMaterialId, newsVersionId: version, asOf })
        ).find((e) => e.effectId === effect.effectId);
        assert.ok(actual);
        assert.deepEqual(
          actual.history.map((revision) => revision.newsVersionId),
          ['v1', 'v2'],
        );
        assert.equal(actual.history[0]?.calculationResult, '-20000');
        assert.equal(actual.currentRevision.calculationResult, '-15000');
        assert.equal(effect.previousRevisionId, actual.history[0]?.revisionId);
      }
      console.log(
        JSON.stringify({
          verified: true,
          synthetic: true,
          newsMaterialId,
          version,
          amount: expectedAmount,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }
    process.exit(
      job.status === 'completed' && job.checkpoint?.result?.coverage?.completeForSelectedScopes
        ? 0
        : 1,
    );
  }
}
throw new Error('Demo observation timed out; durable job remains queryable');
