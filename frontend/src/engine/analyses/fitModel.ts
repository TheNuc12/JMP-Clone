// Fit Model: standard least squares, stepwise and logistic models with several effects
// (port of backend/app/analyses/fit_model.py; the design matrix lives in fitModelDesign.ts).

import type { AnalysisColumn, AnalysisResult, LinearModelSpec, OptionItem, ReportNode } from '../../api/types'
import { labelValues, levelsOf, mean, numericValues, sum } from '../common'
import { RequestError } from '../errors'
import { chi2, f as fDist, t as tDist } from '../math/distributions'
import type { Matrix } from '../math/linalg'
import { logit, mnlogit, orderedLogit } from '../math/models'
import * as r from '../report'
import {
  buildDesign,
  categoricalFactor,
  continuousFactor,
  effectColumns,
  estimate,
  factorSpec,
  ols,
  sseOf,
  sseWithout,
  termLabel,
  independentColumns,
  type Design,
  type Factor,
  type OLSFit,
} from './fitModelDesign'
import type { Request } from './index'

const OPTIONS: [string, string, boolean][] = [
  ['effect_tests', 'Effect Tests', true],
  ['lack_of_fit', 'Lack of Fit', true],
  ['residual_plot', 'Residual by Predicted Plot', true],
  ['profiler', 'Prediction Profiler', true],
  ['sorted_estimates', 'Sorted Parameter Estimates', false],
  ['lsmeans', 'Least Squares Means', false],
]

type Options = Record<string, boolean>
type Maybe<T> = T | null

function pF(f: number, df1: number, df2: number): number | null {
  return Number.isFinite(f) && df1 > 0 && df2 > 0 ? fDist.sf(f, df1, df2) : null
}

function pT(t: number, df: number): number | null {
  return Number.isFinite(t) && df > 0 ? 2 * tDist.sf(Math.abs(t), df) : null
}

const sameEffect = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// --------------------------------------------------------------------------- inputs

/** Parsed request: used rows, response, factors and effects. */
interface Inputs {
  yname: string
  yNumbers: number[]
  yLabels: string[]
  factors: Map<string, Factor>
  effects: string[][]
  /** Positions of the used rows in the request arrays. */
  used: number[]
  nMissing: number
}

function parseInputs(req: Request): Inputs {
  const columns = new Map<string, AnalysisColumn>()
  for (const c of req.roles.factors ?? []) columns.set(c.name, c)
  const rawEffects = (req.params.effects || []) as unknown
  if (!Array.isArray(rawEffects) || !rawEffects.every((e) => Array.isArray(e) && e.length > 0)) {
    throw new RequestError('params.effects must be a list of non-empty lists of factor names.')
  }
  const effects: string[][] = []
  for (const effect of rawEffects as unknown[][]) {
    const names = effect.map(String)
    const unknown = names.filter((n) => !columns.has(n))
    if (unknown.length) throw new RequestError(`Effect uses unknown factor(s): ${unknown.join(', ')}.`)
    // A categorical factor can appear once per effect; repeats only make sense as powers.
    const dedup: string[] = []
    for (const n of names) {
      if (columns.get(n)!.modeling_type !== 'continuous' && dedup.includes(n)) continue
      dedup.push(n)
    }
    if (!effects.some((e) => sameEffect(e, dedup))) effects.push(dedup)
  }
  for (const c of columns.values()) {
    if (c.values.length !== req.y.values.length) throw new RequestError('Every column must have the same number of values.')
  }

  const usedNames = [...new Set(effects.flat())]
  const yCont = req.y.modeling_type === 'continuous'
  const yNum = yCont ? numericValues(req.y) : []
  const yLab = yCont ? [] : labelValues(req.y)
  const ok = req.y.values.map((_, i) => (yCont ? Number.isFinite(yNum[i]) : yLab[i] !== null))
  const raw = new Map<string, number[] | (string | null)[]>()
  for (const name of usedNames) {
    const c = columns.get(name)!
    if (c.modeling_type === 'continuous') {
      const vals = numericValues(c)
      vals.forEach((v, i) => (ok[i] &&= Number.isFinite(v)))
      raw.set(name, vals)
    } else {
      const labs = labelValues(c)
      labs.forEach((v, i) => (ok[i] &&= v !== null))
      raw.set(name, labs)
    }
  }
  const used = ok.flatMap((good, i) => (good ? [i] : []))
  const factors = new Map<string, Factor>()
  for (const name of usedNames) {
    const vals = raw.get(name)!
    if (columns.get(name)!.modeling_type === 'continuous') factors.set(name, continuousFactor(name, used.map((i) => vals[i] as number)))
    else {
      const labs = used.map((i) => vals[i] as string)
      factors.set(name, categoricalFactor(name, labs, levelsOf(labs, columns.get(name)!.levels)))
    }
  }
  return {
    yname: req.y.name,
    yNumbers: yCont ? used.map((i) => yNum[i]) : [],
    yLabels: yCont ? [] : used.map((i) => yLab[i] as string),
    factors,
    effects,
    used,
    nMissing: req.y.values.length - used.length,
  }
}

