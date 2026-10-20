// Process capability: Cp, Cpk, Pp, Ppk and nonconformance against spec limits
// (port of backend/app/analyses/capability.py).
//
// Inputs: a continuous Y; params lsl / target / usl (at least one limit); optional
// roles.subgroup. The within-subgroup sigma is the pooled subgroup standard deviation when
// subgroups are given, otherwise the average moving range / d2(2) in row order. The
// overall sigma is the sample standard deviation.

import type { AnalysisResult, HistogramPlot, ReferenceLine, ReportNode } from '../../api/types'
import { labelValues, numericValues } from '../common'
import { chi2, norm } from '../math/distributions'
import { mean as npMean, std } from '../math/stats'
import * as r from '../report'
import { niceBins } from './distribution'
import type { Request } from './index'
import { makeSubgroups, movingRangeSigma, paramFloat, pooledSigma } from './spc'

const Z975 = norm.ppf(0.975)

export function analyze(req: Request): AnalysisResult {
  const y = req.y
  const title = `Process Capability of ${y.name}`
  const [lsl, target, usl] = (['lsl', 'target', 'usl'] as const).map((k) => paramFloat(req.params, k))
  const raw = numericValues(y)
  const values = raw.filter(Number.isFinite)

  const children: ReportNode[] = []
  if (y.modeling_type !== 'continuous') {
    children.push(r.warning('Process capability needs a continuous column.'))
    return result(title, children)
  }

  const subgroup = req.roles.subgroup?.[0]
  let within: number
  let method: string
  if (subgroup) {
    const groups = makeSubgroups(raw, labelValues(subgroup))
    within = pooledSigma(groups.map((g) => g.values))
    method = `Within sigma: pooled standard deviation of ${groups.length} subgroups of ${subgroup.name}.`
  } else {
    within = movingRangeSigma(raw)
    method = 'Within sigma: average moving range / d2(2), in row order.'
  }

  children.push(...capabilityNodes(y.name, values, lsl, target, usl, within, method, raw.length - values.length))
  return result(title, children)
}

function result(title: string, children: ReportNode[]): AnalysisResult {
  return { analysis: 'capability', title, options: [], nodes: [r.outline(title, children)] }
}

/** Histogram with spec limits, capability indices, sigma summary and nonconformance. */
export function capabilityNodes(
  name: string,
  values: number[],
  lsl: number | null,
  target: number | null,
  usl: number | null,
  withinSigma: number,
  withinMethod: string,
  nMissing = 0,
): ReportNode[] {
  const nodes: ReportNode[] = []
  const n = values.length
  if (lsl === null && usl === null) nodes.push(r.warning('Enter at least one specification limit (LSL or USL) to compute capability.'))
  let lslOk = lsl
  let uslOk = usl
  if (lsl !== null && usl !== null && lsl >= usl) {
    nodes.push(r.warning('The lower spec limit must be below the upper spec limit.'))
    lslOk = null
    uslOk = null
  }
  if (n === 0) {
    nodes.push(r.warning('No nonmissing values; nothing to analyze.'))
    return nodes
  }
  if (n < 2) nodes.push(r.warning('Capability needs at least two values.'))

  const mean = npMean(values)
  const overall = n > 1 ? std(values, 1) : NaN
  const within = Number.isFinite(withinSigma) ? withinSigma : NaN
  if (n > 1 && overall === 0) nodes.push(r.warning('All values are identical; capability indices are undefined.'))

  const refs: ReferenceLine[] = (
    [
      ['LSL', lsl],
      ['Target', target],
      ['USL', usl],
    ] as const
  ).flatMap(([label, value]) => (value === null ? [] : [{ label, value }]))
  const histogram: HistogramPlot = {
    kind: 'histogram',
    column: name,
    bins: niceBins(values),
    box: null,
    mean_ci: null,
    normal: n > 1 && overall > 0 ? { mu: mean, sigma: overall } : null,
    reference_lines: refs,
  }
  nodes.push(r.plot(histogram))

  const haveLimits = lslOk !== null || uslOk !== null
  if (haveLimits) {
    const withinRows = indexRows('C', mean, within, lslOk, uslOk, n)
    const overallRows = indexRows('P', mean, overall, lslOk, uslOk, n)
    const cpm = taguchi(mean, overall, lslOk, target, uslOk)
    if (cpm !== null) overallRows.push(['Cpm', cpm, null, null])
    const columns: (string | [string, 'text'])[] = [['Index', 'text'], 'Estimate', 'Lower 95%', 'Upper 95%']
    nodes.push(
      r.outline('Capability Indices', [
        r.row(r.table(columns, withinRows, 'Within Sigma'), r.table(columns, overallRows, 'Overall Sigma')),
        r.text("Confidence intervals: chi-square for Cp and Pp, Bissell's approximation for the others."),
      ]),
    )
  }

  const summary: ([string, unknown] | [string, unknown, 'integer'])[] = [
    ['Mean', mean],
    ['Within Sigma', within],
    ['Overall Sigma', overall],
    ['Stability Index', within > 0 ? overall / within : null],
    ['N', n, 'integer'],
  ]
  if (nMissing) summary.push(['N Missing', nMissing, 'integer'])
  for (const ref of refs) summary.push([ref.label, ref.value])
  nodes.push(r.outline('Sigma', [r.summary(summary), r.text(withinMethod)]))

  if (haveLimits) nodes.push(r.outline('Nonconformance', [nonconformance(values, mean, within, overall, lslOk, uslOk)]))
  return nodes
}

