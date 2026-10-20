// Control charts: I-MR, Xbar-R, Xbar-S, P, NP, C and U, with Nelson tests
// (port of backend/app/analyses/control_chart.py).
//
// Values are in table row order. Subgroups come from roles.subgroup (rows sharing a label,
// in order of first appearance; for I-MR it only labels the points) or params.subgroup_size
// (consecutive non-missing values; Xbar charts default to 5). Attribute charts take counts
// per row with sample sizes from roles.sample_size or params.sample_size; P and NP charts
// also accept a categorical Y (one unit per row, nonconforming when its level equals
// params.defect_level, default the first level). Spec limits on a variables chart add a
// capability section using the chart's within-subgroup sigma.

import type { AnalysisColumn, AnalysisResult, ControlChartPlot, ReportNode } from '../../api/types'
import { labelValues, levelsOf, numericValues } from '../common'
import { mean, std, sum } from '../math/stats'
import * as r from '../report'
import { capabilityNodes } from './capability'
import type { Request } from './index'
import { c4, d2, d3, makeSubgroups, paramFloat, paramInt } from './spc'

const OPTIONS: [string, string, boolean][] = [
  ['test_beyond_limits', 'Test Beyond Limits', true],
  ['nelson_tests', 'Nelson Tests 2–8', false],
  ['show_zones', 'Show Zones', false],
]

const CHART_NAMES: Record<string, string> = {
  imr: 'Individual & Moving Range',
  xbar_r: 'XBar & R',
  xbar_s: 'XBar & S',
  p: 'P',
  np: 'NP',
  c: 'C',
  u: 'U',
}

const TEST_DESCRIPTIONS: Record<number, string> = {
  1: 'One point beyond Zone A (outside the control limits)',
  2: 'Nine points in a row on one side of the center line',
  3: 'Six points in a row steadily increasing or decreasing',
  4: 'Fourteen points in a row alternating up and down',
  5: 'Two out of three points in a row in Zone A or beyond, on one side',
  6: 'Four out of five points in a row in Zone B or beyond, on one side',
  7: 'Fifteen points in a row in Zone C (within one sigma)',
  8: 'Eight points in a row on both sides of center with none in Zone C',
}

interface Point {
  label: string
  value: number | null
  center: number | null
  lcl: number | null
  ucl: number | null
  /** Standard deviation of the plotted statistic at this point. */
  sigma: number | null
  indices: number[]
  tests: number[]
}

interface Chart {
  title: string
  /** Short name for tables, e.g. "Individual". */
  name: string
  yLabel: string
  points: Point[]
  /** Nelson tests 2-8 and zones apply to location charts only. */
  location: boolean
  processSigma: number | null
  subgroupSize: number | null
}

/** The data can't support the requested chart; the message becomes a warning. */
class ChartError extends Error {}

const point = (label: string, value: number | null, center: number | null, lcl: number | null, ucl: number | null, sigma: number | null, indices: number[]): Point => ({
  label,
  value,
  center,
  lcl,
  ucl,
  sigma,
  indices,
  tests: [],
})

