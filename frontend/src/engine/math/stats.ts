// numpy reductions and scipy.stats / statsmodels hypothesis tests, ported from numpy 2.5,
// scipy 1.18 and statsmodels 0.15 with the same operation order and edge cases.

import { chi2, f, hypergeom, norm, studentizedRange } from './distributions'
import type { Matrix } from './linalg'
import { betaincc, ndtr, ndtri } from './special'

export interface TestResult {
  statistic: number
  pvalue: number
}

// ---------------------------------------------------------------------------- numpy

/** np.sum: numpy's pairwise summation, so totals round exactly as numpy's do. */
export function sum(x: ArrayLike<number>): number {
  return pairwiseSum(x, 0, x.length)
}

function pairwiseSum(a: ArrayLike<number>, start: number, n: number): number {
  if (n < 8) {
    let res = 0
    for (let i = 0; i < n; i++) res += a[start + i]
    return res
  }
  if (n <= 128) {
    const r = [a[start], a[start + 1], a[start + 2], a[start + 3], a[start + 4], a[start + 5], a[start + 6], a[start + 7]]
    let i = 8
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j]
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]))
    for (; i < n; i++) res += a[start + i]
    return res
  }
  const half = Math.floor(n / 2)
  const n2 = half - (half % 8)
  return pairwiseSum(a, start, n2) + pairwiseSum(a, start + n2, n - n2)
}

/** np.mean (NaN for an empty array). */
export function mean(x: ArrayLike<number>): number {
  return sum(x) / x.length
}

/** np.var with `ddof` delta degrees of freedom (±∞ / NaN when n ≤ ddof, as numpy gives). */
export function variance(x: ArrayLike<number>, ddof = 0): number {
  const m = mean(x)
  const sq = Float64Array.from(x, (v) => (v - m) * (v - m))
  return sum(sq) / Math.max(x.length - ddof, 0)
}

/** np.std with `ddof` delta degrees of freedom. */
export function std(x: ArrayLike<number>, ddof = 0): number {
  return Math.sqrt(variance(x, ddof))
}

/** Ascending copy with NaNs last (np.sort). */
export function sorted(x: readonly number[]): number[] {
  return [...x].sort((a, b) => (Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : a - b))
}

/** np.median: NaN if any value is NaN. */
export function median(x: readonly number[]): number {
  const n = x.length
  if (n === 0 || x.some(Number.isNaN)) return NaN
  const s = sorted(x)
  const mid = n >> 1
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Average ranks of tied values (scipy.stats.rankdata); all NaN if any input is NaN. */
export function rankdata(x: readonly number[]): number[] {
  const n = x.length
  if (x.some(Number.isNaN)) return new Array<number>(n).fill(NaN)
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => x[i] - x[j] || i - j)
  const ranks = new Array<number>(n)
  for (let i = 0; i < n; ) {
    let j = i + 1
    while (j < n && x[order[j]] === x[order[i]]) j++
    const r = i + 1 + (j - i - 1) / 2
    for (let k = i; k < j; k++) ranks[order[k]] = r
    i = j
  }
  return ranks
}

/** Σ (t³ − t) over the tie counts t of x (the tie correction term). */
function tieTerm(x: readonly number[]): number {
  const s = sorted(x)
  let total = 0
  for (let i = 0; i < s.length; ) {
    let j = i + 1
    while (j < s.length && s[j] === s[i]) j++
    const c = j - i
    total += c ** 3 - c
    i = j
  }
  return total
}

/** Correlation matrix of the columns of x (np.corrcoef(x, rowvar=False)), clipped to [−1, 1]. */
export function corrcoef(x: Matrix): Matrix {
  const n = x.length
  const p = n ? x[0].length : 0
  const centered = Array.from({ length: p }, (_, j) => {
    const col = x.map((row) => row[j])
    const m = mean(col)
    return col.map((v) => v - m)
  })
  const cov = centered.map((a) => centered.map((b) => a.reduce((s, v, i) => s + v * b[i], 0) * (1 / (n - 1))))
  const sd = cov.map((row, i) => Math.sqrt(row[i]))
  return cov.map((row, i) => row.map((c, j) => Math.min(Math.max(c / sd[i] / sd[j], -1), 1)))
}

