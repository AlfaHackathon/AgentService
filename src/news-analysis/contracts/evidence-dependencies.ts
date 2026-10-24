import { NewsAnalysisError } from './errors.ts';

type Condition = {
  id?: string | undefined;
  assertion?: 'observed' | 'derived' | 'conditional' | undefined;
  dependsOn?: string[] | undefined;
  status: 'supported' | 'contradicted' | 'unknown';
};
type Assessment = {
  conditions: Condition[];
  unknowns: { id?: string | undefined }[];
  applicability?: { status: string; basis: string; assumptions: string[] } | undefined;
};

const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
function invalid(): never {
  throw new NewsAnalysisError(
    400,
    'INVALID_EVIDENCE_DEPENDENCIES',
    'Invalid evidence dependencies.',
  );
}

// This checks declared dependencies, not natural-language entailment. Historical
// assessments with no metadata remain readable; do not invent metadata for them.
export function validateEvidenceDependencies(assessment?: Assessment, evidenceStatus?: string) {
  if (!assessment) return;
  const { conditions, unknowns } = assessment;
  const present =
    conditions.some(
      (condition) =>
        condition.id !== undefined ||
        condition.assertion !== undefined ||
        condition.dependsOn !== undefined,
    ) || unknowns.some((unknown) => unknown.id !== undefined);
  if (!present) return;
  if (conditions.length > 16 || unknowns.length > 16) invalid();
  const nodes = new Map<string, Condition | null>();
  for (const node of [...conditions, ...unknowns]) {
    if (!node.id || !identifier.test(node.id) || nodes.has(node.id)) invalid();
    nodes.set(node.id, null);
  }
  for (const condition of conditions) {
    if (
      !condition.id ||
      !condition.assertion ||
      !['observed', 'derived', 'conditional'].includes(condition.assertion) ||
      !Array.isArray(condition.dependsOn) ||
      condition.dependsOn.length > 16 ||
      new Set(condition.dependsOn).size !== condition.dependsOn.length ||
      condition.dependsOn.some((id) => !identifier.test(id) || !nodes.has(id)) ||
      (condition.assertion === 'observed' && condition.dependsOn.length !== 0) ||
      (condition.assertion !== 'observed' && condition.dependsOn.length === 0)
    )
      invalid();
    nodes.set(condition.id, condition);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) invalid();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  const support = new Map<string, boolean>();
  function supported(id: string): boolean {
    const known = support.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id);
    const result =
      !!node &&
      node.status === 'supported' &&
      (node.dependsOn ?? []).every((dependency) => supported(dependency));
    support.set(id, result);
    return result;
  }
  for (const condition of conditions) {
    if (
      condition.assertion === 'derived' &&
      condition.status === 'supported' &&
      !condition.dependsOn?.every((dependency) => supported(dependency))
    )
      throw new NewsAnalysisError(
        422,
        'UNSUPPORTED_EVIDENCE_DEPENDENCY',
        'A supported derived condition requires supported evidence dependencies.',
      );
    if (
      condition.assertion === 'conditional' &&
      (condition.status !== 'unknown' ||
        evidenceStatus !== 'conditional' ||
        assessment.applicability?.status !== 'established' ||
        assessment.applicability.basis !== 'documented_exposure' ||
        !assessment.applicability.assumptions.length)
    )
      throw new NewsAnalysisError(
        422,
        'INVALID_CONDITIONAL_EVIDENCE',
        'Conditional evidence requires an unresolved scenario on established exposure with explicit assumptions.',
      );
  }
}
