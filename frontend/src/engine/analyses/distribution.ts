// Distribution platform: univariate summaries of a continuous or categorical column
// (port of backend/app/analyses/distribution.py).

import type { AnalysisColumn, AnalysisResult, HistogramPlot, OutlineNode, ReportNode } from '../../api/types'
import { boxStats, finite, labelValues, levelsOf, mean, meanCi, numericValues, quantile, std } from '../common'
import { extent } from './shared'
import { chi2, t } from '../math/distributions'
import { lilliefors, shapiro } from '../math/stats'
import { pyRound } from '../pyformat'
import * as r from '../report'

const CONTINUOUS_OPTIONS: [string, string, boolean][] = [
  ['fit_normal', 'Fit Normal', false],
  ['outlier_box', 'Outlier Box Plot', true],
]

const QUANTILE_LABELS: [string, number][] = [
  ['100.0% maximum', 1.0],
  ['99.5%', 0.995],
  ['97.5%', 0.975],
  ['90.0%', 0.9],
  ['75.0% quartile', 0.75],
  ['50.0% median', 0.5],
  ['25.0% quartile', 0.25],
  ['10.0%', 0.1],
  ['2.5%', 0.025],
  ['0.5%', 0.005],
  ['0.0% minimum', 0.0],
]

/** 10 ** exp for an integer exponent, correctly rounded like Python's float power. */
function pow10(exp: number): number {
  return exp < 0 ? 1 / 10 ** -exp : 10 ** exp
}

/** Round a positive number up to 1, 2 or 5 times a power of ten. */
function niceNumber(x: number): number {
  if (x <= 0 || !Number.isFinite(x)) return 1.0
  const exp = Math.floor(Math.log10(x))
  const frac = x / pow10(exp)
  for (const nice of [1.0, 2.0, 5.0, 10.0]) if (frac <= nice + 1e-9) return nice * pow10(exp)
  return 10.0 * pow10(exp)
}

/** Round a positive number to the nearest 1, 2 or 5 times a power of ten. */
function nearestNiceNumber(x: number): number {
  if (x <= 0 || !Number.isFinite(x)) return 1.0
  const exp = Math.floor(Math.log10(x))
  const frac = x / pow10(exp)
  const nice = frac < 1.5 ? 1.0 : frac < 3 ? 2.0 : frac < 7 ? 5.0 : 10.0
  return nice * pow10(exp)
}

function roundToBin(x: number, size: number): number {
  return pyRound(x, Math.max(0, -Math.floor(Math.log10(size)) + 2))
}

/** Histogram bins with a 'nice' width; every value falls in [start, end). */
export function niceBins(values: number[]): HistogramPlot['bins'] {
  const [lo, hi] = extent(values)
  let size: number
  if (hi === lo) size = lo !== 0 ? niceNumber(Math.abs(lo) * 0.1) : 1.0
  else {
    const target = Math.max(5, Math.min(50, Math.ceil(Math.log2(values.length) + 1)))
    size = nearestNiceNumber((hi - lo) / target)
  }
  const start = Math.floor(lo / size) * size
  const nBins = Math.floor((hi - start) / size + 1e-9) + 1
  let end = start + nBins * size
  // Guard against floating point drift leaving the max on/over the right edge.
  while (end <= hi) end += size
  return { start: roundToBin(start, size), size, end: roundToBin(end, size) }
}

