// Tiny base-62 fractional index (same idea as the `fractional-indexing` midpoint, fraction part only).
const D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? D.indexOf(a[0]) : 0;
  const db = b !== null ? D.indexOf(b[0]) : D.length;
  if (db - da > 1) return D[Math.round(0.5 * (da + db))];
  if (b && b.length > 1) return b.slice(0, 1);
  return D[da] + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (null = open end). Falls back on keys from foreign writers. */
export function keyBetween(a: string | null, b: string | null): string {
  const foreign = (k: string) => [...k].some((ch) => D.indexOf(ch) < 0);
  // trailing zeros do not change the fraction value; midpoint() needs them stripped
  const lo = (a ?? '').replace(/0+$/, ''), hi = b === null ? null : b.replace(/0+$/, '');
  if (foreign(lo) || (hi !== null && foreign(hi)) || (hi !== null && lo >= hi)) return (a ?? '') + 'V';
  return midpoint(lo, hi);
}

/**
 * Next key after `last`. Keys look like `a0`, `a1`..`az`, `b00`.. (head letter = integer length, as in
 * fractional-indexing), so appending thousands of elements keeps keys at 2-4 chars.
 */
export function keyAfter(last: string | null): string {
  if (!last) return 'a0';
  const head = last.charCodeAt(0) - 97;
  const n = head + 1;
  const digits = last.slice(1);
  if (head < 0 || head > 25 || digits.length !== n || [...digits].some((ch) => D.indexOf(ch) < 0)) return last + 'V';
  const a = [...digits];
  let i = n - 1;
  while (i >= 0 && a[i] === 'z') a[i--] = '0';
  if (i >= 0) { a[i] = D[D.indexOf(a[i]) + 1]; return last[0] + a.join(''); }
  if (head === 25) return last + 'V';
  return String.fromCharCode(98 + head) + '0'.repeat(n + 1);
}

export const compareIndex = (a: { index: string; id: string }, b: { index: string; id: string }) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
