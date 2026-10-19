// Evaluates a fitted least squares model (LinearModelSpec) for the profiler and Save Columns.

import type { LinearModelSpec, ReportNode, TermPart } from '../api/types'
import { formulaRef } from './formula'
import { labelOf } from './levels'
import type { Column } from '../state/store'

/** Factor settings: numbers for continuous factors, level labels for categorical ones. */
export type Settings = Record<string, number | string | null>

export interface Prediction {
  value: number
  lower: number
  upper: number
}

/** Value of one design-matrix part (see TermPart), or null when the setting is missing. */
export function partValue(part: TermPart, setting: number | string | null | undefined, levels?: string[] | null): number | null {
  if (setting === null || setting === undefined) return null
  if (part.level !== null && part.level !== undefined) {
    const last = levels?.[levels.length - 1]
    const label = String(setting)
    return label === part.level ? 1 : label === last ? -1 : 0
  }
  const x = typeof setting === 'number' ? setting : Number(setting)
  return Number.isFinite(x) ? (x - part.center) ** part.power : null
}

/** One row of the design matrix for the given settings (null if a needed factor is missing). */
export function designRow(spec: LinearModelSpec, settings: Settings): number[] | null {
  const levels = new Map(spec.factors.map((f) => [f.name, f.levels]))
  const row: number[] = []
  for (const term of spec.terms) {
    let v = 1
    for (const part of term.parts) {
      const pv = partValue(part, settings[part.factor], levels.get(part.factor))
      if (pv === null) return null
      v *= pv
    }
    row.push(v)
  }
  return row
}

/** Predicted mean with a 95% confidence interval. */
export function predict(spec: LinearModelSpec, settings: Settings): Prediction | null {
  const x = designRow(spec, settings)
  if (!x) return null
  let value = 0
  for (let i = 0; i < x.length; i++) value += x[i] * spec.coef[i]
  let variance = 0
  for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) variance += x[i] * (spec.cov[i]?.[j] ?? 0) * x[j]
  const half = spec.df_error > 0 ? tQuantile(0.975, spec.df_error) * Math.sqrt(Math.max(variance, 0)) : 0
  return { value, lower: value - half, upper: value + half }
}

/** Predictions for table rows; null where a factor is missing. */
export function predictRows(spec: LinearModelSpec, columnsByName: Map<string, Column>, rows: number[]): (number | null)[] {
  const factors = spec.factors.map((f) => ({ factor: f, column: columnsByName.get(f.name) }))
  return rows.map((r) => {
    const settings: Settings = {}
    for (const { factor, column } of factors) {
      const v = column?.values[r] ?? null
      settings[factor.name] = factor.kind === 'categorical' ? labelOf(v) : typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    return predict(spec, settings)?.value ?? null
  })
}

/** Initial profiler settings: continuous factors at their mean, categorical at their first level. */
export function defaultSettings(spec: LinearModelSpec): Settings {
  return Object.fromEntries(spec.factors.map((f) => [f.name, f.kind === 'categorical' ? (f.levels?.[0] ?? null) : (f.mean ?? 0)]))
}

/** The first least squares model (profiler spec) in a report, if any. */
export function findModel(nodes: ReportNode[]): LinearModelSpec | null {
  for (const node of nodes) {
    if (node.type === 'plot' && node.plot.kind === 'profiler') return node.plot.model
    if (node.type === 'outline' || node.type === 'row') {
      const found = findModel(node.children)
      if (found) return found
    }
  }
  return null
}

// ------------------------------------------------------------------ prediction formula

function num(x: number): string {
  return String(Number(x.toPrecision(12)))
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function partFormula(part: TermPart, levels?: string[] | null): string {
  const ref = formulaRef(part.factor)
  if (part.level !== null && part.level !== undefined) {
    const last = levels?.[levels.length - 1] ?? ''
    // A missing factor gives a missing prediction (`., .`), as in partValue.
    return `Match(${ref}, ${quote(part.level)}, 1, ${quote(last)}, -1, ., ., 0)`
  }
  const base = part.center === 0 ? ref : `(${ref} ${part.center > 0 ? '-' : '+'} ${num(Math.abs(part.center))})`
  return part.power === 1 ? base : `${base} ^ ${part.power}`
}

/** The model as a formula column (docs/formula-language.md), using effect-coded Match terms. */
export function predictionFormula(spec: LinearModelSpec): string {
  const levels = new Map(spec.factors.map((f) => [f.name, f.levels]))
  let out = ''
  spec.terms.forEach((term, i) => {
    const b = spec.coef[i]
    const factors = term.parts.map((p) => partFormula(p, levels.get(p.factor)))
    const body = [num(Math.abs(b)), ...factors].join(' * ')
    if (i === 0) out = b < 0 ? `-${body}` : body
    else out += ` ${b < 0 ? '-' : '+'} ${body}`
  })
  return out || '0'
}

// --------------------------------------------------------------------- t quantile

/** Continued fraction for the regularized incomplete beta function (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-300
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return h
}

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9)
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b
}

/** Student t cumulative distribution function. */
export function tCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5)
  return t >= 0 ? 1 - tail : tail
}

const quantileCache = new Map<string, number>()

/** Student t quantile by bisection on the CDF. */
export function tQuantile(p: number, df: number): number {
  const key = `${p}|${df}`
  const cached = quantileCache.get(key)
  if (cached !== undefined) return cached
  if (p === 0.5) return 0
  if (p < 0.5) return -tQuantile(1 - p, df)
  let lo = 0
  let hi = 1
  while (tCdf(hi, df) < p) hi *= 2
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (tCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  const q = (lo + hi) / 2
  quantileCache.set(key, q)
  return q
}
