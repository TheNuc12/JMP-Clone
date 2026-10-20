// Fit Model design matrix and least squares (port of the first half of
// backend/app/analyses/fit_model.py).
//
// Effects are lists of factor names; a repeated name is a power. The design matrix follows
// JMP: an intercept, continuous factors (centered at their mean inside crossed or
// polynomial effects), and effect-coded categorical factors (+1 at a level, -1 at the last
// level, crossing multiplies codes). Columns that are linear combinations of earlier columns
// are zeroed instead of failing the fit.

import type { ModelFactor, TermPart } from '../../api/types'
import { mean } from '../common'
import { inv, type Matrix } from '../math/linalg'
import { fmtNum } from '../report'

/** A column is dependent when its residual on earlier columns is this small relative to it. */
const SINGULAR_TOL = 1e-9
const EPS = 2.220446049250313e-16

export interface Factor {
  name: string
  categorical: boolean
  /** Continuous values of the used rows. */
  numbers: number[]
  /** Categorical labels of the used rows. */
  labels: string[]
  levels: string[]
  mean: number
}

export function continuousFactor(name: string, numbers: number[]): Factor {
  return { name, categorical: false, numbers, labels: [], levels: [], mean: numbers.length ? mean(numbers) : 0 }
}

export function categoricalFactor(name: string, labels: string[], levels: string[]): Factor {
  return { name, categorical: true, numbers: [], labels, levels, mean: 0 }
}

/** Values of one TermPart for every used row. */
export function partValues(f: Factor, part: TermPart): number[] {
  if (!f.categorical) return f.numbers.map((x) => (x - part.center) ** part.power)
  const last = f.levels[f.levels.length - 1]
  return f.labels.map((v) => (v === part.level ? 1 : v === last ? -1 : 0))
}

export function factorSpec(f: Factor): ModelFactor {
  if (f.categorical) return { name: f.name, kind: 'categorical', levels: f.levels }
  const min = f.numbers.reduce((a, b) => (b < a ? b : a), Infinity)
  const max = f.numbers.reduce((a, b) => (b > a ? b : a), -Infinity)
  return { name: f.name, kind: 'continuous', min, max, mean: f.mean }
}

export interface Term {
  label: string
  parts: TermPart[]
  /** Index into Design.effects. */
  effect: number
}

export interface Design {
  factors: Map<string, Factor>
  effects: string[][]
  effectNames: string[]
  /** Terms excluding the intercept. */
  terms: Term[]
  /** Design columns: column 0 is the intercept, column j + 1 is terms[j]. */
  X: number[][]
  n: number
}

export function effectColumns(design: Design, effect: number): number[] {
  const out: number[] = []
  design.terms.forEach((t, j) => {
    if (t.effect === effect) out.push(j + 1)
  })
  return out
}

export function termLabel(design: Design, col: number): string {
  return col === 0 ? 'Intercept' : design.terms[col - 1].label
}

function centerLabel(name: string, center: number): string {
  if (center === 0) return name
  return `(${name}${center > 0 ? '-' : '+'}${fmtNum(Math.abs(center), 6)})`
}

export function effectName(effect: string[]): string {
  return effect.join('*')
}

/** Cartesian product, last list varying fastest (itertools.product). */
function product<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]])
}

