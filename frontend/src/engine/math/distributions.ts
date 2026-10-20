// Probability distributions with scipy.stats argument order: norm.cdf(x, loc, scale),
// t.cdf(x, df), chi2.ppf(q, df), f.sf(x, dfn, dfd), studentizedRange.sf(q, k, df),
// hypergeom.pmf(k, M, n, N).

import { gaussLegendre, quad } from './integrate'
import { brentq } from './optimize'
import { betainccinv, betaincinv, betaincPair, betaln, gammaDensity, gammainccinv, gammaincinv, gammaincPair, gammaln, LOG_SQRT_2PI, ndtr, ndtri } from './special'

// --------------------------------------------------------------------------- normal

export const norm = {
  pdf(x: number, loc = 0, scale = 1): number {
    const z = (x - loc) / scale
    return Math.exp(-0.5 * z * z - LOG_SQRT_2PI) / scale
  },
  logpdf(x: number, loc = 0, scale = 1): number {
    const z = (x - loc) / scale
    return -0.5 * z * z - LOG_SQRT_2PI - Math.log(scale)
  },
  cdf(x: number, loc = 0, scale = 1): number {
    return ndtr((x - loc) / scale)
  },
  sf(x: number, loc = 0, scale = 1): number {
    return ndtr(-(x - loc) / scale)
  },
  ppf(q: number, loc = 0, scale = 1): number {
    return loc + scale * ndtri(q)
  },
  isf(q: number, loc = 0, scale = 1): number {
    return loc - scale * ndtri(q)
  },
}

// -------------------------------------------------------------------------- Student t

/** [P(T ≤ t), P(T > t)], both accurate in the tails. */
function tTails(t: number, df: number): [number, number] {
  if (Number.isNaN(t) || !(df > 0)) return [NaN, NaN]
  if (t === Infinity) return [1, 0]
  if (t === -Infinity) return [0, 1]
  // P(|T| > |t|) = I_{df/(df+t²)}(df/2, 1/2); its complement is I_{t²/(df+t²)}(1/2, df/2).
  const t2 = t * t
  const x = df / (df + t2)
  const y = t2 / (df + t2)
  const [tail2] = betaincPair(df / 2, 0.5, x, y)
  const half = tail2 / 2
  return t >= 0 ? [1 - half, half] : [half, 1 - half]
}

/** Quantile for lower-tail probability p ≤ 0.5 (returns t ≤ 0). */
function tLowerPpf(p: number, df: number): number {
  if (p === 0.5) return 0
  // Solve for whichever of x = df/(df+t²) and z = 1 − x is farther from 1.
  const q = 2 * p // two-sided tail probability
  const zNormal = ndtri(p)
  if ((zNormal * zNormal) / df < 1) {
    const z = betainccinv(0.5, df / 2, q) // t²/(df+t²)
    return -Math.sqrt((df * z) / (1 - z))
  }
  const x = betaincinv(df / 2, 0.5, q)
  return -Math.sqrt((df * (1 - x)) / x)
}

export const t = {
  pdf(x: number, df: number): number {
    // 1 / (√df B(df/2, ½)) (1 + x²/df)^(−(df+1)/2); betaln avoids the large-df cancellation.
    return Math.exp(-0.5 * Math.log(df) - betaln(df / 2, 0.5) - ((df + 1) / 2) * Math.log1p((x * x) / df))
  },
  cdf(x: number, df: number): number {
    return tTails(x, df)[0]
  },
  sf(x: number, df: number): number {
    return tTails(x, df)[1]
  },
  ppf(q: number, df: number): number {
    if (Number.isNaN(q) || q < 0 || q > 1 || !(df > 0)) return NaN
    if (q === 0) return -Infinity
    if (q === 1) return Infinity
    return q <= 0.5 ? tLowerPpf(q, df) : -tLowerPpf(1 - q, df)
  },
  isf(q: number, df: number): number {
    return -t.ppf(q, df)
  },
}

// ------------------------------------------------------------------------ chi-square

export const chi2 = {
  pdf(x: number, df: number): number {
    return x < 0 ? 0 : 0.5 * gammaDensity(df / 2, x / 2)
  },
  cdf(x: number, df: number): number {
    return x <= 0 ? (Number.isNaN(x) ? NaN : 0) : gammaincPair(df / 2, x / 2)[0]
  },
  sf(x: number, df: number): number {
    return x <= 0 ? (Number.isNaN(x) ? NaN : 1) : gammaincPair(df / 2, x / 2)[1]
  },
  ppf(q: number, df: number): number {
    return 2 * gammaincinv(df / 2, q)
  },
  isf(q: number, df: number): number {
    return 2 * gammainccinv(df / 2, q)
  },
}