// ---------------------------------------------------------------------- entry point

export function analyze(req: Request): AnalysisResult {
  const inputs = parseInputs(req)
  const centerParam = req.params.center_polynomials
  const center = centerParam === undefined ? true : Boolean(centerParam)
  if (req.y.modeling_type !== 'continuous') return logisticFit(inputs, req.y, center)
  const [opts, items] = r.resolveOptions(OPTIONS, req.options)
  if (req.params.personality === 'stepwise') return stepwiseFit(inputs, opts, items, req.params, center)
  const title = `Response ${inputs.yname}`
  const children = leastSquaresReport(inputs, inputs.effects, opts, center)
  return { analysis: 'fit_model_least_squares', title, options: items, nodes: [r.outline(title, children)] }
}

function missingNote(inputs: Inputs): Maybe<ReportNode> {
  return inputs.nMissing ? r.text(`${inputs.nMissing} row(s) excluded for missing values.`) : null
}

function degenerate(inputs: Inputs, effects: string[][]): string | null {
  if (!effects.length) return 'Add at least one effect to the model.'
  if (inputs.used.length === 0) return 'No rows have the response and every factor nonmissing.'
  for (const f of inputs.factors.values()) {
    if (f.categorical && f.levels.length < 2) return `${f.name} has fewer than 2 levels in the rows used; it cannot be an effect.`
  }
  return null
}

const squaredDeviations = (y: number[]) => {
  const m = mean(y)
  return sum(y.map((v) => (v - m) ** 2))
}

// ---------------------------------------------------------------- least squares report

