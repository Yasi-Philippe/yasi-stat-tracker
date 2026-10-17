/** Small text helpers for friendly error messages. */

/** 1 → "1st", 2 → "2nd", 11 → "11th"… */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Levenshtein distance (insertions, deletions and substitutions cost 1),
 * where swapping two adjacent letters also counts as a single edit, so the
 * common typo "medain" is 1 away from "median" (optimal string alignment).
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const rows: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) rows[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1);
      rows[i][j] = best;
    }
  }
  return rows[m][n];
}

/**
 * The candidate closest to `name`, ignoring case, if it is within edit
 * distance 2 (1 for names of up to 3 characters, where 2 edits would match
 * almost anything). Earlier candidates win ties.
 */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const limit = name.length <= 3 ? 1 : 2;
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const candidate of candidates) {
    if (candidate === name || Math.abs(candidate.length - name.length) >= bestDistance) continue;
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}