/** Expand effects into design-matrix terms (JMP's parameterization). */
export function buildDesign(factors: Map<string, Factor>, effects: string[][], centerPolynomials: boolean, n: number): Design {
  const terms: Term[] = []
  effects.forEach((effect, e) => {
    const counts = new Map<string, number>()
    for (const name of effect) counts.set(name, (counts.get(name) ?? 0) + 1)
    const crossed = effect.length > 1
    // Each factor contributes one part (continuous) or one of L-1 coded parts (categorical).
    const choices: TermPart[][] = []
    for (const [name, power] of counts) {
      const f = factors.get(name)!
      if (f.categorical) choices.push(f.levels.slice(0, -1).map((level) => ({ factor: name, center: 0, power: 1, level })))
      else choices.push([{ factor: name, center: crossed && centerPolynomials ? f.mean : 0, power, level: null }])
    }
    for (const parts of product(choices)) {
      const labels: string[] = []
      for (const p of parts) {
        if (p.level !== null && p.level !== undefined) labels.push(`${p.factor}[${p.level}]`)
        else for (let i = 0; i < p.power; i++) labels.push(centerLabel(p.factor, p.center))
      }
      terms.push({ label: labels.join('*'), parts, effect: e })
    }
  })
  const X: number[][] = [new Array<number>(n).fill(1)]
  for (const t of terms) {
    let col = new Array<number>(n).fill(1)
    for (const p of t.parts) {
      const values = partValues(factors.get(p.factor)!, p)
      col = col.map((v, i) => v * values[i])
    }
    X.push(col)
  }
  return { factors, effects, effectNames: effects.map(effectName), terms, X, n }
}

// -------------------------------------------------------------------- least squares

type Vec = ArrayLike<number>

function dotv(a: Vec, b: Vec): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** dotv for typed arrays (kept separate so the hot loop stays monomorphic). */
function dot64(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** X'X for the given design columns (same summation order as crossprod). */
function gram(X: number[][], cols: number[]): Matrix {
  const p = cols.length
  const out: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) out[i][j] = out[j][i] = dotv(X[cols[i]], X[cols[j]])
  }
  return out
}

/**
 * Orthonormal basis of the kept columns (modified Gram-Schmidt, applied twice), with the
 * triangular factor R so coefficients on the kept columns can be recovered.
 */
class Basis {
  q: Float64Array[] = []
  r: number[][] = []

  /** Residual of v after projecting out the basis, and the projection coefficients. */
  project(v: Vec): { residual: Float64Array; coef: number[] } {
    const residual = Float64Array.from(v)
    const n = residual.length
    const coef = new Array<number>(this.q.length).fill(0)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.q.length; i++) {
        const q = this.q[i]
        const c = dot64(q, residual)
        coef[i] += c
        for (let k = 0; k < n; k++) residual[k] -= c * q[k]
      }
    }
    return { residual, coef }
  }

  /** The basis of the first k kept columns. */
  prefix(k: number): Basis {
    const out = new Basis()
    out.q = this.q.slice(0, k)
    out.r = this.r.slice(0, k).map((row) => row.slice(0, k))
    return out
  }

  add(residual: Float64Array, coef: number[], norm: number): void {
    this.q.push(residual.map((v) => v / norm))
    this.r.forEach((row, i) => row.push(coef[i]))
    this.r.push([...new Array<number>(this.q.length - 1).fill(0), norm])
  }

  /** Solve R b = c for the coefficients on the kept columns. */
  backSolve(c: number[]): number[] {
    const p = c.length
    const b = new Array<number>(p).fill(0)
    for (let i = p - 1; i >= 0; i--) {
      let s = c[i]
      for (let j = i + 1; j < p; j++) s -= this.r[i][j] * b[j]
      b[i] = s / this.r[i][i]
    }
    return b
  }
}

export interface Independent {
  kept: number[]
  /** Dependent column -> its combination of kept columns ([column, coefficient] pairs). */
  zeroed: Map<number, [number, number][]>
  basis: Basis
}

/** Keep columns in order unless they are linear combinations of earlier kept ones. */
export function independentColumns(X: number[][], cols: number[]): Independent {
  return extendColumns({ kept: [], zeroed: new Map(), basis: new Basis() }, X, cols)
}

/** Continue independentColumns from `ind` with more columns (mutates and returns it). */
function extendColumns(ind: Independent, X: number[][], cols: number[]): Independent {
  const { kept, zeroed, basis } = ind
  for (const c of cols) {
    const v = X[c]
    const norm = Math.sqrt(dotv(v, v))
    if (norm === 0) {
      zeroed.set(c, [])
      continue
    }
    const { residual, coef } = basis.project(v)
    const rnorm = Math.sqrt(dot64(residual, residual))
    if (kept.length && rnorm <= SINGULAR_TOL * norm * Math.sqrt(v.length)) {
      const b = basis.backSolve(coef)
      zeroed.set(
        c,
        kept.flatMap((k, i): [number, number][] => (Math.abs(b[i]) > 1e-8 ? [[k, b[i]]] : [])),
      )
      continue
    }
    basis.add(residual, coef, rnorm)
    kept.push(c)
  }
  return ind
}

