import { z } from 'zod';

// ISO instants at DateTimeOffset's 100 ns precision. Integer Gregorian day counts
// avoid JavaScript Date's millisecond truncation and year 0..99 conversion rules.
function instantTicks(value: string): bigint | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !zone
  )
    return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthLength = monthLengths[month - 1];
  if (!monthLength || day > monthLength) return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || minutes > 59 || (offsetHours === 14 && minutes !== 0)) return null;
    offsetMinutes = (zone[0] === '+' ? 1 : -1) * (offsetHours * 60 + minutes);
  }
  const previousYear = year - 1;
  const days =
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    monthLengths.slice(0, month - 1).reduce((sum, length) => sum + length, 0) +
    day -
    1;
  const ticks =
    BigInt(days) * 864000000000n +
    BigInt(hour * 3600 + minute * 60 + second) * 10000000n +
    BigInt((match[7] ?? '').padEnd(7, '0')) -
    BigInt(offsetMinutes) * 600000000n;
  return ticks >= 0n && ticks <= 3155378975999999999n ? ticks : null;
}

export const timestampSchema = z.string().refine((value) => instantTicks(value) !== null, {
  message: 'Expected an ISO instant with an explicit offset and at most 7 fractional digits',
});

export function sameInstant(left: string, right: string): boolean {
  const a = instantTicks(left);
  const b = instantTicks(right);
  return a !== null && b !== null && a === b;
}

export function instantAfter(left: string, right: string): boolean {
  const a = instantTicks(left);
  const b = instantTicks(right);
  if (a === null || b === null) throw new Error('Invalid timestamp comparison');
  return a > b;
}
