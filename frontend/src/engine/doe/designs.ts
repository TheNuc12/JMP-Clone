// Design construction and evaluation for DOE, all in coded units (port of
// backend/app/doe_designs.py).
//
// Continuous factors are coded so the low/high settings are -1/+1. Categorical factors are
// stored as level indices (0, 1, ...). Model matrices use orthonormal contrasts for
// categorical factors (balanced designs give X'X = nI), so efficiencies read like JMP's:
// a full factorial scores 100.

import { crossprod, inv, matrixRank, qr, slogdet, type Matrix } from '../math/linalg'
import type { Generator } from '../math/random'
import { defaultRng } from '../math/random'
import { corrcoef, sum } from '../math/stats'
import { npRound } from '../pyformat'

export interface Factor {
  name: string
  continuous: boolean
  low: number
  high: number
  levels: string[]
}

export function nLevels(f: Factor): number {
  return f.continuous ? 2 : f.levels.length
}

/** Design runs in coded units plus a per-run pattern string. */
export class Runs {
  constructor(
    readonly coded: Matrix,
    readonly patterns: string[] = [],
  ) {}

  get length(): number {
    return this.coded.length
  }

  extend(other: Runs): Runs {
    return new Runs([...this.coded, ...other.coded], [...this.patterns, ...other.patterns])
  }

  repeat(times: number): Runs {
    const coded: Matrix = []
    const patterns: string[] = []
    for (let t = 0; t < times; t++) {
      coded.push(...this.coded.map((row) => row.slice()))
      patterns.push(...this.patterns)
    }
    return new Runs(coded, patterns)
  }
}

/** Every combination of the axes, the last axis varying fastest (itertools.product). */
export function product<T>(axes: readonly (readonly T[])[]): T[][] {
  let out: T[][] = [[]]
  for (const axis of axes) out = out.flatMap((prefix) => axis.map((v) => [...prefix, v]))
  return out
}

function combinations(n: number, r: number): number[][] {
  if (r === 0) return [[]]
  const out: number[][] = []
  for (let first = 0; first <= n - r; first++) for (const rest of combinations(n - first - 1, r - 1)) out.push([first, ...rest.map((i) => i + first + 1)])
  return out
}

const popcount = (mask: number) => {
  let n = 0
  for (let m = mask; m; m &= m - 1) n++
  return n
}

// ---------------------------------------------------------------------- patterns

/** Pattern symbol for a categorical level: 1-9, then A-Z. */
export function levelSymbol(index: number): string {
  const digits = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return index < digits.length ? digits[index] : '?'
}

/**
 * '-'/'+' for low/high, '0' for center, level symbols for categorical. Pass `alpha` for
 * axial runs: their nonzero coordinate is written 'a'/'A'.
 */
export function patternOf(row: readonly number[], factors: Factor[], alpha?: number): string {
  return factors
    .map((f, i) => {
      const value = row[i]
      if (!f.continuous) return levelSymbol(Math.trunc(value))
      if (Math.abs(value) < 1e-9) return '0'
      if (alpha !== undefined && Math.abs(Math.abs(value) - alpha) < 1e-9) return value < 0 ? 'a' : 'A'
      return value < 0 ? '-' : '+'
    })
    .join('')
}

export function makeRuns(rows: Matrix, factors: Factor[], alpha?: number): Runs {
  const coded = rows.map((r) => r.map(Number))
  return new Runs(
    coded,
    coded.map((r) => patternOf(r, factors, alpha)),
  )
}

// ---------------------------------------------------------------- full factorial

/** Every combination; continuous factors at -1/+1, categorical at every level. */
export function fullFactorial(factors: Factor[]): Runs {
  const axes = factors.map((f) => (f.continuous ? [-1, 1] : f.levels.map((_, i) => i)))
  return makeRuns(product(axes), factors)
}

/** Continuous factors at 0; categorical factors cycle through their level combinations. */
export function centerPoints(factors: Factor[], count: number): Runs {
  const combos = product(factors.filter((f) => !f.continuous).map((f) => f.levels.map((_, i) => i)))
  const rows: Matrix = []
  for (let i = 0; i < count; i++) {
    const combo = combos[i % combos.length]
    let next = 0
    rows.push(factors.map((f) => (f.continuous ? 0 : combo[next++])))
  }
  return makeRuns(rows, factors)
}

