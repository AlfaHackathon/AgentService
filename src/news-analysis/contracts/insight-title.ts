import { NewsAnalysisError } from './errors.ts';

export const maximumTitleLength = 180;

// Publication/missing-title/numeric rules belong to Insight, after legacy replay.
// Omission/null remains valid for historical DTOs and internal no-insight diagnostics.
export function validateTitle(title: string | null | undefined): void {
  if (title == null) return;
  if (!title.trim() || title.length > maximumTitleLength || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title))
    throw new NewsAnalysisError(
      422,
      'TITLE_INVALID',
      'Provide a nonblank short single-line grounded title without opaque identifiers.',
    );
}
