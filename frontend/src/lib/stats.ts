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

/** Locally weighted linear smoother (tricube weights, no robustness iterations). */
export function lowess(xs: number[], ys: number[], frac = 0.5, gridSize = 100): { x: number[]; y: number[] } {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
  const sx = order.map((i) => xs[i])
  const sy = order.map((i) => ys[i])
  const n = sx.length
  if (n < 3 || sx[0] === sx[n - 1]) return { x: [], y: [] }
  const k = Math.min(n, Math.max(3, Math.ceil(frac * n)))
  const gx: number[] = []
  const gy: number[] = []
  for (let g = 0; g < gridSize; g++) {
    const x0 = sx[0] + ((sx[n - 1] - sx[0]) * g) / (gridSize - 1)
    // The k nearest neighbours of x0 form a contiguous window of the sorted xs.
    let lo = lowerBound(sx, x0)
    let hi = lo
    while (hi - lo < k) {
      if (lo === 0) hi++
      else if (hi === n) lo--
      else if (x0 - sx[lo - 1] <= sx[hi] - x0) lo--
      else hi++
    }
    const maxDist = Math.max(x0 - sx[lo], sx[hi - 1] - x0) * 1.0001 || 1
    let sw = 0
    let swx = 0
    let swy = 0
    let swxx = 0
    let swxy = 0
    for (let i = lo; i < hi; i++) {
      const u = Math.abs(sx[i] - x0) / maxDist
      const w = (1 - u * u * u) ** 3
      sw += w
      swx += w * sx[i]
      swy += w * sy[i]
      swxx += w * sx[i] * sx[i]
      swxy += w * sx[i] * sy[i]
    }
    const denom = sw * swxx - swx * swx
    const y0 = Math.abs(denom) < 1e-12 ? swy / sw : (swy * swxx - swx * swxy + x0 * (sw * swxy - swx * swy)) / denom
    gx.push(x0)
    gy.push(y0)
  }
  return { x: gx, y: gy }
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
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