// ------------------------------------------------------------ fractional factorial

// Minimum aberration generators (Montgomery, Design and Analysis of Experiments, Table 8.14).
// Base factors are the first letters; each generator defines one added factor.
const GENERATORS: Record<number, Record<number, string[]>> = {
  3: { 4: ['AB'] },
  4: { 8: ['ABC'] },
  5: { 8: ['AB', 'AC'], 16: ['ABCD'] },
  6: { 8: ['AB', 'AC', 'BC'], 16: ['ABC', 'BCD'], 32: ['ABCDE'] },
  7: { 8: ['AB', 'AC', 'BC', 'ABC'], 16: ['ABC', 'BCD', 'ACD'], 32: ['ABCD', 'ABDE'], 64: ['ABCDEF'] },
  8: { 16: ['BCD', 'ACD', 'ABC', 'ABD'], 32: ['ABC', 'ABD', 'BCDE'], 64: ['ABCD', 'ABEF'], 128: ['ABCDEFG'] },
  9: {
    16: ['ABC', 'BCD', 'ACD', 'ABD', 'ABCD'],
    32: ['BCDE', 'ACDE', 'ABDE', 'ABCE'],
    64: ['ABCD', 'ACEF', 'CDEF'],
    128: ['ACDFG', 'BCEFG'],
  },
  10: {
    16: ['ABC', 'BCD', 'ACD', 'ABD', 'ABCD', 'AB'],
    32: ['ABCD', 'ABCE', 'ABDE', 'ACDE', 'BCDE'],
    64: ['BCDF', 'ACDF', 'ABDE', 'ABCE'],
    128: ['ABCG', 'BCDE', 'ACDF'],
  },
  11: {
    16: ['ABC', 'BCD', 'ACD', 'ABD', 'ABCD', 'AB', 'AC'],
    32: ['ABC', 'BCD', 'CDE', 'ACD', 'ADE', 'BDE'],
    64: ['CDE', 'ABCD', 'ABF', 'BDEF', 'ADEF'],
    128: ['ABCG', 'BCDE', 'ACDF', 'ABCDEFG'],
  },
}

export const MAX_FRACTIONAL_FACTORS = 15
/** Stands in for "no aliasing". */
const FULL_RESOLUTION = 99

function wordMask(word: string): number {
  let mask = 0
  for (const ch of word) mask += 1 << (ch.charCodeAt(0) - 65)
  return mask
}

const byLengthThenMask = (a: number, b: number) => popcount(a) - popcount(b) || a - b

/** Words of odd length >= 3 in m base factors; any subset gives a resolution IV design. */
function oddWords(m: number): number[] {
  const words: number[] = []
  for (let mask = 1; mask < 1 << m; mask++) if (popcount(mask) % 2 === 1 && popcount(mask) >= 3) words.push(mask)
  return words.sort(byLengthThenMask)
}

/** All interactions of m base factors, shortest first (saturated resolution III designs). */
function interactionWords(m: number): number[] {
  const words: number[] = []
  for (let mask = 1; mask < 1 << m; mask++) if (popcount(mask) >= 2) words.push(mask)
  return words.sort(byLengthThenMask)
}

export class Fraction {
  constructor(
    readonly k: number,
    readonly runs: number,
    /** Base-factor masks, one per added factor. */
    readonly generators: number[],
  ) {}

  get m(): number {
    return Math.log2(this.runs)
  }

  /** All words of the defining relation, as factor bit masks. */
  get definingWords(): number[] {
    const gens = this.generators.map((g, i) => g | (1 << (this.m + i)))
    const words: number[] = []
    for (let r = 1; r <= gens.length; r++) {
      for (const combo of combinations(gens.length, r)) {
        let w = 0
        for (const g of combo) w ^= gens[g]
        words.push(w)
      }
    }
    return words
  }

  /** Shortest word length of the defining relation; a full factorial aliases nothing. */
  get resolution(): number {
    const words = this.definingWords
    return words.length ? Math.min(...words.map(popcount)) : FULL_RESOLUTION
  }
}

