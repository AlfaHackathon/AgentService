import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const feature = 'src/news-analysis/';
const normalize = (value: string) => value.split(sep).join('/');
type Edge = { target: string; typeOnly: boolean };

/** Inspect static, inline type, re-export and dynamic import edges using the TS parser. */
export function newsBoundaryViolations(file: string, source: string): string[] {
  const name = normalize(file);
  if (!name.startsWith(feature)) return [];
  const layer = name.slice(feature.length).split('/')[0];
  if (
    !['contracts', 'application', 'retrieval', 'reasoning', 'transport', 'composition'].includes(
      layer ?? '',
    )
  )
    return [`${name}: declare ownership in an existing news-analysis layer`];
  const edges: Edge[] = [];
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (!!bindings &&
          ts.isNamedImports(bindings) &&
          !clause?.name &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
      edges.push({ target: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier))
        edges.push({ target: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal))
        edges.push({ target: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      edges.push({ target: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return edges.flatMap((edge) => {
    const target = edge.target.startsWith('.')
      ? normalize(relative(process.cwd(), resolve(dirname(name), edge.target)))
      : edge.target;
    if (!target.startsWith(feature)) {
      // Core boundaries may use schema/standard-library code, never runtime agents/frameworks.
      if (
        layer !== 'composition' &&
        layer !== 'reasoning' &&
        (target.startsWith('src/') || target.startsWith('@flue/'))
      )
        return [`${name}: ${layer} cannot depend on ${target}`];
      if (
        ['contracts', 'application', 'retrieval'].includes(layer ?? '') &&
        !target.startsWith('node:') &&
        target !== 'zod'
      )
        return [`${name}: ${layer} cannot load external runtime ${target}`];
      return [];
    }
    const targetLayer = target.slice(feature.length).split('/')[0];
    const same = layer === targetLayer;
    const contracts = targetLayer === 'contracts';
    const httpPrimitive = target === `${feature}transport/http/service-client.ts`;
    const pureRetrieval = [
      `${feature}retrieval/source-catalog.ts`,
      `${feature}retrieval/source-units.ts`,
      `${feature}retrieval/plan-coverage.ts`,
    ].includes(target);
    const allowed =
      layer === 'composition' ||
      same ||
      contracts ||
      (layer === 'application' &&
        targetLayer === 'retrieval' &&
        (edge.typeOnly || pureRetrieval)) ||
      (layer === 'retrieval' && httpPrimitive) ||
      (layer === 'reasoning' && targetLayer === 'retrieval') ||
      (layer === 'transport' && edge.typeOnly && targetLayer === 'application');
    return allowed ? [] : [`${name}: ${layer} cannot depend on ${target}`];
  });
}

export function checkNewsBoundaries(root = resolve('src/news-analysis')): string[] {
  const violations: string[] = [];
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.name.endsWith('.ts'))
        violations.push(
          ...newsBoundaryViolations(
            normalize(relative(process.cwd(), file)),
            readFileSync(file, 'utf8'),
          ),
        );
    }
  };
  walk(root);
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = checkNewsBoundaries();
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else console.log('News analysis dependency boundaries passed');
}
