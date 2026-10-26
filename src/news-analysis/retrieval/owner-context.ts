import {
  companyBankProfileSchema,
  type DeclaredCompanyContext,
  type DeclaredRecipientContext,
  declaredContextUsage,
  declaredRecipientUsage,
  ownerTimestampSchema,
  ownerUuidSchema,
  paymentActivitySchema,
  paymentSourceIdentitySchema,
  sourceAccountSchema,
  viewerContextSchema,
} from '../contracts/declared-context.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { instantAfter, sameInstant } from '../contracts/timestamps.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

type Options = {
  companyUrl: string;
  secret: string;
  userUrl?: string | undefined;
  payments?: { sourceId: string; sourceVersionId: string } | undefined;
  maximumCharacters?: number | undefined;
};
const scopeError = () =>
  new NewsAnalysisError(
    502,
    'DECLARED_CONTEXT_SCOPE',
    'Owner context changed the requested identity, source version or knowledge time.',
  );
const sameUuid = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export class OwnerContextClient {
  private readonly companyHttp: ServiceClient;
  private readonly userHttp: ServiceClient | undefined;
  private readonly payments: Options['payments'];
  private readonly maximumCharacters: number;

  constructor(options: Options, fetcher = fetch) {
    this.companyHttp = new ServiceClient(options.companyUrl, options.secret, fetcher);
    this.userHttp = options.userUrl
      ? new ServiceClient(options.userUrl, options.secret, fetcher)
      : undefined;
    this.payments =
      options.payments &&
      paymentSourceIdentitySchema.safeParse(options.payments.sourceId).success &&
      paymentSourceIdentitySchema.safeParse(options.payments.sourceVersionId).success
        ? { sourceId: options.payments.sourceId, sourceVersionId: options.payments.sourceVersionId }
        : undefined;
    this.maximumCharacters = options.maximumCharacters ?? 48000;
    if (!Number.isSafeInteger(this.maximumCharacters) || this.maximumCharacters < 1)
      throw new NewsAnalysisError(
        503,
        'DECLARED_CONTEXT_CONFIG',
        'A positive declared context character budget is required.',
      );
  }

  private scope(companyId: string, asOf: string) {
    if (
      !ownerUuidSchema.safeParse(companyId).success ||
      !ownerTimestampSchema.safeParse(asOf).success
    )
      throw new NewsAnalysisError(
        422,
        'DECLARED_CONTEXT_INPUT',
        'An explicit Company UUID and knowledge time are required.',
      );
    return { companyId: companyId.toLowerCase(), asOf };
  }
  private budget<T>(context: T): T {
    // Bound the complete combined block, without retaining client-lifetime state or truncating fields.
    if (JSON.stringify(context).length > this.maximumCharacters)
      throw new NewsAnalysisError(
        422,
        'DECLARED_CONTEXT_BUDGET',
        'Complete declared owner context exceeds the character budget; no fields were truncated.',
      );
    return context;
  }

  async company(companyId: string, asOf: string): Promise<DeclaredCompanyContext> {
    const scope = this.scope(companyId, asOf);
    const query = new URLSearchParams({ asOf });
    const paymentQuery = this.payments
      ? new URLSearchParams({
          sourceId: this.payments.sourceId,
          sourceVersionId: this.payments.sourceVersionId,
          asOf,
        })
      : null;
    const [rawBank, rawPayments] = await Promise.all([
      this.companyHttp.request(
        `/internal/bank-profiles/${scope.companyId}?${query}`,
        undefined,
        true,
      ),
      paymentQuery
        ? this.companyHttp.request(
            `/internal/payment-activity/${scope.companyId}?${paymentQuery}`,
            undefined,
            true,
          )
        : Promise.resolve(null),
    ]);
    const bankProfile = rawBank === null ? null : parseResponse(companyBankProfileSchema, rawBank);
    const paymentActivity =
      rawPayments === null ? null : parseResponse(paymentActivitySchema, rawPayments);
    if (
      bankProfile &&
      (!sameUuid(bankProfile.companyId, scope.companyId) ||
        instantAfter(bankProfile.knownAt, asOf) ||
        !sameInstant(bankProfile.provenance.retrievedAt, bankProfile.knownAt))
    )
      throw scopeError();
    if (
      paymentActivity &&
      (!sameUuid(paymentActivity.companyId, scope.companyId) ||
        paymentActivity.sourceId !== this.payments?.sourceId ||
        paymentActivity.sourceVersionId !== this.payments?.sourceVersionId ||
        !sameInstant(paymentActivity.asOf, asOf) ||
        instantAfter(paymentActivity.provenance.observedKnownAt, asOf) ||
        instantAfter(
          paymentActivity.provenance.sourceKnownAt,
          paymentActivity.provenance.observedKnownAt,
        ))
    )
      throw scopeError();
    return this.budget({ ...scope, bankProfile, paymentActivity, usage: declaredContextUsage });
  }

  async recipient(
    personId: string,
    companyId: string,
    asOf: string,
  ): Promise<DeclaredRecipientContext | null> {
    if (!this.userHttp || !ownerUuidSchema.safeParse(personId).success) return null;
    const scope = this.scope(companyId, asOf);
    const query = new URLSearchParams({
      sourcePersonId: personId.toLowerCase(),
      companyId: scope.companyId,
      asOf,
    });
    const rawAccount = await this.userHttp.request(
      `/internal/source-accounts/by-pair?${query}`,
      undefined,
      true,
    );
    if (rawAccount === null) return null;
    const account = parseResponse(sourceAccountSchema, rawAccount);
    if (
      !sameUuid(account.sourcePersonId, personId) ||
      !sameUuid(account.companyId, scope.companyId) ||
      instantAfter(account.knownAt, asOf)
    )
      throw scopeError();
    const viewerQuery = new URLSearchParams({ companyId: scope.companyId, asOf });
    const rawViewer = await this.userHttp.request(
      `/internal/users/${account.userId.toLowerCase()}/viewer-context?${viewerQuery}`,
      undefined,
      true,
    );
    const viewer = rawViewer === null ? null : parseResponse(viewerContextSchema, rawViewer);
    if (
      viewer &&
      (!sameUuid(viewer.userId, account.userId) ||
        !sameUuid(viewer.companyId, scope.companyId) ||
        instantAfter(viewer.knownAt, asOf))
    )
      throw scopeError();
    // Explicit projection excludes the source-person UUID, PII and permission fields.
    const sourceAccount = {
      userId: account.userId,
      companyId: account.companyId,
      revisionId: account.revisionId,
      knownAt: account.knownAt,
      contentHash: account.contentHash,
      sourceOwner: account.sourceOwner,
      serviceGeography: account.serviceGeography,
      provenance: account.provenance,
    };
    return this.budget({ ...scope, sourceAccount, viewer, usage: declaredRecipientUsage });
  }
}