const fractionCache = new Map<number, Fraction[]>()

/** Available 2-level designs for k factors, smallest first; the last is the full factorial. */
export function fractionsFor(k: number): Fraction[] {
  const cached = fractionCache.get(k)
  if (cached) return cached
  const out: Fraction[] = []
  for (const [runs, gens] of Object.entries(GENERATORS[k] ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    out.push(new Fraction(k, Number(runs), gens.map(wordMask)))
  }
  if (k > 11) {
    // Saturated 16-run resolution III and odd-word resolution IV designs.
    const pools: [number, number[]][] = [
      [4, interactionWords(4)],
      [5, oddWords(5)],
      [6, oddWords(6)],
      [7, oddWords(7)],
    ]
    for (const [m, pool] of pools) if (pool.length >= k - m) out.push(new Fraction(k, 1 << m, pool.slice(0, k - m)))
  }
  if (k <= 12) out.push(new Fraction(k, 2 ** k, []))
  const sorted = out.sort((a, b) => a.runs - b.runs)
  fractionCache.set(k, sorted)
  return sorted
}

export function roman(n: number): string {
  return ({ 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X' } as Record<number, string>)[n] ?? String(n)
}

/** Smallest design with at least the requested resolution (default: IV when possible). */
export function chooseFraction(k: number, resolution: number | null): Fraction {
  const options = fractionsFor(k)
  if (!options.length) throw new RangeError(`Screening designs support 2 to ${MAX_FRACTIONAL_FACTORS} factors.`)
  const wanted = resolution ?? 4
  for (const f of options) if (f.resolution >= wanted) return f
  if (resolution === null) return options[0]
  throw new RangeError(`No design with resolution ${roman(resolution)} is available for ${k} factors.`)
}

export function fractionRuns(fraction: Fraction, factors: Factor[]): Runs {
  const base = product(Array.from({ length: fraction.m }, () => [-1, 1]))
  const coded = base.map((row) => {
    const out = row.slice()
    for (const g of fraction.generators) {
      let col = 1
      for (let i = 0; i < fraction.m; i++) if ((g >> i) & 1) col *= row[i]
      out.push(col)
    }
    // Two-level categorical factors: -1/+1 become level indices 0/1.
    factors.forEach((f, j) => {
      if (!f.continuous) out[j] = out[j] > 0 ? 1 : 0
    })
    return out
  })
  return makeRuns(coded, factors)
}

export function wordName(mask: number, names: string[]): string {
  return names.filter((_, i) => (mask >> i) & 1).join('*')
}

/** Alias groups for main effects and two-factor interactions (aliases up to order 2). */
export function aliasStructure(fraction: Fraction, names: string[]): [string, string][] {
  const words = fraction.definingWords
  const k = fraction.k
  const effects: number[] = []
  for (let i = 0; i < k; i++) effects.push(1 << i)
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) effects.push((1 << i) | (1 << j))
  const seen = new Set<number>()
  const rows: [string, string][] = []
  for (const e of effects) {
    if (seen.has(e)) continue
    const aliases = [...new Set(words.map((w) => e ^ w).filter((a) => popcount(a) <= 2))].sort(byLengthThenMask)
    seen.add(e)
    for (const a of aliases) seen.add(a)
    if (popcount(e) === 1 || aliases.length) rows.push([wordName(e, names), aliases.map((a) => wordName(a, names)).join(' = ')])
  }
  return rows
}

export function generatorText(fraction: Fraction, names: string[]): string[] {
  return fraction.generators.map((g, i) => `${names[fraction.m + i]} = ${wordName(g, names)}`)
}

// --------------------------------------------------------------- response surface

export const MAX_CCD_FACTORS = 8

export function ccdAlpha(kind: string, k: number, nFactorial: number, nCenter: number): number {
  if (kind === 'face_centered') return 1
  if (kind === 'orthogonal') {
    const t = 2 * k + nCenter
    const q = (Math.sqrt(nFactorial + t) - Math.sqrt(nFactorial)) ** 2
    return ((q * nFactorial) / 4) ** 0.25
  }
  return nFactorial ** 0.25 // rotatable
}

/** Central composite design: cube + axial runs, center runs, alpha and the cube fraction. */
export function ccd(factors: Factor[], alphaKind: string, nCenter: number): { base: Runs; centers: Runs; alpha: number; cube: Fraction } {
  const k = factors.length
  const cubeDesign = chooseFraction(k, 5)
  const cube = fractionRuns(cubeDesign, factors)
  const alpha = ccdAlpha(alphaKind, k, cube.length, nCenter)
  const axial: Matrix = []
  for (let i = 0; i < k; i++) {
    for (const sign of [-1, 1]) {
      const row = new Array<number>(k).fill(0)
      row[i] = sign * alpha
      axial.push(row)
    }
  }
  const star = makeRuns(axial, factors, alpha)
  const centers = makeRuns(
    Array.from({ length: nCenter }, () => new Array<number>(k).fill(0)),
    factors,
  )
  return { base: cube.extend(star), centers, alpha, cube: cubeDesign }
}

// Factor groupings for Box-Behnken designs: pairs for 3-5 factors, balanced incomplete
// block designs of size 3 for 6 and 7 factors (Box & Behnken, 1960).
const BBD_BLOCKS: Record<number, number[][]> = {
  6: [
    [0, 1, 3],
    [1, 2, 4],
    [2, 3, 5],
    [0, 3, 4],
    [1, 4, 5],
    [0, 2, 5],
  ],
  7: [
    [0, 1, 3],
    [1, 2, 4],
    [2, 3, 5],
    [3, 4, 6],
    [0, 4, 5],
    [1, 5, 6],
    [0, 2, 6],
  ],
}
export const BBD_FACTORS = new Set([3, 4, 5, 6, 7])

export function boxBehnken(factors: Factor[]): Runs {
  const k = factors.length
  const blocks = BBD_BLOCKS[k] ?? combinations(k, 2)
  const rows: Matrix = []
  for (const block of blocks) {
    for (const signs of product(block.map(() => [-1, 1]))) {
      const row = new Array<number>(k).fill(0)
      block.forEach((i, s) => (row[i] = signs[s]))
      rows.push(row)
    }
  }
  return makeRuns(rows, factors)
}

// ------------------------------------------------------------------- model matrix

/** Factor indices; a repeated index is a power. */
export type Effect = number[]

/** [index, count] pairs in first-occurrence order (Python's Counter). */
function counts(effect: Effect): [number, number][] {
  const out = new Map<number, number>()
  for (const i of effect) out.set(i, (out.get(i) ?? 0) + 1)
  return [...out]
}

const contrastCache = new Map<number, Matrix>()

/** (n_levels, n_levels - 1) orthonormal contrasts scaled so each column has mean square 1. */
export function contrasts(n: number): Matrix {
  const cached = contrastCache.get(n)
  if (cached) return cached
  // Effect coding is already centered: each column holds one +1 and one -1.
  const effect = Array.from({ length: n }, (_, i) => Array.from({ length: n - 1 }, (_, j) => (i === n - 1 ? -1 : i === j ? 1 : 0)))
  const { q } = qr(effect)
  const out = q.map((row) => row.slice(0, n - 1).map((v) => v * Math.sqrt(n)))
  contrastCache.set(n, out)
  return out
}

export function effectLabel(effect: Effect, factors: Factor[]): string {
  return effect.map((i) => factors[i].name).join('*')
}

/**
 * Precomputed layout of a model matrix: intercept plus one block of columns per effect.
 * Effects of continuous factors only are single columns (products of powers); effects with
 * categorical factors expand into contrast products.
 */
export class ModelPlan {
  readonly labels = ['Intercept']
  private readonly powerTerms: { position: number; exponents: number[] }[] = []
  private readonly blocks: { start: number; effect: Effect }[] = []

  constructor(
    private readonly factors: Factor[],
    effects: Effect[],
  ) {
    for (const effect of effects) {
      const parts = counts(effect)
      if (parts.every(([i]) => factors[i].continuous)) {
        const exponents = new Array<number>(factors.length).fill(0)
        for (const [i, c] of parts) exponents[i] = c
        this.powerTerms.push({ position: this.labels.length, exponents })
        this.labels.push(effectLabel(effect, factors))
      } else {
        this.blocks.push({ start: this.labels.length, effect })
        let names = ['']
        for (const [index, count] of parts) {
          const f = factors[index]
          const part = f.continuous ? [Array(count).fill(f.name).join('*')] : f.levels.slice(1).map((_, j) => `${f.name}[${j + 1}]`)
          names = names.flatMap((a) => part.map((b) => (a ? `${a}*${b}` : b)))
        }
        this.labels.push(...names)
      }
    }
  }

  get p(): number {
    return this.labels.length
  }

  row(coded: readonly number[]): number[] {
    const out = new Array<number>(this.p)
    out[0] = 1
    for (const { position, exponents } of this.powerTerms) {
      // Categorical columns have exponent 0, so their level indices drop out.
      let value = 1
      for (let i = 0; i < exponents.length; i++) value *= coded[i] ** exponents[i]
      out[position] = value
    }
    for (const { start, effect } of this.blocks) {
      let block = [1]
      for (const [index, power] of counts(effect)) {
        const f = this.factors[index]
        const part = f.continuous ? [coded[index] ** power] : contrasts(f.levels.length)[Math.trunc(coded[index])]
        block = block.flatMap((a) => part.map((b) => a * b))
      }
      for (let c = 0; c < block.length; c++) out[start + c] = block[c]
    }
    return out
  }

  matrix(coded: Matrix): Matrix {
    return coded.map((r) => this.row(r))
  }
}

const planCache = new Map<string, ModelPlan>()

function planFor(factors: Factor[], effects: Effect[]): ModelPlan {
  const key = JSON.stringify([factors, effects])
  let plan = planCache.get(key)
  if (!plan) {
    if (planCache.size >= 64) planCache.clear()
    planCache.set(key, (plan = new ModelPlan(factors, effects)))
  }
  return plan
}

/** Intercept plus one block of columns per effect (products of factor parts), with labels. */
export function modelMatrix(coded: Matrix, factors: Factor[], effects: Effect[]): { x: Matrix; labels: string[] } {
  const plan = planFor(factors, effects)
  return { x: plan.matrix(coded), labels: plan.labels }
}

export function nParameters(factors: Factor[], effects: Effect[]): number {
  let total = 1
  for (const effect of effects) {
    let size = 1
    for (const index of new Set(effect)) size *= factors[index].continuous ? 1 : factors[index].levels.length - 1
    total += size
  }
  return total
}

// -------------------------------------------------------------------- diagnostics

/** numpy's leggauss(3): the 3-point Gauss-Legendre rule, exact for these moments. */
const GL_NODES = [-0.7745966692414834, 0.0, 0.7745966692414834]
const GL_WEIGHTS = [0.5555555555555557, 0.8888888888888888, 0.5555555555555557]

/** Tensor grid over the design region (or a random sample when the grid is too big), with weights. */
function regionPoints(factors: Factor[], continuousLevels: number[], weights: number[] | null, limit: number, rng: Generator): { points: Matrix; w: number[] } {
  const axes = factors.map((f) => (f.continuous ? continuousLevels.map((_, i) => i) : f.levels.map((_, i) => i)))
  const size = axes.reduce((acc, a) => acc * a.length, 1)
  if (size <= limit) {
    const indices = product(axes)
    const points = indices.map((idx) => idx.map((v, j) => (factors[j].continuous ? continuousLevels[v] : v)))
    if (!weights) return { points, w: new Array<number>(points.length).fill(1 / points.length) }
    const w = indices.map((idx) => {
      let value = 1
      factors.forEach((f, j) => (value *= f.continuous ? weights[idx[j]] : 1 / f.levels.length))
      return value
    })
    const total = sum(w)
    return { points, w: w.map((v) => v / total) }
  }
  const cols = factors.map((f) =>
    Array.from({ length: limit }, () => (f.continuous ? rng.uniform(-1, 1) : rng.integers(0, f.levels.length))),
  )
  const points = Array.from({ length: limit }, (_, r) => cols.map((c) => c[r]))
  return { points, w: new Array<number>(limit).fill(1 / limit) }
}

export interface Diagnostics {
  dEfficiency: number
  aEfficiency: number
  gEfficiency: number
  averageVariance: number
}

/** x' A x */
function quadForm(x: readonly number[], a: Matrix): number {
  let total = 0
  for (let i = 0; i < x.length; i++) {
    let s = 0
    const ai = a[i]
    for (let j = 0; j < x.length; j++) s += ai[j] * x[j]
    total += x[i] * s
  }
  return total
}

/** JMP-style efficiencies over the cube [-1, 1]^k; null when the model is not estimable. */
export function diagnose(coded: Matrix, factors: Factor[], effects: Effect[]): Diagnostics | null {
  const { x } = modelMatrix(coded, factors, effects)
  const n = x.length
  const p = planFor(factors, effects).p
  const xtx = crossprod(x)
  if (n < p || matrixRank(xtx) < p) return null
  const xtxInv = inv(xtx)
  const { logabsdet } = slogdet(xtx)
  const dEff = (100 * Math.exp(logabsdet / p)) / n
  let trace = 0
  for (let i = 0; i < p; i++) trace += xtxInv[i][i]
  const aEff = (100 * p) / (n * trace)
  const rng = defaultRng(0)
  // Moment matrix of the uniform region: 3-point Gauss-Legendre is exact for these degrees.
  const region = regionPoints(factors, GL_NODES, GL_WEIGHTS, 20_000, rng)
  const f = modelMatrix(region.points, factors, effects).x
  const moments: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  f.forEach((row, r) => {
    const w = region.w[r]
    for (let i = 0; i < p; i++) {
      const wi = row[i] * w
      for (let j = 0; j < p; j++) moments[i][j] += wi * row[j]
    }
  })
  let averageVariance = 0
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) averageVariance += moments[i][j] * xtxInv[j][i]
  // Maximum prediction variance over a grid of the region plus the design points.
  const grid = regionPoints(factors, [-1, -0.5, 0, 0.5, 1], null, 20_000, rng).points
  let maxVar = -Infinity
  for (const row of modelMatrix([...grid, ...coded], factors, effects).x) maxVar = Math.max(maxVar, quadForm(row, xtxInv))
  const gEff = (100 * Math.sqrt(p / n)) / Math.sqrt(maxVar)
  return { dEfficiency: dEff, aEfficiency: aEff, gEfficiency: Math.min(gEff, 100), averageVariance }
}

/** Absolute correlations between model terms (intercept excluded), rounded to 4 places. */
export function correlations(coded: Matrix, factors: Factor[], effects: Effect[]): { labels: string[]; corr: Matrix } {
  const { x, labels } = modelMatrix(coded, factors, effects)
  const terms = x.map((row) => row.slice(1))
  const corr = terms[0]?.length > 1 ? corrcoef(terms) : [[1]]
  // Round away floating point noise such as 2e-17.
  return { labels: labels.slice(1), corr: corr.map((row) => row.map((v) => npRound(Math.abs(v), 4))) }
}

// --------------------------------------------------------------- D-optimal design

/** {-1, 0, 1} for continuous factors in a power term, {-1, 1} otherwise; all levels for categorical. */
export function candidateLevels(factors: Factor[], effects: Effect[]): number[][] {
  const squared = new Set<number>()
  for (const e of effects) for (const [i, c] of counts(e)) if (c > 1) squared.add(i)
  return factors.map((f, i) => (f.continuous ? (squared.has(i) ? [-1, 0, 1] : [-1, 1]) : f.levels.map((_, j) => j)))
}

function logdet(xtx: Matrix): number {
  const { sign, logabsdet } = slogdet(xtx)
  return sign > 0 ? logabsdet : -Infinity
}

/** A random design, preferring one whose information matrix is nonsingular. */
function randomStart(levels: number[][], nRuns: number, plan: ModelPlan, rng: Generator): Matrix {
  const draw = () => {
    const cols = levels.map((lv) => Array.from({ length: nRuns }, () => rng.choice(lv)))
    return Array.from({ length: nRuns }, (_, r) => cols.map((c) => c[r]))
  }
  let design = draw()
  for (let attempt = 0; attempt < 20; attempt++) {
    if (matrixRank(plan.matrix(design)) === plan.p) break
    design = draw()
  }
  return design
}

function addRidge(xtx: Matrix, ridge: number): Matrix {
  return ridge ? xtx.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v))) : xtx
}

