import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readSql(name: string): string {
  return readFileSync(join(process.cwd(), 'sql', name), 'utf8');
}
