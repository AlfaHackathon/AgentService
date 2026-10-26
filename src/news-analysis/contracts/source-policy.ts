// These source families are operational declarations/activity, never contract or budget proof.
const nonDocumentary = new Set([
  'company-bank-profile',
  'company-operational-declared-profile',
  'provided-bank-csv',
  'company-payment-activity',
  'company-payment-rows',
]);

export function isNonDocumentarySource(sourceId: string, additional: readonly string[] = []) {
  return nonDocumentary.has(sourceId) || additional.includes(sourceId);
}