export function analyze(req: Request): AnalysisResult {
  const [opts, items] = r.resolveOptions(OPTIONS, req.options)
  const chartType = String(req.params.chart_type || 'imr')
  const y = req.y
  const name = Object.hasOwn(CHART_NAMES, chartType) ? CHART_NAMES[chartType] : undefined
  const title = name ? `${name} Chart of ${y.name}` : `Control Chart of ${y.name}`

  const children: ReportNode[] = []
  let charts: Chart[] = []
  let within: number | null = null
  let method = ''
  try {
    if (!name) throw new ChartError(`Unknown chart type '${chartType}'.`)
    let notes: string[]
    if (chartType === 'imr' || chartType === 'xbar_r' || chartType === 'xbar_s') ({ charts, within, method, notes } = variablesCharts(req, chartType))
    else ({ charts, notes } = attributeCharts(req, chartType))
    children.push(...notes.map((n) => r.warning(n)))
  } catch (e) {
    if (!(e instanceof ChartError)) throw e
    children.push(r.warning(e.message))
  }

  const failures: unknown[][] = []
  for (const chart of charts) {
    runTests(chart, opts.test_beyond_limits, opts.nelson_tests)
    const plot: ControlChartPlot = {
      kind: 'control_chart',
      title: chart.title,
      y_label: chart.yLabel,
      x_label: xLabel(req, chartType),
      points: chart.points.map((p) => ({ label: p.label, value: p.value, center: p.center, lcl: p.lcl, ucl: p.ucl, indices: p.indices, tests: p.tests })),
      show_zones: opts.show_zones && chart.location,
    }
    children.push(r.outline(chart.title, [r.plot(plot)]))
    chart.points.forEach((p, k) => {
      for (const t of p.tests) failures.push([chart.name, k + 1, p.label, t, TEST_DESCRIPTIONS[t]])
    })
  }

  if (charts.length) children.push(limitSummaries(charts))
  if (failures.length) {
    children.push(
      r.outline('Test Failures', [r.table([['Chart', 'text'], ['Point', 'integer'], ['Label', 'text'], ['Test', 'integer'], ['Description', 'text']], failures)]),
    )
  }

  const [lsl, target, usl] = (['lsl', 'target', 'usl'] as const).map((k) => paramFloat(req.params, k))
  if (charts.length && (lsl !== null || usl !== null)) {
    if (within === null) children.push(r.warning('Spec limits apply to variables charts (I-MR, XBar-R, XBar-S) only.'))
    else {
      const raw = numericValues(y)
      const values = raw.filter(Number.isFinite)
      children.push(r.outline(`Process Capability of ${y.name}`, capabilityNodes(y.name, values, lsl, target, usl, within, method, raw.length - values.length)))
    }
  }

  return { analysis: 'control_chart', title, options: items, nodes: [r.outline(title, children)] }
}

function xLabel(req: Request, chartType: string): string {
  const subgroup = req.roles.subgroup?.[0]
  if (subgroup) return subgroup.name
  const grouped = chartType === 'xbar_r' || chartType === 'xbar_s' || ((chartType === 'p' || chartType === 'np') && req.y.modeling_type !== 'continuous')
  return grouped ? 'Subgroup' : 'Sample'
}