// -------------------------------------------------------------------- normality

/** Shapiro–Wilk test (scipy.stats.shapiro: Royston's approximation, exact for n = 3). */
export function shapiro(x: readonly number[]): TestResult {
  const n = x.length
  if (n < 3) throw new Error('Data must be at least length 3.')
  // scipy subtracts the value at the middle *unsorted* position to reduce rounding error.
  const shift = x[n >> 1]
  const y = sorted(x).map((v) => v - shift)
  const ybar = mean(y)
  const den = sum(y.map((v) => (v - ybar) * (v - ybar)))
  const swilkW = (a: number[]) => sum(a.map((ai, i) => ai * y[i])) ** 2 / den

  if (n === 3) {
    const c = Math.SQRT2 / 2
    const w = Math.min(Math.max(swilkW([-c, 0, c]), 0.75), 1)
    return { statistic: w, pvalue: Math.min(Math.max(1 - (6 / Math.PI) * Math.acos(Math.sqrt(w)), 0), 1) }
  }

  const m = Array.from({ length: n }, (_, i) => ndtri((i + 1 - 3 / 8) / (n + 1 / 4)))
  const u = n ** -0.5
  const mTm = sum(m.map((v) => v * v))
  const [mnm1, mn] = [m[n - 2], m[n - 1]]
  const [cnm1, cn] = [mTm ** -0.5 * mnm1, mTm ** -0.5 * mn]
  const an = cn + 0.221157 * u - 0.147981 * u ** 2 - 2.07119 * u ** 3 + 4.434685 * u ** 4 - 2.706056 * u ** 5
  const anm1 = cnm1 + 0.042981 * u - 0.293762 * u ** 2 - 1.752461 * u ** 3 + 5.682633 * u ** 4 - 3.582633 * u ** 5
  const phi = n <= 5 ? (mTm - 2 * mn ** 2) / (1 - 2 * an ** 2) : (mTm - 2 * mn ** 2 - 2 * mnm1 ** 2) / (1 - 2 * an ** 2 - 2 * anm1 ** 2)
  const a = m.map((v) => phi ** -0.5 * v)
  if (n > 5) {
    a[n - 2] = anm1
    a[1] = -anm1
  }
  a[n - 1] = an
  a[0] = -an
  const w = swilkW(a)

  let mu: number
  let sigma: number
  let gw: number
  if (n <= 11) {
    const gamma = -2.273 + 0.459 * n
    mu = 0.544 - 0.39978 * n + 0.025054 * n ** 2 - 0.0006714 * n ** 3
    sigma = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n ** 2 - 0.0020322 * n ** 3)
    gw = -Math.log(gamma - Math.log(1 - w))
  } else {
    const ln = Math.log(n)
    mu = -1.5861 - 0.31082 * ln - 0.083751 * ln ** 2 + 0.0038915 * ln ** 3
    sigma = Math.exp(-0.4803 - 0.082676 * ln + 0.0030302 * ln ** 2)
    gw = Math.log(1 - w)
  }
  return { statistic: w, pvalue: ndtr(-(gw - mu) / sigma) }
}

// Lilliefors' asymptotic critical values: log D_α(n) = p₀ + p₁ log n + p₂ log² n for each upper
// percentile (statsmodels' _lilliefors_critical_values, normal distribution).
const LILLIEFORS_PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 92.5, 95, 97.5, 99, 99.5, 99.7, 99.9]
const LILLIEFORS_INTERCEPTS = [
  -1.17114969, -1.03298277, -0.95518114, -0.81912169, -0.6607348, -0.49861004, -0.35446139, -0.31737193, -0.26969888, -0.1979977,
  -0.11709649, -0.06398777, -0.0281863, 0.04129756,
]