export interface OLSFit {
  cols: number[]
  kept: number[]
  zeroed: Map<number, [number, number][]>
  basis: Basis
  /** Estimates for the kept columns. */
  beta: number[]
  /** Covariance of beta (zeros when there is no error DF). */
  cov: Matrix
  pred: number[]
  resid: number[]
  sse: number
  dfe: number
  mse: number
}

export function estimate(fit: OLSFit, col: number): number {
  const i = fit.kept.indexOf(col)
  return i >= 0 ? fit.beta[i] : 0
}

/** Least squares coefficients of y on the kept columns, and the residuals. */
function solveKept(X: number[][], y: number[], ind: Independent): { beta: number[]; pred: number[]; resid: number[] } {
  const { coef } = ind.basis.project(y)
  const beta = ind.kept.length ? ind.basis.backSolve(coef) : []
  const pred = new Array<number>(y.length).fill(0)
  ind.kept.forEach((c, j) => {
    const col = X[c]
    for (let i = 0; i < y.length; i++) pred[i] += col[i] * beta[j]
  })
  return { beta, pred, resid: y.map((v, i) => v - pred[i]) }
}

/**
 * An SSE at the level of floating point rounding means an exact fit: report it as 0, so
 * rounding residue never turns into meaningless F and t ratios.
 */
function exactFitZero(sse: number, y: number[]): number {
  return sse <= (y.length * EPS * Math.sqrt(dotv(y, y))) ** 2 ? 0 : sse
}

export function ols(X: number[][], y: number[], cols: number[] = X.map((_, c) => c)): OLSFit {
  const ind = independentColumns(X, cols)
  const { beta, pred, resid } = solveKept(X, y, ind)
  const sse = exactFitZero(dotv(resid, resid), y)
  const dfe = y.length - ind.kept.length
  const p = ind.kept.length
  let cov: Matrix
  if (dfe > 0) {
    const scale = sse / dfe
    cov = inv(gram(X, ind.kept)).map((row) => row.map((v) => scale * v))
  } else cov = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  const { kept, zeroed, basis } = ind
  return { cols, kept, zeroed, basis, beta, cov, pred, resid, sse, dfe, mse: dfe > 0 ? sse / dfe : NaN }
}

/** Residual sum of squares and number of estimable columns for a sub-model. */
export function sseOf(X: number[][], y: number[], cols: number[]): [number, number] {
  return sseFrom(independentColumns(X, cols), X, y)
}

function sseFrom(ind: Independent, X: number[][], y: number[]): [number, number] {
  if (!ind.kept.length) return [dotv(y, y), 0]
  const { resid } = solveKept(X, y, ind)
  return [exactFitZero(dotv(resid, resid), y), ind.kept.length]
}

/**
 * sseOf(fit.cols without `drop`), reusing the fit's basis for the columns before the first
 * dropped one: Gram-Schmidt processes columns in order, so the result is the same.
 */
export function sseWithout(fit: OLSFit, X: number[][], y: number[], drop: number[]): [number, number] {
  const first = fit.cols.findIndex((c) => drop.includes(c))
  if (first < 0) return sseOf(X, y, fit.cols)
  const before = new Set(fit.cols.slice(0, first))
  let k = 0
  while (k < fit.kept.length && before.has(fit.kept[k])) k++
  const start: Independent = { kept: fit.kept.slice(0, k), zeroed: new Map(), basis: fit.basis.prefix(k) }
  const rest = fit.cols.slice(first).filter((c) => !drop.includes(c))
  return sseFrom(extendColumns(start, X, rest), X, y)
}
