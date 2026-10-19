// Lightweight statistics used for client-side drawing (Graph Builder, binning).
// Formal analyses run on the backend.

import type { BoxStats } from '../api/types'

export function mean(values: number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return values.length ? sum / values.length : NaN
}

/** Quantile of sorted values using the (n + 1)p definition (numpy "weibull"). */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  const h = (n + 1) * p
  if (h <= 1) return sorted[0]
  if (h >= n) return sorted[n - 1]
  const lo = Math.floor(h)
  return sorted[lo - 1] + (h - lo) * (sorted[lo] - sorted[lo - 1])
}

/** Outlier box plot statistics; whiskers reach the farthest points within 1.5 IQR. */
export function boxStats(values: number[]): BoxStats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantileSorted(sorted, 0.25)
  const q3 = quantileSorted(sorted, 0.75)
  const iqr = q3 - q1
  const loFence = q1 - 1.5 * iqr
  const hiFence = q3 + 1.5 * iqr
  let lower = q1
  let upper = q3
  for (const v of sorted) {
    if (v >= loFence) {
      lower = Math.min(v, q1)
      break
    }
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] <= hiFence) {
      upper = Math.max(sorted[i], q3)
      break
    }
  }
  return { q1, median: quantileSorted(sorted, 0.5), q3, lower_whisker: lower, upper_whisker: upper, mean: mean(values) }
}

/** Least-squares line y = intercept + slope * x. */
export function linearFit(xs: number[], ys: number[]): { intercept: number; slope: number; r2: number } | null {
  const n = xs.length
  if (n < 2) return null
  const mx = mean(xs)
  const my = mean(ys)
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  return { intercept: my - slope * mx, slope, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) }
}

/**
 * Smooth curve through (x, y): local linear regression with a Gaussian kernel, which is
 * smooth by construction even for a handful of points. The bandwidth follows Silverman's
 * rule of thumb, widened by `smoothness`.
 */
export function kernelSmooth(xs: number[], ys: number[], smoothness = 1.5, gridSize = 100): { x: number[]; y: number[] } {
  const n = xs.length
  if (n < 3) return { x: [], y: [] }
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  if (lo === hi) return { x: [], y: [] }
  const mx = mean(xs)
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) / (n - 1))
  const h = smoothness * 1.06 * sd * n ** -0.2
  const gx: number[] = []
  const gy: number[] = []
  for (let g = 0; g < gridSize; g++) {
    const x0 = lo + ((hi - lo) * g) / (gridSize - 1)
    let sw = 0
    let swd = 0
    let swy = 0
    let swdd = 0
    let swdy = 0
    for (let i = 0; i < n; i++) {
      const d = xs[i] - x0
      const w = Math.exp(-0.5 * (d / h) ** 2)
      sw += w
      swd += w * d
      swy += w * ys[i]
      swdd += w * d * d
      swdy += w * d * ys[i]
    }
    // Weighted least squares line in d = x - x0; its intercept is the fit at x0.
    const denom = sw * swdd - swd * swd
    gx.push(x0)
    gy.push(Math.abs(denom) < 1e-12 * sw * sw ? swy / sw : (swy * swdd - swd * swdy) / denom)
  }
  return { x: gx, y: gy }
}

/** A 1/2/5 x 10^k step that splits `range` into roughly `target` pieces. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0)) return 1
  const raw = range / target
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  const factor = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return factor * magnitude
}

export interface Bins {
  start: number
  size: number
  end: number
}

export function niceBins(values: number[]): Bins {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return { start: 0, size: 1, end: 1 }
  if (min === max) return { start: min - 0.5, size: 1, end: min + 0.5 }
  const target = Math.max(5, Math.min(40, Math.ceil(Math.log2(values.length) + 1)))
  const size = niceStep(max - min, target)
  const start = Math.floor(min / size) * size
  let end = Math.ceil(max / size) * size
  if (end <= start) end = start + size
  return { start, size, end }
}

/** Index of the bin containing `v`; values on the final edge fall in the last bin. */
export function binIndex(v: number, bins: Bins): number {
  const count = binCount(bins)
  const idx = Math.floor((v - bins.start) / bins.size + 1e-9)
  return Math.max(0, Math.min(count - 1, idx))
}

export function binCount(bins: Bins): number {
  return Math.max(1, Math.round((bins.end - bins.start) / bins.size))
}