function leastSquaresReport(inputs: Inputs, effects: string[][], opts: Options, center: boolean): Maybe<ReportNode>[] {
  const problem = degenerate(inputs, effects)
  if (problem) return [r.warning(problem), missingNote(inputs)]
  const factors = new Map<string, Factor>()
  for (const name of effects.flat()) if (!factors.has(name)) factors.set(name, inputs.factors.get(name)!)
  const design = buildDesign(factors, effects, center, inputs.used.length)
  const y = inputs.yNumbers
  const n = y.length
  const fit = ols(design.X, y)
  const sst = squaredDeviations(y)
  const dfModel = fit.kept.length - 1
  const mse = fit.mse
  const children: Maybe<ReportNode>[] = []

  if (fit.dfe <= 0) {
    children.push(
      r.warning('There are no degrees of freedom for error: the model has as many estimable parameters as rows. Tests are unavailable.'),
    )
  }
  if (sst === 0) children.push(r.warning(`${inputs.yname} is constant in the rows used; RSquare is undefined.`))
  if (fit.zeroed.size) children.push(r.warning(singularityText(design, fit)))

  const lo = Math.min(minOf(fit.pred), minOf(y))
  const hi = Math.max(maxOf(fit.pred), maxOf(y))
  children.push(
    r.outline('Actual by Predicted Plot', [
      r.plot({
        kind: 'indexed_scatter',
        x_label: `${inputs.yname} Predicted`,
        y_label: `${inputs.yname} Actual`,
        x: fit.pred,
        y,
        indices: inputs.used,
        curves: [{ label: 'Actual = Predicted', x: [lo, hi], y: [lo, hi] }],
        hlines: [{ label: 'Mean', value: mean(y) }],
      }),
    ]),
  )
  const rsq = sst > 0 ? 1 - fit.sse / sst : null
  const rsqAdj = sst > 0 && fit.dfe > 0 && n > 1 ? 1 - fit.sse / fit.dfe / (sst / (n - 1)) : null
  children.push(
    r.outline('Summary of Fit', [
      r.summary([
        ['RSquare', rsq],
        ['RSquare Adj', rsqAdj],
        ['Root Mean Square Error', fit.dfe > 0 ? Math.sqrt(mse) : null],
        ['Mean of Response', mean(y)],
        ['Observations (or Sum Wgts)', n, 'integer'],
      ]),
    ]),
  )
  const ssm = sst - fit.sse
  const fModel = dfModel > 0 && fit.dfe > 0 && mse > 0 ? ssm / dfModel / mse : NaN
  children.push(
    r.outline('Analysis of Variance', [
      r.table(
        [['Source', 'text'], ['DF', 'integer'], 'Sum of Squares', 'Mean Square', 'F Ratio', ['Prob > F', 'pvalue']],
        [
          ['Model', dfModel, ssm, dfModel > 0 ? ssm / dfModel : null, fModel, pF(fModel, dfModel, fit.dfe)],
          ['Error', fit.dfe, fit.sse, fit.dfe > 0 ? mse : null, null, null],
          ['C. Total', n - 1, sst, null, null, null],
        ],
      ),
    ]),
  )
  if (opts.lack_of_fit) children.push(lackOfFit(design, y, fit, sst))
  children.push(r.outline('Parameter Estimates', [parameterTable(design, fit)]))
  if (opts.sorted_estimates) children.push(sortedEstimates(design, fit))
  if (opts.effect_tests) children.push(effectTests(design, y, fit))
  if (opts.lsmeans) children.push(...lsMeans(design, y, fit))
  if (opts.residual_plot) {
    children.push(
      r.outline('Residual by Predicted Plot', [
        r.plot({
          kind: 'indexed_scatter',
          x_label: `${inputs.yname} Predicted`,
          y_label: `${inputs.yname} Residual`,
          x: fit.pred,
          y: fit.resid,
          indices: inputs.used,
          curves: [],
          hlines: [{ label: '0', value: 0 }],
        }),
      ]),
    )
  }
  if (opts.profiler) children.push(r.outline('Prediction Profiler', [r.plot({ kind: 'profiler', model: modelSpec(inputs.yname, design, fit) })]))
  children.push(missingNote(inputs))
  return children
}

function minOf(values: number[]): number {
  let m = Infinity
  for (const v of values) if (v < m) m = v
  return m
}

function maxOf(values: number[]): number {
  let m = -Infinity
  for (const v of values) if (v > m) m = v
  return m
}

function singularityText(design: Design, fit: OLSFit): string {
  const parts: string[] = []
  for (const [col, combo] of fit.zeroed) {
    const rhs = combo.map(([k, b]) => (k ? `${r.fmtNum(b, 4)}*${termLabel(design, k)}` : r.fmtNum(b, 4))).join(' + ') || '0'
    parts.push(`${termLabel(design, col)} = ${rhs}`)
  }
  return `Singularity details (these terms are zeroed): ${parts.join('; ')}`
}

function standardErrors(fit: OLSFit): number[] {
  return fit.kept.map((_, i) => (fit.dfe > 0 ? Math.sqrt(Math.max(fit.cov[i][i], 0)) : NaN))
}

function parameterTable(design: Design, fit: OLSFit) {
  const se = standardErrors(fit)
  const biased = new Set([...fit.zeroed.values()].flatMap((combo) => combo.map(([k]) => k)))
  const rows: unknown[][] = []
  for (let col = 0; col < design.X.length; col++) {
    const label = termLabel(design, col)
    if (fit.zeroed.has(col)) {
      rows.push([`${label} (Zeroed)`, 0, null, null, null])
      continue
    }
    const i = fit.kept.indexOf(col)
    const b = fit.beta[i]
    const s = se[i]
    const t = s > 0 ? b / s : NaN
    rows.push([biased.has(col) ? `${label} (Biased)` : label, b, s, t, pT(t, fit.dfe)])
  }
  return r.table([['Term', 'text'], 'Estimate', 'Std Error', 't Ratio', ['Prob>|t|', 'pvalue']], rows)
}

