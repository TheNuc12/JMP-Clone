// Statistical process control helpers shared by control charts and capability
// (port of backend/app/analyses/spc.py).

import { parseFloatLike } from '../common'
import { norm } from '../math/distributions'
import { quad } from '../math/integrate'
import { gammaln } from '../math/special'
import { mean, sum } from '../math/stats'
import { pyRound } from '../pyformat'

// Mean (d2) and standard deviation (d3) of the range of n standard normal values,
// computed by numerical integration (they match published tables to the digits shown there).
const RANGE_CONSTANTS: Record<number, [number, number]> = {
  2: [1.128379, 0.852502],
  3: [1.692569, 0.888368],
  4: [2.058751, 0.879808],
  5: [2.325929, 0.864082],
  6: [2.534413, 0.84804],
  7: [2.704357, 0.833205],
  8: [2.847201, 0.819831],
  9: [2.970026, 0.807834],
  10: [3.077505, 0.797051],
  11: [3.172873, 0.787315],
  12: [3.258455, 0.778478],
  13: [3.33598, 0.770416],
  14: [3.406763, 0.763023],
  15: [3.471827, 0.756211],
  16: [3.531983, 0.749908],
  17: [3.587884, 0.744052],
  18: [3.640064, 0.738591],
  19: [3.688963, 0.733481],
  20: [3.73495, 0.728686],
  21: [3.778336, 0.724173],
  22: [3.819385, 0.719915],
  23: [3.858323, 0.715887],
  24: [3.895348, 0.712068],
  25: [3.930629, 0.708441],
}

const computed = new Map<number, [number, number]>()

function rangeConstants(n: number): [number, number] {
  const known = RANGE_CONSTANTS[n] ?? computed.get(n)
  if (known) return known
  // Larger subgroups: integrate directly (rare, and cached).
  const d2n = quad((x) => 1 - norm.cdf(x) ** n - norm.sf(x) ** n, -Infinity, Infinity).value
  const cdf = (r: number) => n * quad((x) => norm.pdf(x) * (norm.cdf(x + r) - norm.cdf(x)) ** (n - 1), -12, 12, { limit: 400 }).value
  const er2 = 2 * quad((r) => r * (1 - cdf(r)), 0, 20, { limit: 400 }).value
  const constants: [number, number] = [d2n, Math.sqrt(Math.max(er2 - d2n ** 2, 0))]
  computed.set(n, constants)
  return constants
}

export function d2(n: number): number {
  return rangeConstants(n)[0]
}

export function d3(n: number): number {
  return rangeConstants(n)[1]
}

/** Bias correction for the sample standard deviation: E[s] = c4 * sigma. */
export function c4(n: number): number {
  return Math.sqrt(2 / (n - 1)) * Math.exp(gammaln(n / 2) - gammaln((n - 1) / 2))
}

// ------------------------------------------------------------------ subgroups

export interface Subgroup {
  label: string
  /** Request positions with a usable value. */
  positions: number[]
  values: number[]
}

/**
 * Split finite values into subgroups. With `labels`, rows sharing a label form a subgroup,
 * ordered by first appearance (rows with a missing label are skipped). Otherwise
 * consecutive non-missing values are chunked into groups of `size` (the last group may be
 * smaller). Without either, every value is its own subgroup.
 */
export function makeSubgroups(values: number[], labels: (string | null)[] | null = null, size: number | null = null): Subgroup[] {
  const finite = values.flatMap((v, i) => (Number.isFinite(v) ? [i] : []))
  const subgroup = (label: string, positions: number[]): Subgroup => ({ label, positions, values: positions.map((i) => values[i]) })
  if (labels !== null) {
    const groups = new Map<string, number[]>()
    for (const i of finite) {
      const label = labels[i]
      if (label === null) continue
      const list = groups.get(label)
      if (list) list.push(i)
      else groups.set(label, [i])
    }
    return [...groups].map(([label, positions]) => subgroup(label, positions))
  }
  const step = Math.max(1, Math.trunc(size || 1))
  const out: Subgroup[] = []
  for (let start = 0, k = 0; start < finite.length; start += step, k++) out.push(subgroup(String(k + 1), finite.slice(start, start + step)))
  return out
}

// ------------------------------------------------------------ sigma estimates

/** Within sigma from the average moving range of consecutive values: MR-bar / d2(2). */
export function movingRangeSigma(values: number[]): number {
  const v = values.filter(Number.isFinite)
  if (v.length < 2) return NaN
  return mean(v.slice(1).map((x, i) => Math.abs(x - v[i]))) / d2(2)
}

/** Pooled within-subgroup standard deviation. */
export function pooledSigma(groups: number[][]): number {
  let num = 0
  let df = 0
  for (const g of groups) {
    if (g.length < 2) continue
    const m = mean(g)
    num += sum(g.map((x) => (x - m) ** 2))
    df += g.length - 1
  }
  return df > 0 ? Math.sqrt(num / df) : NaN
}

// --------------------------------------------------------------------- params

/** A numeric request parameter, or null when absent, blank or not a finite number. */
export function paramFloat(params: Record<string, unknown>, key: string): number | null {
  const value = params[key]
  let f: number
  if (typeof value === 'number') f = value
  else if (typeof value === 'string') f = parseFloatLike(value)
  else return null
  return Number.isFinite(f) ? f : null
}

export function paramInt(params: Record<string, unknown>, key: string): number | null {
  const f = paramFloat(params, key)
  return f === null ? null : pyRound(f)
}
