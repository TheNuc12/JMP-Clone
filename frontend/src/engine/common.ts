// Shared helpers for analyses (port of backend/app/analyses/common.py) and the numpy
// behaviours the ports rely on.

import type { AnalysisColumn, BoxStats, Value } from '../api/types'
import { t } from './math/distributions'
import { mean, sorted, std } from './math/stats'
import { pyStr } from './pyformat'

/** Would Python's float() accept this label (and not give NaN)? */
export function isFloatLabel(label: string): boolean {
  return Number.isFinite(parseFloatLike(label)) || /^\s*[+-]?inf(inity)?\s*$/i.test(label)
}

/** Python float() for strings: NaN when it would raise (or give nan). */
export function parseFloatLike(text: string): number {
  const s = text.trim().replace(/(\d)_(?=\d)/g, '$1')
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN
  return Number(s)
}

/** A raw categorical value as its label (null for missing). */
export function toLabel(value: Value | boolean | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null
    return Number.isInteger(value) ? String(value) : pyStr(value)
  }
  return value === '' ? null : value
}

/** A raw continuous value as a number (NaN for missing or unparseable). */
export function toNumber(value: Value | boolean | undefined): number {
  if (value === null || value === undefined || typeof value === 'boolean') return NaN
  if (typeof value === 'number') return value
  return parseFloatLike(value)
}

export function numericValues(column: AnalysisColumn): number[] {
  return column.values.map(toNumber)
}

export function labelValues(column: AnalysisColumn): (string | null)[] {
  return column.values.map(toLabel)
}

/**
 * Unique non-missing labels in display order. Labels named in `order` (Value Order)
 * come first; the rest sort numerically if all are numbers, else as strings.
 */
export function levelsOf(labels: (string | null)[], order?: string[] | null): string[] {
  const unique = new Set<string>()
  for (const label of labels) if (label !== null) unique.add(label)
  const ordered = [...new Set(order ?? [])].filter((l) => unique.has(l))
  const rest = [...unique].filter((l) => !ordered.includes(l))
  if (rest.length && rest.every(isFloatLabel)) return [...ordered, ...rest.sort((a, b) => parseFloatLike(a) - parseFloatLike(b))]
  return [...ordered, ...rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]
}

// ------------------------------------------------------------------ numpy-isms


export function finite(values: number[]): number[] {
  return values.filter(Number.isFinite)
}

// numpy's reductions, bit for bit (pairwise summation).
export { mean, sorted, std, sum, variance } from './math/stats'

/** numpy's linear interpolation, written the same way for identical rounding. */
function lerp(a: number, b: number, t: number): number {
  const diff = b - a
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t
}

/** numpy.quantile(values, q, method="weibull"): the (n + 1)p definition JMP uses. */
export function quantile(values: number[], q: number): number {
  const v = sorted(values)
  const n = v.length
  if (n === 0) return NaN
  const index = Math.min(Math.max(q * (n + 1) - 1, 0), n - 1)
  const lo = Math.floor(index)
  const hi = Math.min(lo + 1, n - 1)
  return lerp(v[lo], v[hi], index - lo)
}

/** numpy.linspace(lo, hi, n) (the last point is exactly hi). */
export function linspace(lo: number, hi: number, n: number): number[] {
  if (n === 1) return [lo]
  const step = (hi - lo) / (n - 1)
  const out = Array.from({ length: n }, (_, i) => i * step + lo)
  out[n - 1] = hi
  return out
}

/** Grid for fitted curves: 100 points, or the two ends when the range is empty. */
export function grid(lo: number, hi: number, n = 100): number[] {
  return lo === hi ? [lo, hi] : linspace(lo, hi, n)
}

/** Outlier box plot statistics for finite values (null when empty). */
export function boxStats(values: number[]): BoxStats | null {
  const v = sorted(finite(values))
  if (v.length === 0) return null
  const q1 = quantile(v, 0.25)
  const median = quantile(v, 0.5)
  const q3 = quantile(v, 0.75)
  const iqr = q3 - q1
  const inside = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr)
  const lower = inside.length ? inside[0] : q1
  const upper = inside.length ? inside[inside.length - 1] : q3
  return { q1, median, q3, lower_whisker: Math.min(lower, q1), upper_whisker: Math.max(upper, q3), mean: mean(v) }
}

export function isConstant(values: number[]): boolean {
  return values.length > 0 && values.every((v) => v === values[0])
}

/** t-based confidence interval of the mean (null when n < 2). */
export function meanCi(values: number[], level = 0.95): [number, number] | null {
  const n = values.length
  if (n < 2) return null
  const m = mean(values)
  const se = std(values, 1) / Math.sqrt(n)
  const q = t.ppf(0.5 + level / 2, n - 1)
  return [m - q * se, m + q * se]
}