/**
 * Kolmogorov–Smirnov test for normality with estimated mean and SD (statsmodels' lilliefors
 * with its default table p-values). Only the asymptotic regime n > 1600 is ported, which is
 * where the app uses it (n > 5000); smaller samples throw.
 */
export function lilliefors(x: readonly number[]): TestResult {
  const n = x.length
  if (n < 4) throw new Error('Test for distribution norm requires at least 4 observations')
  if (n <= 1600) throw new RangeError('lilliefors: the tabulated p-values for n ≤ 1600 are not ported')
  const m = mean(x)
  const s = std(x, 1)
  const cdf = sorted(x.map((v) => (v - m) / s)).map((z) => norm.cdf(z))
  let dPlus = -Infinity
  let dMinus = -Infinity
  cdf.forEach((c, i) => {
    dPlus = Math.max(dPlus, (i + 1) / n - c)
    dMinus = Math.max(dMinus, c - i / n)
  })
  const d = Math.max(dPlus, dMinus)

  // Critical values ascend as the tail probability alpha descends.
  const ln = Math.log(n)
  const crit = LILLIEFORS_INTERCEPTS.map((p0) => Math.exp(p0 + ln * -0.45068579 + ln ** 2 * -0.00356741))
  const alpha = LILLIEFORS_PERCENTILES.map((p) => 1 - p / 100)
  if (d < crit[0]) return { statistic: d, pvalue: alpha[0] }
  if (d > crit[crit.length - 1]) return { statistic: d, pvalue: alpha[alpha.length - 1] }
  // scipy interp1d: the first knot at or above d closes the interval.
  const hi = Math.max(1, crit.findIndex((c) => c >= d))
  const slope = (alpha[hi] - alpha[hi - 1]) / (crit[hi] - crit[hi - 1])
  return { statistic: d, pvalue: slope * (d - crit[hi - 1]) + alpha[hi - 1] }
}

// ------------------------------------------------------------- k-sample tests

/** Levene's test (scipy.stats.levene); center 'median' is the Brown–Forsythe variant. */
export function levene(groups: readonly (readonly number[])[], center: 'median' | 'mean' = 'median'): TestResult {
  const k = groups.length
  if (k < 2) throw new Error('Must provide at least two samples.')
  if (groups.some((g) => g.length === 0)) return { statistic: NaN, pvalue: NaN }
  const ns = groups.map((g) => g.length)
  const ntot = ns.reduce((s, v) => s + v, 0)
  const zs = groups.map((g) => {
    const c = center === 'median' ? median(g) : mean(g)
    return g.map((v) => Math.abs(v - c))
  })
  const zbars = zs.map(mean)
  const zbar = ns.reduce((s, ni, i) => s + ni * zbars[i], 0) / ntot
  const dfd = ntot - k
  const dfn = k - 1
  const numer = dfd * ns.reduce((s, ni, i) => s + ni * (zbars[i] - zbar) ** 2, 0)
  const denom = dfn * zs.reduce((s, z, i) => s + sum(z.map((v) => (v - zbars[i]) ** 2)), 0)
  const w = numer / denom
  return { statistic: w, pvalue: f.sf(w, dfn, dfd) }
}

/** Bartlett's test for equal variances (scipy.stats.bartlett). */
export function bartlett(groups: readonly (readonly number[])[]): TestResult {
  const k = groups.length
  if (k < 2) throw new Error('Must enter at least two input sample vectors.')
  if (groups.some((g) => g.length === 0)) return { statistic: NaN, pvalue: NaN }
  const ns = groups.map((g) => g.length)
  const ssq = groups.map((g) => variance(g, 1))
  const ntot = sum(ns)
  const spsq = sum(ns.map((ni, i) => (ni - 1) * ssq[i])) / (ntot - k)
  const numer = (ntot - k) * Math.log(spsq) - sum(ns.map((ni, i) => (ni - 1) * Math.log(ssq[i])))
  const denom = 1 + (1 / (3 * (k - 1))) * (sum(ns.map((ni) => 1 / (ni - 1))) - 1 / (ntot - k))
  const stat = numer / denom
  return { statistic: Math.max(stat, 0), pvalue: chi2.sf(stat, k - 1) }
}