export function continuous(col: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  const [opts, items] = r.resolveOptions(CONTINUOUS_OPTIONS, options)
  const raw = numericValues(col)
  const v = finite(raw)
  const n = v.length
  const nMissing = raw.length - n
  const title = `Distribution of ${col.name}`

  if (n === 0) {
    const nodes = [
      r.outline(col.name, [
        r.warning('No nonmissing values; nothing to analyze.'),
        r.summary([
          ['N', 0, 'integer'],
          ['N Missing', nMissing, 'integer'],
        ]),
      ]),
    ]
    return { analysis: 'distribution_continuous', title, options: items, nodes }
  }

  const m = mean(v)
  const sd = n > 1 ? std(v, 1) : NaN
  const se = n > 1 ? sd / Math.sqrt(n) : NaN
  const ci = meanCi(v)
  const fitNormal = opts.fit_normal && n > 1 && sd > 0

  const children: ReportNode[] = []
  if (n === 1) children.push(r.warning('Only one nonmissing value; statistics that need a variance are unavailable.'))
  else if (sd === 0) children.push(r.warning('All values are identical; the standard deviation is zero.'))

  children.push(
    r.plot({
      kind: 'histogram',
      column: col.name,
      bins: niceBins(v),
      box: opts.outlier_box ? boxStats(v) : null,
      mean_ci: ci,
      normal: fitNormal ? { mu: m, sigma: sd } : null,
      reference_lines: [],
    }),
  )

  const quantiles = r.outline('Quantiles', [
    r.table(
      [['Quantile', 'text'], 'Value'],
      QUANTILE_LABELS.map(([label, q]) => [label, quantile(v, q)]),
    ),
  ])
  const summaryStats = r.outline('Summary Statistics', [
    r.summary([
      ['Mean', m],
      ['Std Dev', sd],
      ['Std Err Mean', se],
      ['Upper 95% Mean', ci ? ci[1] : null],
      ['Lower 95% Mean', ci ? ci[0] : null],
      ['N', n, 'integer'],
      ['N Missing', nMissing, 'integer'],
    ]),
  ])
  children.push(r.row(quantiles, summaryStats))

  if (opts.fit_normal) {
    if (fitNormal) children.push(fittedNormal(v, m, sd))
    else children.push(r.warning('Fit Normal needs at least two distinct values.'))
  }

  return { analysis: 'distribution_continuous', title, options: items, nodes: [r.outline(col.name, children)] }
}

function fittedNormal(v: number[], m: number, sd: number): OutlineNode {
  const n = v.length
  const tq = t.ppf(0.975, n - 1)
  const se = sd / Math.sqrt(n)
  const ss = (n - 1) * sd ** 2
  const sigmaLo = Math.sqrt(ss / chi2.ppf(0.975, n - 1))
  const sigmaHi = Math.sqrt(ss / chi2.ppf(0.025, n - 1))
  const params = r.outline('Parameter Estimates', [
    r.table(
      [['Type', 'text'], ['Parameter', 'text'], 'Estimate', 'Lower 95%', 'Upper 95%'],
      [
        ['Location', 'μ', m, m - tq * se, m + tq * se],
        ['Dispersion', 'σ', sd, sigmaLo, sigmaHi],
      ],
    ),
  ])
  let gof: ReportNode
  if (n < 3) gof = r.warning('The goodness-of-fit test needs at least 3 observations.')
  else if (n <= 5000) {
    const { statistic, pvalue } = shapiro(v)
    gof = r.table([['Test', 'text'], 'W', ['Prob<W', 'pvalue']], [['Shapiro-Wilk', statistic, pvalue]])
  } else {
    const { statistic, pvalue } = lilliefors(v)
    gof = r.table([['Test', 'text'], 'D', ['Prob>D', 'pvalue']], [['Kolmogorov-Smirnov-Lilliefors', statistic, pvalue]])
  }
  const goodness = r.outline('Goodness-of-Fit Test', [
    gof,
    r.text('Note: Ho = The data is from the Normal distribution. Small p-values reject Ho.'),
  ])
  return r.outline('Fitted Normal Distribution', [params, goodness])
}

export function categorical(col: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  void options
  const labels = labelValues(col)
  const present = labels.filter((l): l is string => l !== null)
  const levels = levelsOf(present, col.levels)
  const n = present.length
  const nMissing = labels.length - n
  const title = `Distribution of ${col.name}`

  if (n === 0) {
    const nodes = [
      r.outline(col.name, [
        r.warning('No nonmissing values; nothing to analyze.'),
        r.summary([
          ['N Missing', nMissing, 'integer'],
          ['N Levels', 0, 'integer'],
        ]),
      ]),
    ]
    return { analysis: 'distribution_categorical', title, options: [], nodes }
  }

  const counts = new Map(levels.map((level) => [level, 0]))
  for (const label of present) counts.set(label, counts.get(label)! + 1)
  const countList = levels.map((level) => counts.get(level)!)

  const freqRows: unknown[][] = levels.map((level, i) => [level, countList[i], countList[i] / n])
  freqRows.push(['Total', n, 1.0])
  const children: ReportNode[] = [
    r.plot({ kind: 'bar', column: col.name, levels, counts: countList }),
    r.outline('Frequencies', [
      r.table([['Level', 'text'], ['Count', 'integer'], 'Prob'], freqRows),
      r.summary([
        ['N Missing', nMissing, 'integer'],
        ['N Levels', levels.length, 'integer'],
      ]),
    ]),
  ]
  return { analysis: 'distribution_categorical', title, options: [], nodes: [r.outline(col.name, children)] }
}