function sortedEstimates(design: Design, fit: OLSFit) {
  if (fit.dfe <= 0) return r.outline('Sorted Parameter Estimates', [r.warning('No error degrees of freedom.')])
  const se = standardErrors(fit)
  const rows: [string, number, number, number, number | null][] = []
  fit.kept.forEach((col, i) => {
    if (col === 0) return
    const t = se[i] > 0 ? fit.beta[i] / se[i] : NaN
    rows.push([termLabel(design, col), fit.beta[i], se[i], t, pT(t, fit.dfe)])
  })
  const key = (row: (typeof rows)[number]) => (Number.isFinite(row[3]) ? -Math.abs(row[3]) : 0)
  rows.sort((a, b) => key(a) - key(b))
  return r.outline('Sorted Parameter Estimates', [r.table([['Term', 'text'], 'Estimate', 'Std Error', 't Ratio', ['Prob>|t|', 'pvalue']], rows)])
}

function effectTests(design: Design, y: number[], fit: OLSFit) {
  const rows = design.effectNames.map((name, e) => {
    const cols = effectColumns(design, e)
    const df = cols.filter((c) => fit.kept.includes(c)).length
    if (df === 0) return [name, cols.length, 0, null, null, null]
    const [sseReduced] = sseWithout(fit, design.X, y, cols)
    const ss = Math.max(sseReduced - fit.sse, 0)
    const f = fit.dfe > 0 && fit.mse > 0 ? ss / df / fit.mse : NaN
    return [name, cols.length, df, ss, f, pF(f, df, fit.dfe)]
  })
  return r.outline('Effect Tests', [
    r.table([['Source', 'text'], ['Nparm', 'integer'], ['DF', 'integer'], 'Sum of Squares', 'F Ratio', ['Prob > F', 'pvalue']], rows),
  ])
}

/** Pure error from replicated factor settings; null when nothing is replicated. */
function lackOfFit(design: Design, y: number[], fit: OLSFit, sst: number): Maybe<ReportNode> {
  const groups = new Map<string, number[]>()
  y.forEach((_, i) => {
    const key = JSON.stringify([...design.factors.values()].map((f) => (f.categorical ? f.labels[i] : f.numbers[i] === 0 ? 0 : f.numbers[i])))
    const list = groups.get(key)
    if (list) list.push(i)
    else groups.set(key, [i])
  })
  const dfPe = y.length - groups.size
  if (dfPe <= 0) return null
  let ssPe = 0
  for (const idx of groups.values()) ssPe += squaredDeviations(idx.map((i) => y[i]))
  const dfLof = fit.dfe - dfPe
  const ssLof = Math.max(fit.sse - ssPe, 0)
  const msPe = ssPe / dfPe
  const msLof = dfLof > 0 ? ssLof / dfLof : null
  const f = msLof !== null && msPe > 0 ? msLof / msPe : NaN
  return r.outline('Lack Of Fit', [
    r.table(
      [['Source', 'text'], ['DF', 'integer'], 'Sum of Squares', 'Mean Square', 'F Ratio', ['Prob > F', 'pvalue']],
      [
        ['Lack Of Fit', dfLof, ssLof, msLof, f, pF(f, dfLof, dfPe)],
        ['Pure Error', dfPe, ssPe, msPe, null, null],
        ['Total Error', fit.dfe, fit.sse, null, null, null],
      ],
    ),
    r.summary([['Max RSq', sst > 0 ? 1 - ssPe / sst : null]]),
  ])
}

/** LS means for categorical main effects: other factors at their means, codes averaged. */
function lsMeans(design: Design, y: number[], fit: OLSFit): ReportNode[] {
  const out: ReportNode[] = []
  for (const effect of design.effects) {
    if (effect.length !== 1 || !design.factors.get(effect[0])!.categorical) continue
    const f = design.factors.get(effect[0])!
    const last = f.levels[f.levels.length - 1]
    const rows = f.levels.map((level) => {
      const x = new Array<number>(design.X.length).fill(1)
      design.terms.forEach((t, j) => {
        let v = 1
        for (const p of t.parts) {
          const pf = design.factors.get(p.factor)!
          if (pf.categorical) {
            // Effect codes average to zero over the levels of other factors.
            if (p.factor !== f.name) v = 0
            else v *= level === p.level ? 1 : level === last ? -1 : 0
          } else v *= (pf.mean - p.center) ** p.power
        }
        x[j + 1] = v
      })
      const xk = fit.kept.map((c) => x[c])
      const lsMean = xk.reduce((s, v, i) => s + v * fit.beta[i], 0)
      let se: number | null = null
      if (fit.dfe > 0) {
        let q = 0
        xk.forEach((a, i) => xk.forEach((b, k) => (q += a * fit.cov[i][k] * b)))
        se = Math.sqrt(Math.max(q, 0))
      }
      const raw = f.labels.flatMap((lab, i) => (lab === level ? [y[i]] : []))
      return [level, lsMean, se, raw.length ? mean(raw) : null]
    })
    out.push(r.outline(`Least Squares Means: ${f.name}`, [r.table([['Level', 'text'], 'Least Sq Mean', 'Std Error', 'Mean'], rows)]))
  }
  return out
}