interface Indices {
  p: number | null
  pk: number | null
  pl: number | null
  pu: number | null
}

/** Cp, Cpk, Cpl and Cpu (or the P versions, given the overall sigma); null when undefined. */
export function capabilityIndices(mean: number, sigma: number, lsl: number | null, usl: number | null): Indices {
  const ok = Number.isFinite(sigma) && sigma > 0
  const cp = ok && lsl !== null && usl !== null ? (usl - lsl) / (6 * sigma) : null
  const cpl = ok && lsl !== null ? (mean - lsl) / (3 * sigma) : null
  const cpu = ok && usl !== null ? (usl - mean) / (3 * sigma) : null
  const sides = [cpl, cpu].filter((v): v is number => v !== null)
  return { p: cp, pk: sides.length ? Math.min(...sides) : null, pl: cpl, pu: cpu }
}

function indexRows(prefix: string, mean: number, sigma: number, lsl: number | null, usl: number | null, n: number): unknown[][] {
  const ix = capabilityIndices(mean, sigma, lsl, usl)
  return (['p', 'pk', 'pl', 'pu'] as const).map((key) => {
    const value = ix[key]
    const [lo, hi] = key === 'p' ? cpCi(value, n) : cpkCi(value, n)
    return [`${prefix}${key}`, value, lo, hi]
  })
}

function cpCi(cp: number | null, n: number): [number | null, number | null] {
  if (cp === null || n < 2) return [null, null]
  const df = n - 1
  return [cp * Math.sqrt(chi2.ppf(0.025, df) / df), cp * Math.sqrt(chi2.ppf(0.975, df) / df)]
}

/** Bissell's normal approximation. */
function cpkCi(cpk: number | null, n: number): [number | null, number | null] {
  if (cpk === null || n < 2) return [null, null]
  const half = Z975 * Math.sqrt(1 / (9 * n) + cpk ** 2 / (2 * (n - 1)))
  return [cpk - half, cpk + half]
}

/** Taguchi index: distance from target to the nearer limit over 3 * sqrt(sigma^2 + (mean - target)^2). */
function taguchi(mean: number, sigma: number, lsl: number | null, target: number | null, usl: number | null): number | null {
  if (target === null || !Number.isFinite(sigma) || (lsl === null && usl === null)) return null
  const tau = Math.sqrt(sigma ** 2 + (mean - target) ** 2)
  if (tau === 0) return null
  const gaps = [lsl !== null ? target - lsl : null, usl !== null ? usl - target : null].filter((g): g is number => g !== null)
  return Math.min(...gaps) / (3 * tau)
}

function nonconformance(values: number[], mean: number, within: number, overall: number, lsl: number | null, usl: number | null) {
  const expected = (sigma: number, below: boolean): number | null => {
    const limit = below ? lsl : usl
    if (limit === null || !Number.isFinite(sigma) || sigma <= 0) return null
    const z = (limit - mean) / sigma
    return below ? norm.cdf(z) : norm.sf(z)
  }
  const n = values.length
  const belowObs = lsl !== null ? values.filter((v) => v < lsl).length / n : null
  const aboveObs = usl !== null ? values.filter((v) => v > usl).length / n : null
  const total = (a: number | null, b: number | null): number | null => {
    const parts = [a, b].filter((p): p is number => p !== null)
    return parts.length ? parts.reduce((s, p) => s + p, 0) : null
  }
  const below = [belowObs, expected(within, true), expected(overall, true)]
  const above = [aboveObs, expected(within, false), expected(overall, false)]
  const rows: unknown[][] = []
  if (lsl !== null) rows.push(['Below LSL', ...below])
  if (usl !== null) rows.push(['Above USL', ...above])
  rows.push(['Total Outside', ...below.map((b, i) => total(b, above[i]))])
  return r.table([['Portion', 'text'], ['Observed %', 'percent'], ['Expected Within %', 'percent'], ['Expected Overall %', 'percent']], rows)
}