const matvec = (a: Matrix, x: readonly number[]) =>
  a.map((row) => {
    let s = 0
    for (let j = 0; j < x.length; j++) s += row[j] * x[j]
    return s
  })

const dot = (a: readonly number[], b: readonly number[]) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Maximize det(X'X) by changing one coordinate at a time, from several random starts.
 *
 * Each coordinate tries all of its candidate levels at once using Fedorov's delta,
 * det(new) / det(old) = (1 + a)(1 - c) + b^2 with a = x_new' V x_new, c = x_old' V x_old,
 * b = x_new' V x_old and V = (X'X)^-1, which is kept up to date with Sherman-Morrison.
 */
export function coordinateExchange(factors: Factor[], effects: Effect[], nRuns: number, rng: Generator, starts = 10, maxPasses = 30): Matrix {
  const plan = planFor(factors, effects)
  const k = factors.length
  const p = plan.p
  const levels = candidateLevels(factors, effects)
  // Big problems get fewer starts so the request stays interactive.
  const work = nRuns * levels.reduce((acc, lv) => acc + lv.length, 0) * p * p
  const budget = Math.max(2, Math.min(starts, Math.trunc(2e7 / Math.max(1, work))))
  let bestDesign: Matrix | null = null
  let bestValue = -Infinity
  for (let start = 0; start < budget; start++) {
    const design = randomStart(levels, nRuns, plan, rng)
    const x = plan.matrix(design)
    let xtx = crossprod(x)
    // A small ridge keeps V finite if the start is singular; it fades once X'X is full rank.
    let trace = 0
    for (let i = 0; i < p; i++) trace += xtx[i][i]
    let ridge = matrixRank(xtx) === p ? 0 : 1e-6 * Math.max(1, trace / p)
    let v = inv(addRidge(xtx, ridge))
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false
      for (let i = 0; i < nRuns; i++) {
        for (let j = 0; j < k; j++) {
          const trial = levels[j].map((level) => {
            const row = design[i].slice()
            row[j] = level
            return row
          })
          const rows = plan.matrix(trial)
          const old = x[i]
          let vOld = matvec(v, old)
          const c = dot(old, vOld)
          let best = 0
          let bestDelta = -Infinity
          rows.forEach((row, r) => {
            // row V (as numpy's rows @ v; V is only symmetric up to rounding)
            const vRow = new Array<number>(p).fill(0)
            for (let s = 0; s < p; s++) {
              const rs = row[s]
              if (rs === 0) continue
              const vs = v[s]
              for (let t = 0; t < p; t++) vRow[t] += rs * vs[t]
            }
            const a = dot(vRow, row)
            const b = dot(vRow, old)
            const delta = (1 + a) * (1 - c) + b * b
            if (delta > bestDelta) {
              bestDelta = delta
              best = r
            }
          })
          if (bestDelta <= 1 + 1e-9 || trial[best][j] === design[i][j]) continue
          const next = rows[best]
          // V for X'X + new new' - old old' (two rank-one updates).
          const vNew = matvec(v, next)
          const dNew = 1 + dot(next, vNew)
          v = v.map((row, r) => row.map((value, s) => value - (vNew[r] * vNew[s]) / dNew))
          vOld = matvec(v, old)
          const dOld = 1 - dot(old, vOld)
          v = v.map((row, r) => row.map((value, s) => value + (vOld[r] * vOld[s]) / dOld))
          x[i] = next
          design[i][j] = trial[best][j]
          improved = true
        }
      }
      // Refresh V to keep rounding errors from accumulating.
      xtx = crossprod(x)
      if (ridge && matrixRank(xtx) === p) ridge = 0
      v = inv(addRidge(xtx, ridge))
      if (!improved) break
    }
    const value = logdet(crossprod(x))
    if (value > bestValue) {
      bestDesign = design.map((row) => row.slice())
      bestValue = value
    }
  }
  return bestDesign!
}