/** The fitted model in the form the frontend profiler and Save Columns evaluate. */
function modelSpec(yname: string, design: Design, fit: OLSFit): LinearModelSpec {
  return {
    response: yname,
    factors: [...design.factors.values()].map(factorSpec),
    terms: fit.kept.map((c) => ({ label: termLabel(design, c), parts: c === 0 ? [] : design.terms[c - 1].parts })),
    coef: fit.beta,
    cov: fit.cov.map((row) => row.map((v) => (Number.isNaN(v) ? 0 : v))),
    df_error: Math.max(fit.dfe, 0),
    rmse: fit.dfe > 0 ? Math.sqrt(fit.mse) : 0,
  }
}

// ------------------------------------------------------------------------- stepwise

/** True when `inner` is a proper sub-multiset of `outer` (e.g. x in x*x, x in x*g). */
function contains(outer: string[], inner: string[]): boolean {
  if (inner.length >= outer.length) return false
  const rest = [...outer]
  for (const name of inner) {
    const i = rest.indexOf(name)
    if (i < 0) return false
    rest.splice(i, 1)
  }
  return true
}

/** AICc for a least squares fit with k mean parameters (plus the error variance). */
function aicc(sse: number, n: number, k: number): number | null {
  const kk = k + 1
  if (sse <= 0 || n - kk - 1 <= 0) return null
  const neg2ll = n * Math.log((2 * Math.PI * sse) / n) + n
  return neg2ll + 2 * kk + (2 * kk * (kk + 1)) / (n - kk - 1)
}