// ------------------------------------------------------------------------------- F

/** [P(F ≤ x), P(F > x)] via the incomplete beta function. */
function fTails(x: number, dfn: number, dfd: number): [number, number] {
  if (Number.isNaN(x) || !(dfn > 0) || !(dfd > 0)) return [NaN, NaN]
  if (x <= 0) return [0, 1]
  if (x === Infinity) return [1, 0]
  const u = dfn * x
  return betaincPair(dfn / 2, dfd / 2, u / (u + dfd), dfd / (u + dfd))
}

/** Convert a beta variate b = u/(u + dfd) back to x, using whichever of b, 1 − b is smaller. */
function fFromBeta(b: number, bc: number, dfn: number, dfd: number): number {
  return (dfd * b) / (dfn * bc)
}

export const f = {
  pdf(x: number, dfn: number, dfd: number): number {
    if (x < 0) return 0
    if (x === 0) return dfn === 2 ? 1 : dfn < 2 ? Infinity : 0
    const u = dfn * x
    return Math.exp(
      (dfn / 2) * Math.log(dfn) + (dfd / 2) * Math.log(dfd) + (dfn / 2 - 1) * Math.log(x) - ((dfn + dfd) / 2) * Math.log(u + dfd) - betaln(dfn / 2, dfd / 2),
    )
  },
  cdf(x: number, dfn: number, dfd: number): number {
    return fTails(x, dfn, dfd)[0]
  },
  sf(x: number, dfn: number, dfd: number): number {
    return fTails(x, dfn, dfd)[1]
  },
  ppf(q: number, dfn: number, dfd: number): number {
    if (Number.isNaN(q) || q < 0 || q > 1) return NaN
    if (q === 1) return Infinity
    if (q <= 0.5) {
      const b = betaincinv(dfn / 2, dfd / 2, q)
      return fFromBeta(b, 1 - b, dfn, dfd)
    }
    // Upper tail: 1 − b = I⁻¹(dfd/2, dfn/2; 1 − q) is the small, accurate quantity.
    const bc = betaincinv(dfd / 2, dfn / 2, 1 - q)
    return fFromBeta(1 - bc, bc, dfn, dfd)
  },
  isf(q: number, dfn: number, dfd: number): number {
    if (Number.isNaN(q) || q < 0 || q > 1) return NaN
    if (q === 0) return Infinity
    if (q >= 0.5) return f.ppf(1 - q, dfn, dfd)
    const bc = betaincinv(dfd / 2, dfn / 2, q)
    return fFromBeta(1 - bc, bc, dfn, dfd)
  },
}

// ------------------------------------------------------------------ studentized range

// scipy evaluates these integrals with nquad(epsabs=1e-11, epsrel=1e-12).
const SR_TOL = { epsabs: 1e-11, epsrel: 1e-12 }

/**
 * Fixed composite Gauss–Legendre grid on [−10, 10] (φ is below 1e-22 outside it) for the
 * inner integral, with φ(z) folded into the weights and Φ(z) precomputed. The integrand is
 * smooth on the scale of a unit, so 10 panels of 20 points are accurate to ~1e-15.
 */
const RANGE_GRID = (() => {
  const { nodes, weights } = gaussLegendre(20)
  const z: number[] = []
  const w: number[] = []
  const phiZ: number[] = []
  for (let panel = 0; panel < 10; panel++) {
    const center = -9 + 2 * panel
    for (let i = 0; i < nodes.length; i++) {
      const x = center + nodes[i]
      z.push(x)
      w.push(weights[i] * Math.exp(-0.5 * x * x - LOG_SQRT_2PI))
      phiZ.push(ndtr(x))
    }
  }
  return { z, w, phiZ }
})()

/** k ∫ φ(z) [Φ(z + w) − Φ(z)]^(k−1) dz: the range distribution of k standard normals. */
function rangeCdf(w: number, k: number): number {
  if (w <= 0) return 0
  const { z, w: weight, phiZ } = RANGE_GRID
  let sum = 0
  for (let i = 0; i < z.length; i++) sum += weight[i] * Math.pow(ndtr(z[i] + w) - phiZ[i], k - 1)
  return k * sum
}