/** Kruskal–Wallis H test with the tie correction (scipy.stats.kruskal). */
export function kruskal(groups: readonly (readonly number[])[]): TestResult {
  const k = groups.length
  if (k < 2) throw new Error('Need at least two groups in stats.kruskal()')
  if (groups.some((g) => g.length === 0)) return { statistic: NaN, pvalue: NaN }
  const all = groups.flat()
  const ranks = rankdata(all)
  const ntot = groups.reduce((s, g) => s + g.length, 0)
  const ties = 1 - tieTerm(all) / (ntot ** 3 - ntot)
  let start = 0
  let ssbn = 0
  for (const g of groups) {
    ssbn += sum(ranks.slice(start, start + g.length)) ** 2 / g.length
    start += g.length
  }
  const h = ((12 / (ntot * (ntot + 1))) * ssbn - 3 * (ntot + 1)) / ties
  return { statistic: h, pvalue: chi2.sf(h, k - 1) }
}

// ----------------------------------------------------------------- association

/** Pearson correlation with its exact two-sided p-value (scipy.stats.pearsonr). */
export function pearsonr(x: readonly number[], y: readonly number[]): TestResult {
  const n = x.length
  if (y.length !== n) throw new Error('`x` and `y` must have the same length along `axis`.')
  if (n < 2) throw new Error('`x` and `y` must have length at least 2.')
  const constant = (v: readonly number[]) => v.every((e) => e === v[0])
  if (constant(x) || constant(y)) return { statistic: NaN, pvalue: NaN }
  const unit = (v: readonly number[]) => {
    const m = mean(v)
    const d = v.map((e) => e - m)
    const max = d.reduce((s, e) => Math.max(s, Math.abs(e)), 0)
    const length = max * Math.sqrt(d.reduce((s, e) => s + (e / max) * (e / max), 0))
    return d.map((e) => e / length)
  }
  const ux = unit(x)
  const uy = unit(y)
  let r = Math.min(Math.max(ux.reduce((s, e, i) => s + e * uy[i], 0), -1), 1)
  if (n === 2) {
    r = Math.round(r)
    return { statistic: r, pvalue: 1 }
  }
  const ab = n / 2 - 1
  return { statistic: r, pvalue: 2 * betaincc(ab, ab, (Math.abs(r) + 1) / 2) }
}

/**
 * Fisher's exact test on a 2 × 2 table [[a, b], [c, d]] (scipy.stats.fisher_exact): the
 * statistic is the sample odds ratio ad / bc; the two-sided p-value sums the tables no more
 * probable than the observed one (with scipy's 1e-14 relative tolerance).
 */