function stepwiseFit(inputs: Inputs, opts: Options, items: OptionItem[], params: Record<string, unknown>, center: boolean): AnalysisResult {
  const title = `Stepwise Fit for ${inputs.yname}`
  let direction = (params.direction ?? 'mixed') as string
  if (!['forward', 'backward', 'mixed'].includes(direction)) direction = 'mixed'
  const pEnter = Number(params.p_enter ?? 0.25)
  const pLeave = Number(params.p_leave ?? 0.1)
  const settings = r.summary([
    ['Direction', direction[0].toUpperCase() + direction.slice(1).toLowerCase(), 'text'],
    ['Prob to Enter', pEnter],
    ['Prob to Leave', pLeave],
  ])
  const done = (children: Maybe<ReportNode>[]): AnalysisResult => ({
    analysis: 'fit_model_stepwise',
    title,
    options: items,
    nodes: [r.outline(title, children)],
  })

  const problem = degenerate(inputs, inputs.effects)
  if (problem) return done([settings, r.warning(problem), missingNote(inputs)])

  const design = buildDesign(inputs.factors, inputs.effects, center, inputs.used.length)
  const X = design.X
  const y = inputs.yNumbers
  const n = y.length
  const sst = squaredDeviations(y)
  const effects = design.effects
  const E = effects.length
  const ascending = (s: Set<number>) => [...s].sort((a, b) => a - b)

  const colsFor = (selected: Set<number>) => [0, ...ascending(selected).flatMap((e) => effectColumns(design, e))]
  const cache = new Map<string, [number, number]>()
  const fitStats = (selected: Set<number>): [number, number] => {
    const key = ascending(selected).join(',')
    let hit = cache.get(key)
    if (!hit) cache.set(key, (hit = sseOf(X, y, colsFor(selected))))
    return hit
  }
  const all = new Set(effects.map((_, e) => e))
  const [fullSse, fullP] = fitStats(all)
  const fullMse = n - fullP > 0 ? fullSse / (n - fullP) : NaN

  /** p-value, SS, DF and F ratio for the effects in `big` but not `small`. */
  const partialTest = (small: Set<number>, big: Set<number>): [number | null, number, number, number | null] => {
    const [sse0, p0] = fitStats(small)
    const [sse1, p1] = fitStats(big)
    const df = p1 - p0
    const dfe = n - p1
    if (df <= 0 || dfe <= 0) return [null, 0, df, null]
    const ss = Math.max(sse0 - sse1, 0)
    if (sse1 <= 0) return [0, ss, df, null]
    const f = ss / df / (sse1 / dfe)
    return [fDist.sf(f, df, dfe), ss, df, f]
  }
  const without = (s: Set<number>, e: number) => new Set([...s].filter((x) => x !== e))
  const entryTest = (selected: Set<number>, e: number) => partialTest(selected, new Set([...selected, e]))
  const removalTest = (selected: Set<number>, e: number) => partialTest(without(selected, e), selected)
  const canEnter = (selected: Set<number>, e: number) => effects.every((inner, i) => !contains(effects[e], inner) || selected.has(i))
  const canLeave = (selected: Set<number>, e: number) => ![...selected].some((i) => contains(effects[i], effects[e]))

  const stepRow = (step: number, e: number, action: string, p: number | null, ss: number, selected: Set<number>) => {
    const [sse, k] = fitStats(selected)
    const cp = Number.isFinite(fullMse) && fullMse > 0 ? sse / fullMse - n + 2 * k : null
    return [step, design.effectNames[e], action, p, ss, sst > 0 ? 1 - sse / sst : null, cp, k, aicc(sse, n, k)]
  }

  let selected = direction === 'backward' ? new Set(all) : new Set<number>()
  const history: unknown[][] = []
  // In mixed mode an effect that is removed after entering may not enter again, so the
  // search cannot cycle between Prob to Enter and Prob to Leave.
  const dropped = new Set<number>()
  for (let iteration = 0; iteration < 2 * E + 1; iteration++) {
    let moved = false
    if (direction === 'forward' || direction === 'mixed') {
      let best: [number, number, number] | null = null
      for (let e = 0; e < E; e++) {
        if (selected.has(e) || dropped.has(e) || !canEnter(selected, e)) continue
        const [p, ss] = entryTest(selected, e)
        if (p !== null && (best === null || p < best[1])) best = [e, p, ss]
      }
      if (best && best[1] < pEnter) {
        selected = new Set([...selected, best[0]])
        history.push(stepRow(history.length + 1, best[0], 'Entered', best[1], best[2], selected))
        moved = true
      }
    }
    if (direction === 'backward' || direction === 'mixed') {
      let worst: [number, number, number] | null = null
      for (const e of ascending(selected)) {
        if (!canLeave(selected, e)) continue
        const [p, ss] = removalTest(selected, e)
        if (p !== null && (worst === null || p > worst[1])) worst = [e, p, ss]
      }
      if (worst && worst[1] > pLeave) {
        selected = without(selected, worst[0])
        dropped.add(worst[0])
        history.push(stepRow(history.length + 1, worst[0], 'Removed', worst[1], worst[2], selected))
        moved = true
      }
    }
    if (!moved) break
  }

  const final = ols(X, y, colsFor(selected))
  const current: unknown[][] = [['Intercept', 'Yes', estimate(final, 0), 1, null, null, null]]
  for (let e = 0; e < E; e++) {
    const cols = effectColumns(design, e)
    const entered = selected.has(e)
    const [p, ss, , f] = entered ? removalTest(selected, e) : entryTest(selected, e)
    const est = entered && cols.length === 1 ? estimate(final, cols[0]) : null
    current.push([design.effectNames[e], entered ? 'Yes' : 'No', est, cols.length, ss, f, p])
  }

  const children: Maybe<ReportNode>[] = [
    settings,
    r.outline('Current Estimates', [
      r.table([['Parameter', 'text'], ['Entered', 'text'], 'Estimate', ['nDF', 'integer'], 'SS', 'F Ratio', ['Prob>F', 'pvalue']], current),
    ]),
    r.outline('Step History', [
      history.length
        ? r.table(
            [['Step', 'integer'], ['Parameter', 'text'], ['Action', 'text'], ['Sig Prob', 'pvalue'], 'Seq SS', 'RSquare', 'Cp', ['p', 'integer'], 'AICc'],
            history,
          )
        : r.text('No effect met the entry or removal criteria.'),
    ]),
  ]
  const finalEffects = ascending(selected).map((e) => effects[e])
  if (finalEffects.length) {
    children.push(r.outline(`Response ${inputs.yname} (final model)`, leastSquaresReport(inputs, finalEffects, opts, center)))
  } else children.push(r.warning('No effects entered the model.'))
  return done(children)
}