/** Interval of s outside which the density of s = √(χ²_df / df) is below e^−60 of its peak. */
function chiScaleSupport(df: number, logDensity: (s: number) => number): [number, number] {
  const peak = df > 1 ? Math.sqrt((df - 1) / df) : 0
  const top = logDensity(Math.max(peak, 1e-300))
  const step = 0.5 / Math.sqrt(df)
  let hi = peak + step
  while (logDensity(hi) - top > -60) hi += step
  let lo = peak
  while (lo > 0 && logDensity(lo) - top > -60) lo = Math.max(0, lo - step)
  return [lo, hi]
}

/** CDF of the studentized range Q = range / s with s² ~ χ²_df / df (Lund & Lund, eq. 3). */
function studentizedRangeCdf(q: number, k: number, df: number): number {
  if (Number.isNaN(q) || Number.isNaN(k) || Number.isNaN(df)) return NaN
  if (q <= 0) return 0
  if (q === Infinity) return 1
  if (df >= 100000) return Math.min(1, Math.max(0, rangeCdf(q, k)))
  const logConst = (df / 2) * Math.log(df) - gammaln(df / 2) - (df / 2 - 1) * Math.LN2
  const logDensity = (s: number) => logConst + (df - 1) * Math.log(s) - (df * s * s) / 2
  const [lo, hi] = chiScaleSupport(df, logDensity)
  const outer = (s: number) => (s <= 0 ? 0 : Math.exp(logDensity(s)) * rangeCdf(q * s, k))
  return Math.min(1, Math.max(0, quad(outer, lo, hi, SR_TOL).value))
}

export const studentizedRange = {
  cdf: studentizedRangeCdf,
  /** 1 − cdf, as scipy computes it. */
  sf(q: number, k: number, df: number): number {
    return 1 - studentizedRangeCdf(q, k, df)
  },
  /** scipy's generic ppf: bracket from [0, 10] outward, then Brent's method (xtol 1e-14). */
  ppf(p: number, k: number, df: number): number {
    if (Number.isNaN(p) || p < 0 || p > 1) return NaN
    if (p === 0) return 0
    if (p === 1) return Infinity
    const g = (x: number) => studentizedRangeCdf(x, k, df) - p
    let left = 0
    let right = 10
    while (g(right) < 0) {
      left = right
      right *= 10
    }
    return brentq(g, left, right, { xtol: 1e-14 })
  },
}

// --------------------------------------------------------------------- hypergeometric

/** ln C(n, k). */
/** log C(n, k), symmetric in k ↔ n − k to the last bit (fisherExact compares such pmfs). */
function lnChoose(n: number, k: number): number {
  return gammaln(n + 1) - (gammaln(k + 1) + gammaln(n - k + 1))
}

/** Hypergeometric distribution of successes k in N draws from M items with n successes. */
export const hypergeom = {
  logpmf(k: number, M: number, n: number, N: number): number {
    if (!Number.isInteger(k) || k < Math.max(0, N - (M - n)) || k > Math.min(n, N)) return -Infinity
    return lnChoose(n, k) + lnChoose(M - n, N - k) - lnChoose(M, N)
  },
  pmf(k: number, M: number, n: number, N: number): number {
    return Math.exp(hypergeom.logpmf(k, M, n, N))
  },
  /** P(X ≤ k), summing whichever tail is shorter. */
  cdf(k: number, M: number, n: number, N: number): number {
    const lo = Math.max(0, N - (M - n))
    const hi = Math.min(n, N)
    k = Math.floor(k)
    if (k < lo) return 0
    if (k >= hi) return 1
    return k - lo <= hi - k ? sumPmf(lo, k, M, n, N) : 1 - sumPmf(k + 1, hi, M, n, N)
  },
  /** P(X > k). */
  sf(k: number, M: number, n: number, N: number): number {
    const lo = Math.max(0, N - (M - n))
    const hi = Math.min(n, N)
    k = Math.floor(k)
    if (k < lo) return 1
    if (k >= hi) return 0
    return hi - k <= k - lo ? sumPmf(k + 1, hi, M, n, N) : 1 - sumPmf(lo, k, M, n, N)
  },
}

function sumPmf(from: number, to: number, M: number, n: number, N: number): number {
  let sum = 0
  for (let i = from; i <= to; i++) sum += hypergeom.pmf(i, M, n, N)
  return sum
}
