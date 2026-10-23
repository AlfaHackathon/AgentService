import type { DecimalExpression } from '../contracts/analysis.ts';

// Parses a bounded arithmetic language into the service AST; never evaluates code or money.
export function parseArithmetic(text: string): DecimalExpression {
  if (text.length > 2000) throw new Error('Arithmetic expression exceeds its budget');
  const tokens: string[] = [];
  const token = /\s*(\d+(?:\.\d+)?|min|max|[()+\-*/,])/y;
  let at = 0;
  while (at < text.trimEnd().length) {
    token.lastIndex = at;
    const found = token.exec(text);
    if (!found?.[1]) throw new Error('Unsupported arithmetic syntax');
    tokens.push(found[1]);
    at = token.lastIndex;
    if (tokens.length > 255) throw new Error('Arithmetic token budget exceeded');
  }
  let cursor = 0;
  function expression(minimum: number, depth: number): DecimalExpression {
    if (depth > 12) throw new Error('Arithmetic nesting budget exceeded');
    const current = tokens[cursor++];
    let left: DecimalExpression;
    if (current === '(') {
      left = expression(0, depth + 1);
      if (tokens[cursor++] !== ')') throw new Error('Missing closing parenthesis');
    } else if (current === 'min' || current === 'max') {
      if (tokens[cursor++] !== '(') throw new Error('Missing function parenthesis');
      const a = expression(0, depth + 1);
      if (tokens[cursor++] !== ',') throw new Error('Two function arguments required');
      const b = expression(0, depth + 1);
      if (tokens[cursor++] !== ')') throw new Error('Missing function closing parenthesis');
      left = { kind: current, left: a, right: b };
    } else if (current === '-') {
      const next = tokens[cursor];
      if (next && /^\d/.test(next)) {
        cursor++;
        left = { kind: 'value', value: `-${next}` };
      } else
        left = {
          kind: 'subtract',
          left: { kind: 'value', value: '0' },
          right: expression(3, depth + 1),
        };
    } else if (current && /^\d/.test(current)) left = { kind: 'value', value: current };
    else throw new Error('Arithmetic literal required');
    while (cursor < tokens.length) {
      const operator = tokens[cursor];
      const rank =
        operator === '+' || operator === '-' ? 1 : operator === '*' || operator === '/' ? 2 : -1;
      if (rank < minimum) break;
      cursor++;
      const kind =
        operator === '+'
          ? 'add'
          : operator === '-'
            ? 'subtract'
            : operator === '*'
              ? 'multiply'
              : 'divide';
      left = { kind, left, right: expression(rank + 1, depth + 1) };
    }
    return left;
  }
  const result = expression(0, 0);
  if (cursor !== tokens.length) throw new Error('Unexpected arithmetic suffix');
  return result;
}