// ------------------------------------------------------------------------- logistic

interface LogitFit {
  negLlf: number
  nParams: number
  /** [title, rows of [term, estimate, std error]] parameter tables. */
  tables: [string, [string, number, number][]][]
  unstable: boolean
}

/** Fit binary, nominal or ordinal logistic regression on design rows X (column 0 = intercept). */
function fitLogit(X: Matrix, yIdx: number[], levels: string[], ordinal: boolean, labels: string[]): LogitFit {
  const L = levels.length
  let tables: LogitFit['tables']
  let k: number
  let llf: number
  let warned: boolean
  if (L === 2) {
    const res = logit(
      yIdx.map((v) => (v === 0 ? 1 : 0)),
      X,
      { maxiter: 300 },
    )
    tables = [[`For log odds of ${levels[0]}/${levels[1]}`, labels.map((l, i): [string, number, number] => [l, res.params[i], res.bse[i]])]]
    k = X[0].length
    llf = res.llf
    warned = res.perfectPrediction || !res.converged
  } else if (ordinal) {
    const m = X[0].length - 1
    const res = orderedLogit(
      yIdx,
      X.map((row) => row.slice(1)),
      { maxiter: 2000 },
    )
    // statsmodels' cov_params() raises when the Hessian could not be inverted.
    if (!res.cov) throw new Error('need covariance of parameters for computing (unnormalized) covariances')
    const cov = res.cov
    const p = res.params
    // Thresholds θ_k = p[m] + Σ_{i≤k} exp(p[m+i]): delta-method standard errors.
    const jac = Array.from({ length: L - 1 }, (_, kk) =>
      p.map((_, j) => (j === m ? 1 : j > m && j - m <= kk ? Math.exp(p[j]) : 0)),
    )
    const thrSe = jac.map((g) => Math.sqrt(Math.max(g.reduce((s, gi, i) => s + gi * g.reduce((t2, gj, j) => t2 + cov[i][j] * gj, 0), 0), 0)))
    const rows: [string, number, number][] = levels.slice(0, -1).map((level, kk) => [`Intercept[${level}]`, res.thresholds[kk], thrSe[kk]])
    // JMP: logit P(Y <= k) = a_k + X b, so slopes flip sign relative to statsmodels.
    for (let j = 0; j < m; j++) rows.push([labels[j + 1], -p[j], Math.sqrt(Math.max(cov[j][j], 0))])
    tables = [['Cumulative logit: log odds of P(Y <= level)', rows]]
    k = L - 1 + m
    llf = res.llf
    warned = !res.converged
  } else {
    const codes = yIdx.map((v) => (v === L - 1 ? 0 : v + 1)) // statsmodels' reference is code 0
    const res = mnlogit(codes, X, { maxiter: 300 })
    tables = levels.slice(0, -1).map((level, c) => [
      `For log odds of ${level}/${levels[L - 1]}`,
      labels.map((l, i): [string, number, number] => [l, res.params[i][c], res.bse[i][c]]),
    ])
    k = X[0].length * (L - 1)
    llf = res.llf
    warned = !res.converged
  }
  const rows = tables.flatMap(([, rs]) => rs)
  const negLlf = -llf
  const unstable =
    warned ||
    negLlf < 1e-6 ||
    !rows.every(([, , se]) => Number.isFinite(se)) ||
    rows.some(([, est, se]) => se > 100 * (Math.abs(est) + 1))
  return { negLlf, nParams: k, tables, unstable }
}