/** numpy's ptp: max - min. */
function range(values: number[]): number {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

// -------------------------------------------------------------------- variables

function variablesCharts(req: Request, chartType: string): { charts: Chart[]; within: number; method: string; notes: string[] } {
  const y = req.y
  if (y.modeling_type !== 'continuous') throw new ChartError(`${CHART_NAMES[chartType]} charts need a continuous Y column.`)
  const raw = numericValues(y)
  const subgroup = req.roles.subgroup?.[0]
  const labels = subgroup ? labelValues(subgroup) : null
  const notes: string[] = []
  if (!raw.some(Number.isFinite)) throw new ChartError('No nonmissing values; nothing to chart.')

  if (chartType === 'imr') {
    const { charts, sigma, method } = imr(y.name, raw, labels)
    if (sigma === 0) notes.push('There is no variation between consecutive values; the control limits collapse onto the center line.')
    return { charts, within: sigma, method, notes }
  }

  const size = labels !== null ? null : paramInt(req.params, 'subgroup_size') || 5
  const groups = makeSubgroups(raw, labels, size)
  const sizes = groups.map((g) => g.values.length)
  const usable = groups.filter((g) => g.values.length >= 2)
  if (!usable.length) throw new ChartError('Subgroups need at least two values each to estimate the process sigma.')
  if (usable.length < groups.length) notes.push(`${groups.length - usable.length} subgroup(s) with a single value have no range or standard deviation.`)

  let sigma: number
  let method: string
  if (chartType === 'xbar_r') {
    sigma = mean(usable.map((g) => range(g.values) / d2(g.values.length)))
    method = 'Within sigma: average of subgroup range / d2.'
  } else {
    sigma = mean(usable.map((g) => std(g.values, 1) / c4(g.values.length)))
    method = 'Within sigma: average of subgroup standard deviation / c4.'
  }
  if (sigma === 0) notes.push('There is no variation within subgroups; the control limits collapse onto the center line.')
  const grand = mean(groups.flatMap((g) => g.values))
  const constant = new Set(sizes).size === 1

  const means: Point[] = []
  const spread: Point[] = []
  for (const g of groups) {
    const n = g.values.length
    const se = sigma / Math.sqrt(n)
    means.push(point(g.label, mean(g.values), grand, grand - 3 * se, grand + 3 * se, se, g.positions))
    if (n < 2) spread.push(point(g.label, null, null, null, null, null, g.positions))
    else if (chartType === 'xbar_r') {
      const center = d2(n) * sigma
      const sd = d3(n) * sigma
      spread.push(point(g.label, range(g.values), center, Math.max(0, center - 3 * sd), center + 3 * sd, sd, g.positions))
    } else {
      const cn = c4(n)
      const center = cn * sigma
      const sd = sigma * Math.sqrt(1 - cn * cn)
      spread.push(point(g.label, std(g.values, 1), center, Math.max(0, center - 3 * sd), center + 3 * sd, sd, g.positions))
    }
  }

  const sizeValue = constant ? sizes[0] : null
  const spreadName = chartType === 'xbar_r' ? 'R' : 'S'
  const charts: Chart[] = [
    { title: `XBar of ${y.name}`, name: 'XBar', yLabel: `Mean of ${y.name}`, points: means, location: true, processSigma: sigma, subgroupSize: sizeValue },
    {
      title: `${spreadName} of ${y.name}`,
      name: spreadName,
      yLabel: `${spreadName === 'R' ? 'Range' : 'Std Dev'} of ${y.name}`,
      points: spread,
      location: false,
      processSigma: sigma,
      subgroupSize: sizeValue,
    },
  ]
  return { charts, within: sigma, method, notes }
}

function imr(name: string, raw: number[], labels: (string | null)[] | null): { charts: Chart[]; sigma: number; method: string } {
  const positions = raw.flatMap((v, i) => (Number.isFinite(v) ? [i] : []))
  const values = positions.map((i) => raw[i])
  if (values.length < 2) throw new ChartError('An Individual & Moving Range chart needs at least two values.')
  const pointLabels = positions.map((i, k) => (labels !== null && labels[i] !== null ? labels[i]! : String(k + 1)))
  const mr = values.slice(1).map((v, k) => Math.abs(v - values[k]))
  const mrBar = mean(mr)
  const sigma = mrBar / d2(2)
  const center = mean(values)
  const individuals = values.map((v, k) => point(pointLabels[k], v, center, center - 3 * sigma, center + 3 * sigma, sigma, [positions[k]]))
  const mrSd = d3(2) * sigma
  const ranges = mr.map((m, k) => point(pointLabels[k + 1], m, mrBar, Math.max(0, mrBar - 3 * mrSd), mrBar + 3 * mrSd, mrSd, [positions[k + 1]]))
  const charts: Chart[] = [
    { title: `Individual Measurement of ${name}`, name: 'Individual', yLabel: name, points: individuals, location: true, processSigma: sigma, subgroupSize: 1 },
    { title: `Moving Range of ${name}`, name: 'Moving Range', yLabel: `Moving Range of ${name}`, points: ranges, location: false, processSigma: sigma, subgroupSize: 2 },
  ]
  return { charts, sigma, method: 'Within sigma: average moving range / d2(2).' }
}

// -------------------------------------------------------------------- attribute

interface CountGroup {
  label: string
  count: number
  size: number
  positions: number[]
}

function attributeCharts(req: Request, chartType: string): { charts: Chart[]; notes: string[] } {
  const y = req.y
  const subgroup = req.roles.subgroup?.[0]
  const labels = subgroup ? labelValues(subgroup) : null
  const notes: string[] = []
  const needsN = chartType === 'p' || chartType === 'np' || chartType === 'u'

  let groups: CountGroup[]
  if (y.modeling_type !== 'continuous') {
    if (chartType !== 'p' && chartType !== 'np') throw new ChartError(`${chartType.toUpperCase()} charts need counts in a numeric Y column.`)
    const { counts, sizes } = unitsFromLevels(y, req.params)
    const size = labels !== null ? null : paramInt(req.params, 'subgroup_size')
    if (labels === null && !size) throw new ChartError('A P or NP chart of a categorical column needs a subgroup column or a subgroup size.')
    groups = groupCounts(counts, sizes, labels, size)
  } else {
    const counts = numericValues(y)
    let sizes: number[]
    if (needsN) {
      const sampleColumn = req.roles.sample_size?.[0]
      if (sampleColumn) sizes = numericValues(sampleColumn)
      else {
        const constantN = paramFloat(req.params, 'sample_size')
        if (constantN === null || constantN <= 0) {
          throw new ChartError(`${chartType.toUpperCase()} charts need sample sizes: a Sample Size column or a constant sample size.`)
        }
        sizes = counts.map(() => constantN)
      }
    } else sizes = counts.map(() => 1)
    if (counts.some((c) => Number.isFinite(c) && c < 0)) notes.push('Some counts are negative.')
    groups = groupCounts(counts, sizes, labels, null)
  }

  groups = groups.filter((g) => g.size > 0)
  if (!groups.length) throw new ChartError('No usable counts; nothing to chart.')
  const c = groups.map((g) => g.count)
  const n = groups.map((g) => g.size)
  if ((chartType === 'p' || chartType === 'np') && c.some((ci, i) => ci > n[i])) notes.push('Some counts exceed their sample size.')
  const constant = n.every((ni) => ni === n[0])

  let points: Point[] = []
  let sigma: number | null
  let stat: string
  if (chartType === 'p' || chartType === 'np') {
    const pBar = sum(c) / sum(n)
    for (const g of groups) {
      const sdP = Math.sqrt((pBar * (1 - pBar)) / g.size)
      if (chartType === 'p') points.push(point(g.label, g.count / g.size, pBar, Math.max(0, pBar - 3 * sdP), Math.min(1, pBar + 3 * sdP), sdP, g.positions))
      else {
        const center = g.size * pBar
        const sd = g.size * sdP
        points.push(point(g.label, g.count, center, Math.max(0, center - 3 * sd), Math.min(g.size, center + 3 * sd), sd, g.positions))
      }
    }
    sigma = constant ? points[0].sigma : null
    stat = chartType === 'p' ? 'Proportion' : 'Count'
  } else if (chartType === 'c') {
    const cBar = mean(c)
    const sd = Math.sqrt(cBar)
    points = groups.map((g) => point(g.label, g.count, cBar, Math.max(0, cBar - 3 * sd), cBar + 3 * sd, sd, g.positions))
    sigma = sd
    stat = 'Count'
  } else {
    const uBar = sum(c) / sum(n)
    for (const g of groups) {
      const sd = Math.sqrt(uBar / g.size)
      points.push(point(g.label, g.count / g.size, uBar, Math.max(0, uBar - 3 * sd), uBar + 3 * sd, sd, g.positions))
    }
    sigma = constant ? points[0].sigma : null
    stat = 'Defects per Unit'
  }

  if (points.every((p) => p.sigma === 0)) notes.push('The center line is at a boundary (no defects or all defective); the limits have no width.')
  const short = chartType.toUpperCase()
  const chart: Chart = {
    title: `${short} of ${y.name}`,
    name: short,
    yLabel: `${stat} of ${y.name}`,
    points,
    location: true,
    processSigma: sigma,
    subgroupSize: constant && needsN ? n[0] : null,
  }
  return { charts: [chart], notes }
}

/** For a categorical Y: 1 for the nonconforming level, 0 otherwise, each row one unit. */
function unitsFromLevels(y: AnalysisColumn, params: Record<string, unknown>): { counts: number[]; sizes: number[] } {
  const labels = labelValues(y)
  const levels = levelsOf(labels, y.levels)
  if (!levels.length) throw new ChartError('No nonmissing values; nothing to chart.')
  const requested = params.defect_level
  const defect = typeof requested === 'string' && levels.includes(requested) ? requested : levels[0]
  return {
    counts: labels.map((l) => (l === null ? NaN : l === defect ? 1 : 0)),
    sizes: labels.map((l) => (l === null ? NaN : 1)),
  }
}

/** Total count and sample size per point, with the request positions it covers. */
function groupCounts(counts: number[], sizes: number[], labels: (string | null)[] | null, size: number | null): CountGroup[] {
  const usable = counts.flatMap((c, i) => (Number.isFinite(c) && Number.isFinite(sizes[i]) ? [i] : []))
  let items: [string, number[]][]
  if (labels !== null) {
    const byLabel = new Map<string, number[]>()
    for (const i of usable) {
      const label = labels[i]
      if (label === null) continue
      const list = byLabel.get(label)
      if (list) list.push(i)
      else byLabel.set(label, [i])
    }
    items = [...byLabel]
  } else if (size) {
    items = []
    // Like Python's range(0, n, size): a negative size gives no points.
    for (let s = 0, k = 0; size > 0 && s < usable.length; s += size, k++) items.push([String(k + 1), usable.slice(s, s + size)])
  } else items = usable.map((i, k) => [String(k + 1), [i]])
  return items.map(([label, positions]) => ({
    label,
    count: sum(positions.map((i) => counts[i])),
    size: sum(positions.map((i) => sizes[i])),
    positions,
  }))
}

// ------------------------------------------------------------------------ tests

/** Flag Western Electric / Nelson test failures on the point that completes each pattern. */
function runTests(chart: Chart, beyond: boolean, nelson: boolean): void {
  const seq = chart.points.filter((p) => p.value !== null && p.center !== null)
  const values = seq.map((p) => p.value!)
  const z = seq.map(zOf)
  const tol = 1e-12
  seq.forEach((p, k) => {
    const tests: number[] = []
    const v = values[k]
    if (beyond && ((p.ucl !== null && v > p.ucl + tol) || (p.lcl !== null && v < p.lcl - tol))) tests.push(1)
    if (nelson && chart.location) tests.push(...nelsonTests(values, z, k))
    p.tests = tests
  })
}

function zOf(p: Point): number | null {
  if (p.sigma === null || !(p.sigma > 0)) return null
  return (p.value! - p.center!) / p.sigma
}

/**
 * Nelson tests 2-8 for the window of `m` points ending at k. `values` are the plotted
 * statistics and `z` their standardized values (null where sigma is unknown or zero).
 */
function nelsonTests(values: number[], z: (number | null)[], k: number): number[] {
  const start = (m: number) => k + 1 - m
  /** Every z in the window of m points is known and satisfies `test`; false if the window doesn't fit. */
  const allZ = (m: number, test: (v: number) => boolean) => {
    if (start(m) < 0) return false
    for (let i = start(m); i <= k; i++) if (z[i] === null || !test(z[i]!)) return false
    return true
  }
  const knownZ = (m: number) => allZ(m, () => true)
  const countZ = (m: number, test: (v: number) => boolean) => {
    let count = 0
    for (let i = start(m); i <= k; i++) if (test(z[i]!)) count++
    return count
  }
  /** Every consecutive difference in the window of m points satisfies `test`. */
  const allDiffs = (m: number, test: (d: number, i: number) => boolean) => {
    if (start(m) < 0) return false
    for (let i = start(m) + 1; i <= k; i++) if (!test(values[i] - values[i - 1], i)) return false
    return true
  }

  const failed: number[] = []
  const zNow = z[k]
  if (allZ(9, (v) => v > 0) || allZ(9, (v) => v < 0)) failed.push(2)
  if (allDiffs(6, (d) => d > 0) || allDiffs(6, (d) => d < 0)) failed.push(3)
  const alternates = (d: number, i: number) => d !== 0 && (i === start(14) + 1 || (values[i - 1] - values[i - 2]) * d < 0)
  if (allDiffs(14, alternates)) failed.push(4)
  if (zNow !== null) {
    if (knownZ(3) && ((zNow > 2 && countZ(3, (v) => v > 2) >= 2) || (zNow < -2 && countZ(3, (v) => v < -2) >= 2))) failed.push(5)
    if (knownZ(5) && ((zNow > 1 && countZ(5, (v) => v > 1) >= 4) || (zNow < -1 && countZ(5, (v) => v < -1) >= 4))) failed.push(6)
  }
  if (allZ(15, (v) => Math.abs(v) < 1)) failed.push(7)
  if (allZ(8, (v) => Math.abs(v) > 1)) failed.push(8)
  return failed
}

// ---------------------------------------------------------------------- summary

/** Python's math.isclose. */
function isClose(a: number, b: number, absTol = 0): boolean {
  return a === b || Math.abs(a - b) <= Math.max(1e-9 * Math.max(Math.abs(a), Math.abs(b)), absTol)
}

function limitSummaries(charts: Chart[]): ReportNode {
  const rows: unknown[][] = []
  let varying = false
  for (const chart of charts) {
    const pts = chart.points.filter((p) => p.center !== null)
    const same =
      pts.length > 0 &&
      pts.every(
        (p) =>
          isClose(p.lcl ?? 0, pts[0].lcl ?? 0, 1e-12) && isClose(p.ucl ?? 0, pts[0].ucl ?? 0, 1e-12) && isClose(p.center ?? 0, pts[0].center ?? 0, 1e-12),
      )
    varying ||= !same
    const first = pts.length && same ? pts[0] : null
    const center = pts.length && pts.every((p) => isClose(p.center!, pts[0].center!)) ? pts[0].center : null
    rows.push([chart.name, first ? first.lcl : null, center, first ? first.ucl : null, chart.processSigma, chart.points.length, chart.subgroupSize])
  }
  const children: ReportNode[] = [r.table([['Chart', 'text'], 'LCL', 'Center', 'UCL', 'Sigma', ['Points', 'integer'], 'Subgroup Size'], rows)]
  if (varying) children.push(r.text('Limits vary with subgroup size; blank LCL / UCL cells mean the limits differ by point.'))
  return r.outline('Limit Summaries', children)
}