export function fisherExact(table: readonly (readonly number[])[], alternative: 'two-sided' | 'less' | 'greater' = 'two-sided'): TestResult {
  const [[c00, c01], [c10, c11]] = table
  if ([c00, c01, c10, c11].some((v) => v < 0)) throw new Error('All values in `table` must be nonnegative.')
  if (c00 + c10 === 0 || c01 + c11 === 0 || c00 + c01 === 0 || c10 + c11 === 0) return { statistic: NaN, pvalue: 1 }
  const oddsratio = c10 > 0 && c01 > 0 ? (c00 * c11) / (c10 * c01) : Infinity
  const n1 = c00 + c01
  const n2 = c10 + c11
  const n = c00 + c10
  const M = n1 + n2
  const pmf = (x: number) => hypergeom.pmf(x, M, n1, n)
  let pvalue: number
  if (alternative === 'less') {
    pvalue = hypergeom.cdf(c00, M, n1, n)
  } else if (alternative === 'greater') {
    pvalue = hypergeom.cdf(c01, M, n1, c01 + c11)
  } else {
    const mode = Math.trunc(((n + 1) * (n1 + 1)) / (M + 2))
    const pexact = pmf(c00)
    const pmode = pmf(mode)
    const gamma = 1 + 1e-14
    if (Math.abs(pexact - pmode) / Math.max(pexact, pmode) <= 1e-14) return { statistic: oddsratio, pvalue: 1 }
    if (c00 < mode) {
      const plower = hypergeom.cdf(c00, M, n1, n)
      if (pmf(n) > pexact * gamma) return { statistic: oddsratio, pvalue: plower }
      const guess = binarySearch((x) => -pmf(x), -pexact * gamma, mode, n)
      pvalue = plower + hypergeom.sf(guess, M, n1, n)
    } else {
      const pupper = hypergeom.sf(c00 - 1, M, n1, n)
      if (pmf(0) > pexact * gamma) return { statistic: oddsratio, pvalue: pupper }
      const guess = binarySearch(pmf, pexact * gamma, 0, mode)
      pvalue = pupper + hypergeom.cdf(guess, M, n1, n)
    }
  }
  return { statistic: oddsratio, pvalue: Math.min(pvalue, 1) }
}

/** The i in [lo, hi] with a(i) ≤ d < a(i + 1), for a ascending on [lo, hi] (scipy's _binary_search). */
function binarySearch(a: (x: number) => number, d: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const midval = a(mid)
    if (midval < d) lo = mid + 1
    else if (midval > d) hi = mid - 1
    else lo = hi = mid
  }
  return a(lo) <= d ? lo : lo - 1
}

// ---------------------------------------------------------------------- Tukey

export interface TukeyHsdResult {
  /** statistic[i][j] = mean_i − mean_j. */
  statistic: Matrix
  pvalue: Matrix
  /** Simultaneous confidence limits for each difference. */
  low: Matrix
  high: Matrix
  df: number
}

/** Tukey's honestly significant difference test (scipy.stats.tukey_hsd, equal variances). */
export function tukeyHsd(groups: readonly (readonly number[])[], confidenceLevel = 0.95): TukeyHsdResult {
  const k = groups.length
  if (k < 2) throw new Error('There must be more than 1 treatment.')
  if (groups.some((g) => g.length <= 1)) throw new Error('Input sample size must be greater than one.')
  if (groups.some((g) => g.some((v) => v === Infinity || v === -Infinity))) throw new Error('Input samples must be finite.')
  const means = groups.map(mean)
  const ns = groups.map((g) => g.length)
  const nobs = sum(ns)
  const mse = sum(groups.map((g, i) => variance(g, 1) * (ns[i] - 1))) / (nobs - k)
  const equal = ns.every((n) => n === ns[0])
  const standErr = (i: number, j: number) => Math.sqrt(((equal ? 2 / ns[0] : 1 / ns[j] + 1 / ns[i]) * mse) / 2)
  const df = nobs - k
  const radius = studentizedRange.ppf(confidenceLevel, k, df)
  const sfCache = new Map<number, number>()
  const sf = (q: number) => {
    if (!sfCache.has(q)) sfCache.set(q, studentizedRange.sf(q, k, df))
    return sfCache.get(q) as number
  }
  const statistic = means.map((mi) => means.map((mj) => mi - mj))
  const pvalue = statistic.map((row, i) => row.map((d, j) => sf(Math.abs(d) / standErr(i, j))))
  const low = statistic.map((row, i) => row.map((d, j) => d - radius * standErr(i, j)))
  const high = statistic.map((row, i) => row.map((d, j) => d + radius * standErr(i, j)))
  return { statistic, pvalue, low, high, df }
}
