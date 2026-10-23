import type { FlowCheckpoint, FlowRequest, NewsPlan } from '../contracts/flow.ts';
import type { CompanyClient } from '../retrieval/company-client.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
export async function selectCompanies(
  companies: CompanyClient,
  analyzer: NewsAnalyzer,
  request: FlowRequest,
  checkpoint: FlowCheckpoint,
  plan: NewsPlan,
) {
  const previous = request.targetCompanyIds.length
    ? { companyIds: [], nextCursor: null }
    : await analyzer.recipients(request.asOf);
  const selection = await companies.select(request, plan.queries, previous.companyIds);
  checkpoint.recipientCursor = previous.nextCursor;
  checkpoint.groups = selection.groups;
  checkpoint.selectedCompanyIds = selection.selectedCompanyIds;
  checkpoint.pendingCompanyIds = selection.pendingCompanyIds;
}
