import { createHash } from 'node:crypto';
import type { Source } from './source-catalog.ts';

export type SourceUnit = {
  unitId: string;
  sourceRef: { materialId: string; versionId: string; contentHash: string };
  start: number;
  end: number;
  text: string;
  tableHeader?: string;
};

/** Lossless windows; tabular rows cannot hide behind surrounding narrative. */
export function sourceUnits(sources: Source[]) {
  return sources.flatMap((source) => {
    const units: SourceUnit[] = [];
    const append = (from: number, to: number, tableHeader?: string) => {
      for (let start = from; start < to; ) {
        let end = Math.min(start + 2400, to);
        if (end < to) {
          const boundary = source.text.lastIndexOf('\n', end);
          if (boundary > start + 1200) end = boundary + 1;
        }
        units.push({
          unitId: createHash('sha256')
            .update(
              JSON.stringify([source.materialId, source.versionId, source.contentHash, start, end]),
            )
            .digest('hex')
            .slice(0, 24),
          sourceRef: {
            materialId: source.materialId,
            versionId: source.versionId,
            contentHash: source.contentHash,
          },
          start,
          end,
          text: source.text.slice(start, end),
          ...(tableHeader ? { tableHeader } : {}),
        });
        start = end;
      }
    };
    const lines = [...source.text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0].length);
    const columns = (line: string) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|').length;
    let pending = 0;
    for (let i = 0; i < lines.length; i++) {
      const first = lines[i];
      if (!first || columns(first[0]) < 2) continue;
      let end = i + 1;
      while (end < lines.length && columns(lines[end]?.[0] ?? '') === columns(first[0])) end++;
      if (end - i < 2) continue;
      append(pending, first.index);
      const header = first[0].trimEnd();
      let rowStart = first.index;
      for (let r = i + 1; r < end; r++) {
        const line = lines[r];
        if (!line) continue;
        if (/^[\s:|-]+$/.test(line[0])) continue;
        const rowEnd = line.index + line[0].length;
        append(rowStart, rowEnd, header);
        rowStart = rowEnd;
      }
      const last = lines[end - 1];
      pending = last ? last.index + last[0].length : rowStart;
      append(rowStart, pending, header);
      i = end - 1;
    }
    append(pending, source.text.length);
    return units;
  });
}