function logisticFit(inputs: Inputs, yCol: AnalysisColumn, center: boolean): AnalysisResult {
  const levels = levelsOf(inputs.yLabels, yCol.levels)
  const L = levels.length
  const ordinal = yCol.modeling_type === 'ordinal' && L > 2
  const title = `${ordinal ? 'Ordinal' : 'Nominal'} Logistic Fit for ${inputs.yname}`
  const done = (children: Maybe<ReportNode>[]): AnalysisResult => {
    children.push(missingNote(inputs))
    return { analysis: 'fit_model_logistic', title, options: [], nodes: [r.outline(title, children)] }
  }

  const problem = degenerate(inputs, inputs.effects)
  if (problem) return done([r.warning(problem)])
  if (L < 2) return done([r.warning(`${inputs.yname} needs at least 2 levels with data for a logistic fit.`)])

  const design = buildDesign(inputs.factors, inputs.effects, center, inputs.used.length)
  const { kept, zeroed } = independentColumns(design.X, design.X.map((_, c) => c))
  const rowsOf = (cols: number[]): Matrix => inputs.used.map((_, i) => cols.map((c) => design.X[c][i]))
  const X = rowsOf(kept)
  const n = X.length
  const index = new Map(levels.map((lev, i) => [lev, i]))
  const yIdx = inputs.yLabels.map((v) => index.get(v)!)
  const termLabels = kept.map((c) => termLabel(design, c))

  const children: Maybe<ReportNode>[] = []
  if (zeroed.size) children.push(r.warning(`Linearly dependent terms were dropped: ${[...zeroed.keys()].map((c) => termLabel(design, c)).join(', ')}`))
  if (n <= kept.length) return done([...children, r.warning('There are not enough rows to fit this logistic model.')])
  let fit: LogitFit
  try {
    fit = fitLogit(X, yIdx, levels, ordinal, termLabels)
  } catch (e) {
    return done([...children, r.warning(`The logistic model could not be fit: ${(e as Error).message}`)])
  }

  const counts = levels.map((_, i) => yIdx.filter((v) => v === i).length).filter((c) => c > 0)
  const reduced = -sum(counts.map((c) => c * Math.log(c / n)))
  const full = fit.negLlf
  const diff = reduced - full
  const df = fit.nParams - (L - 1)
  const chisq = 2 * diff
  const k = fit.nParams
  const aiccValue = 2 * full + 2 * k + (n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : NaN)
  const bic = 2 * full + k * Math.log(n)

  if (fit.unstable) {
    children.push(r.warning('Unstable fit: the model did not converge cleanly (possibly quasi-complete separation). Estimates may be unreliable.'))
  }
  children.push(
    r.outline('Whole Model Test', [
      r.table(
        [['Model', 'text'], '-LogLikelihood', ['DF', 'integer'], 'ChiSquare', ['Prob>ChiSq', 'pvalue']],
        [
          ['Difference', diff, df, chisq, df > 0 ? chi2.sf(chisq, df) : null],
          ['Full', full, null, null, null],
          ['Reduced', reduced, null, null, null],
        ],
      ),
      r.summary([
        ['RSquare (U)', reduced > 0 ? diff / reduced : null],
        ['AICc', aiccValue],
        ['BIC', bic],
        ['Observations (or Sum Wgts)', n, 'integer'],
      ]),
    ]),
  )
  const tables = fit.tables.map(([tableTitle, rows]) =>
    r.table(
      [['Term', 'text'], 'Estimate', 'Std Error', 'ChiSquare', ['Prob>ChiSq', 'pvalue']],
      rows.map(([term, est, se]) => {
        const wald = se && Number.isFinite(se) && se > 0 ? (est / se) ** 2 : NaN
        return [term, est, se, wald, Number.isFinite(wald) ? chi2.sf(wald, 1) : null]
      }),
      tableTitle,
    ),
  )
  children.push(r.outline('Parameter Estimates', tables))

  const lrRows = design.effectNames.map((name, e) => {
    const all = effectColumns(design, e)
    const cols = all.filter((c) => kept.includes(c))
    if (!cols.length) return [name, all.length, 0, null, null]
    const sub = kept.filter((c) => !cols.includes(c))
    try {
      const reducedFit = fitLogit(rowsOf(sub), yIdx, levels, ordinal, sub.map((c) => termLabel(design, c)))
      const lr = Math.max(2 * (reducedFit.negLlf - full), 0)
      const ddf = fit.nParams - reducedFit.nParams
      return [name, all.length, ddf, lr, ddf > 0 ? chi2.sf(lr, ddf) : null]
    } catch {
      return [name, all.length, null, null, null]
    }
  })
  children.push(
    r.outline('Effect Likelihood Ratio Tests', [
      r.table([['Source', 'text'], ['Nparm', 'integer'], ['DF', 'integer'], 'L-R ChiSquare', ['Prob>ChiSq', 'pvalue']], lrRows),
    ]),
  )
  return done(children)
}
