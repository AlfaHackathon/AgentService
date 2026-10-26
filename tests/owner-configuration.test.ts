import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredNewsAnalysis } from '../src/news-analysis/composition/configuration.ts';
import { serviceSettingsSchema } from '../src/news-analysis/transport/http/settings.ts';

const environment = {
  INTERNAL_SECRET: 'synthetic-secret',
  COMPANY_SERVICE_URL: 'http://company.test',
  CONTEXT_SERVICE_URL: 'http://context.test',
  INSIGHT_SERVICE_URL: 'http://insight.test',
};
const configured: NonNullable<ReturnType<typeof createConfiguredNewsAnalysis>>[] = [];
afterEach(async () => {
  await Promise.all(configured.splice(0).map((value) => value.stop?.()));
  vi.unstubAllGlobals();
});

describe('owner context composition', () => {
  it('leaves the existing flow unchanged until explicitly configured', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    const result = createConfiguredNewsAnalysis(environment);
    if (result) configured.push(result);
    expect(result?.analyzer.dependencies.owners).toBeUndefined();
  });
  it('wires an owner reader without requiring User deployment or payment configuration', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    const result = createConfiguredNewsAnalysis({
      ...environment,
      NEWS_OWNER_CONTEXT_ENABLED: 'true',
    });
    if (result) configured.push(result);
    expect(result?.analyzer.dependencies.owners).toBeDefined();
  });
  it('rejects partial payment source configuration instead of choosing or dropping a version', () => {
    expect(
      serviceSettingsSchema.safeParse({
        ...environment,
        NEWS_OWNER_CONTEXT_ENABLED: 'true',
        NEWS_PAYMENT_SOURCE_ID: 'synthetic-dataset',
      }).success,
    ).toBe(false);
    expect(
      serviceSettingsSchema.safeParse({
        ...environment,
        NEWS_OWNER_CONTEXT_ENABLED: 'true',
        NEWS_PAYMENT_SOURCE_VERSION_ID: 'v1',
      }).success,
    ).toBe(false);
    expect(
      serviceSettingsSchema.safeParse({
        ...environment,
        NEWS_OWNER_CONTEXT_ENABLED: 'true',
        NEWS_PAYMENT_SOURCE_ID: 'synthetic-dataset',
        NEWS_PAYMENT_SOURCE_VERSION_ID: 'v1',
      }).success,
    ).toBe(true);
  });
  it('rejects credentials in the User service URL and invalid owner enable settings', () => {
    expect(
      serviceSettingsSchema.safeParse({
        ...environment,
        USER_SERVICE_URL: 'http://user:password@user.test',
      }).success,
    ).toBe(false);
    expect(
      serviceSettingsSchema.safeParse({ ...environment, NEWS_OWNER_CONTEXT_ENABLED: 'yes' })
        .success,
    ).toBe(false);
  });
});
