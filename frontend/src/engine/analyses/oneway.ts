// Oneway platform: continuous Y by categorical X, ANOVA, t test and nonparametric tests
// (port of backend/app/analyses/oneway.py).

import type { AnalysisColumn, AnalysisResult, GroupSummary, OutlineNode, ReportNode } from '../../api/types'
import { boxStats, labelValues, levelsOf, mean, numericValues, std, sum, variance } from '../common'
import { f, t } from '../math/distributions'
import { bartlett, kruskal, levene, rankdata, tukeyHsd } from '../math/stats'
import * as r from '../report'
import { allEqual, excludedNote } from './shared'

const OPTIONS: [string, string, boolean][] = [
  ['means_anova', 'Means/Anova', true],
  ['means_std', 'Means and Std Dev', false],
  ['t_test', 't Test', false],
  ['box_plots', 'Box Plots', false],
  ['unequal_variances', 'Unequal Variances', false],
  ['nonparametric', 'Nonparametric (Wilcoxon / Kruskal-Wallis)', false],
  ['tukey', 'Compare Means: All Pairs, Tukey HSD', false],
]

/** Sum of squared deviations from the group's own mean (numpy's summation order). */
function sumSquares(g: number[]): number {
  const m = mean(g)
  return sum(g.map((v) => (v - m) ** 2))
}

export function analyze(yCol: AnalysisColumn, xCol: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  const yname = yCol.name
  const xname = xCol.name
  const yAll = numericValues(yCol)
  const xAll = labelValues(xCol)
  const keep = yAll.flatMap((yv, i) => (xAll[i] !== null && Number.isFinite(yv) ? [i] : []))
  const y = keep.map((i) => yAll[i])
  const xl = keep.map((i) => xAll[i] as string)
  const levels = levelsOf(xl, xCol.levels)
  const groups = levels.map((level) => y.filter((_, i) => xl[i] === level))
  const n = y.length
  const k = levels.length

  const [opts, items] = r.resolveOptions(OPTIONS, options, k === 2 ? [] : ['t_test'])
  const title = `Oneway Analysis of ${yname} By ${xname}`

  if (n === 0) {
    const nodes = [r.outline(title, [r.warning(`No rows with both ${yname} and ${xname} nonmissing.`)])]
    return { analysis: 'oneway', title, options: items, nodes }
  }

  const grand = mean(y)
  const ssTotal = sum(y.map((v) => (v - grand) ** 2))
  let ssError = 0
  for (const g of groups) ssError += sumSquares(g)
  const ssModel = ssTotal - ssError
  const dfModel = k - 1
  const dfError = n - k
  const mse = dfError > 0 ? ssError / dfError : NaN
  const tCrit = dfError > 0 ? t.ppf(0.975, dfError) : NaN

  const summaries: GroupSummary[] = levels.map((level, i) => {
    const g = groups[i]
    const m = mean(g)
    const half = dfError > 0 ? tCrit * Math.sqrt(mse / g.length) : NaN
    return { level, n: g.length, mean: m, ci_lower: r.clean(m - half), ci_upper: r.clean(m + half), box: boxStats(g) }
  })

  const children: ReportNode[] = [
    r.plot({
      kind: 'oneway',
      x: xname,
      y: yname,
      levels,
      groups: summaries,
      grand_mean: grand,
      show_diamonds: opts.means_anova,
      show_boxes: opts.box_plots,
    }),
  ]

  if (k < 2) children.push(r.warning(`${xname} has only one level with data; at least 2 are needed to compare means.`))
  else if (dfError <= 0) children.push(r.warning('No degrees of freedom for error; each level has a single observation.'))

  const canCompare = k >= 2 && dfError > 0
  if (opts.means_anova && canCompare) {
    children.push(anova(xname, n, ssModel, ssError, ssTotal, dfModel, dfError, mse, grand, summaries))
  }
  if (opts.means_std) children.push(meansStd(levels, groups))
  if (opts.t_test) children.push(welchTTest(levels, groups))
  if (opts.unequal_variances && k >= 2) children.push(unequalVariances(groups, n, k))
  if (opts.nonparametric && k >= 2) children.push(kruskalTests(levels, groups, y))
  if (opts.tukey && canCompare) children.push(tukey(levels, groups, mse))

  if (n < yAll.length) children.push(r.text(excludedNote(yAll.length, n)))
  return { analysis: 'oneway', title, options: items, nodes: [r.outline(title, children)] }
}

function anova(
  xname: string,
  n: number,
  ssModel: number,
  ssError: number,
  ssTotal: number,
  dfModel: number,
  dfError: number,
  mse: number,
  grand: number,
  summaries: GroupSummary[],
): OutlineNode {
  const msModel = ssModel / dfModel
  const fRatio = mse > 0 ? msModel / mse : NaN
  const p = Number.isFinite(fRatio) ? f.sf(fRatio, dfModel, dfError) : null
  const rsq = ssTotal > 0 ? ssModel / ssTotal : null
  const adj = ssTotal > 0 ? 1 - mse / (ssTotal / (n - 1)) : null
  const meansRows = summaries.map((s) => [s.level, s.n, s.mean, Math.sqrt(mse / s.n), s.ci_lower, s.ci_upper])
  return r.outline('Oneway Anova', [
    r.outline('Summary of Fit', [
      r.summary([
        ['Rsquare', rsq],
        ['Adj Rsquare', adj],
        ['Root Mean Square Error', Math.sqrt(mse)],
        ['Mean of Response', grand],
        ['Observations (or Sum Wgts)', n, 'integer'],
      ]),
    ]),
    r.outline('Analysis of Variance', [
      r.table(
        [['Source', 'text'], ['DF', 'integer'], 'Sum of Squares', 'Mean Square', 'F Ratio', ['Prob > F', 'pvalue']],
        [
          [xname, dfModel, ssModel, msModel, fRatio, p],
          ['Error', dfError, ssError, mse, null, null],
          ['C. Total', n - 1, ssTotal, null, null, null],
        ],
      ),
    ]),
    r.outline('Means for Oneway Anova', [
      r.table([['Level', 'text'], ['Number', 'integer'], 'Mean', 'Std Error', 'Lower 95%', 'Upper 95%'], meansRows),
      r.text('Std Error uses a pooled estimate of error variance'),
    ]),
  ])
}

function meansStd(levels: string[], groups: number[][]): OutlineNode {
  const rows = levels.map((level, i) => {
    const g = groups[i]
    const m = mean(g)
    if (g.length <= 1) return [level, g.length, m, null, null, null, null]
    const sd = std(g, 1)
    const sem = sd / Math.sqrt(g.length)
    const half = t.ppf(0.975, g.length - 1) * sem
    return [level, g.length, m, sd, sem, m - half, m + half]
  })
  return r.outline('Means and Std Deviations', [
    r.table([['Level', 'text'], ['Number', 'integer'], 'Mean', 'Std Dev', 'Std Err Mean', 'Lower 95%', 'Upper 95%'], rows),
  ])
}

/** Welch two-sample t test of mean(b) - mean(a). */
export function welchT(a: number[], b: number[]) {
  const va = variance(a, 1) / a.length
  const vb = variance(b, 1) / b.length
  const diff = mean(b) - mean(a)
  const se = Math.sqrt(va + vb)
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1))
  const tRatio = diff / se
  const half = t.ppf(0.975, df) * se
  return {
    diff,
    se,
    upper: diff + half,
    lower: diff - half,
    t: tRatio,
    df,
    pTwo: 2 * t.sf(Math.abs(tRatio), df),
    pGt: t.sf(tRatio, df),
    pLt: t.cdf(tRatio, df),
  }
}

function welchTTest(levels: string[], groups: number[][]): OutlineNode {
  const [a, b] = groups
  const title = 't Test'
  if (a.length < 2 || b.length < 2 || (variance(a) === 0 && variance(b) === 0)) {
    return r.outline(title, [r.warning('The t test needs at least 2 rows per level and nonzero variance.')])
  }
  const w = welchT(a, b)
  return r.outline(title, [
    r.text(`${levels[1]}-${levels[0]}`),
    r.text('Assuming unequal variances'),
    r.summary([
      ['Difference', w.diff],
      ['Std Err Dif', w.se],
      ['Upper CL Dif', w.upper],
      ['Lower CL Dif', w.lower],
      ['Confidence', 0.95],
      ['t Ratio', w.t],
      ['DF', w.df],
      ['Prob > |t|', w.pTwo, 'pvalue'],
      ['Prob > t', w.pGt, 'pvalue'],
      ['Prob < t', w.pLt, 'pvalue'],
    ]),
  ])
}

/** Welch's ANOVA allowing unequal variances: [F, df num, df den, p]. */
export function welchAnova(groups: number[][]): [number, number, number, number] {
  const k = groups.length
  const n = groups.map((g) => g.length)
  const means = groups.map((g) => mean(g))
  const vars = groups.map((g) => variance(g, 1))
  const w = n.map((ni, i) => ni / vars[i])
  const sw = sum(w)
  const mw = sum(w.map((wi, i) => wi * means[i])) / sw
  const a = sum(w.map((wi, i) => wi * (means[i] - mw) ** 2)) / (k - 1)
  const tmp = sum(w.map((wi, i) => (1 - wi / sw) ** 2 / (n[i] - 1)))
  const b = 1 + ((2 * (k - 2)) / (k ** 2 - 1)) * tmp
  const fRatio = a / b
  const df2 = (k ** 2 - 1) / (3 * tmp)
  return [fRatio, k - 1, df2, f.sf(fRatio, k - 1, df2)]
}

function unequalVariances(groups: number[][], n: number, k: number): OutlineNode {
  const bf = levene(groups, 'median')
  const lev = levene(groups, 'mean')
  const allMultiple = groups.every((g) => g.length > 1)
  const rows: unknown[][] = [
    ['Brown-Forsythe', bf.statistic, k - 1, n - k, bf.pvalue],
    ['Levene', lev.statistic, k - 1, n - k, lev.pvalue],
  ]
  if (allMultiple) {
    const bart = bartlett(groups)
    rows.push(['Bartlett', bart.statistic, k - 1, null, bart.pvalue])
  }
  const children: ReportNode[] = [
    r.table([['Test', 'text'], 'F Ratio', ['DFNum', 'integer'], ['DFDen', 'integer'], ['p-Value', 'pvalue']], rows),
  ]
  if (allMultiple && groups.every((g) => variance(g) > 0)) {
    const [fRatio, d1, d2, p] = welchAnova(groups)
    children.push(
      r.outline("Welch's Test", [
        r.text('Welch Anova testing Means Equal, allowing Std Devs Not Equal'),
        r.summary([
          ['F Ratio', fRatio],
          ['DFNum', Math.trunc(d1), 'integer'],
          ['DFDen', d2],
          ['Prob > F', p, 'pvalue'],
        ]),
      ]),
    )
  } else children.push(r.warning("Welch's test needs at least 2 rows and nonzero variance in every level."))
  return r.outline('Tests that the Variances are Equal', children)
}

function kruskalTests(levels: string[], groups: number[][], y: number[]): OutlineNode {
  const n = y.length
  // Midranks of the pooled data, split back into the groups.
  const pooledRanks = rankdata(groups.flat())
  let start = 0
  const rows = levels.map((level, i) => {
    const size = groups[i].length
    const scoreSum = sum(pooledRanks.slice(start, start + size))
    start += size
    return [level, size, scoreSum, (size * (n + 1)) / 2, scoreSum / size]
  })
  let test: ReportNode[]
  if (allEqual(y)) test = [r.warning('All responses are tied; the Kruskal-Wallis test is undefined.')]
  else {
    const { statistic, pvalue } = kruskal(groups)
    test = [
      r.summary([
        ['ChiSquare', statistic],
        ['DF', groups.length - 1, 'integer'],
        ['Prob>ChiSq', pvalue, 'pvalue'],
      ]),
    ]
  }
  return r.outline('Wilcoxon / Kruskal-Wallis Tests (Rank Sums)', [
    r.table([['Level', 'text'], ['Count', 'integer'], 'Score Sum', 'Expected Score', 'Score Mean'], rows),
    r.outline('1-Way Test, ChiSquare Approximation', test),
  ])
}

function tukey(levels: string[], groups: number[][], mse: number): OutlineNode {
  if (groups.some((g) => g.length < 2)) {
    return r.outline('Means Comparisons: Tukey HSD', [r.warning('Tukey HSD needs at least 2 rows in every level.')])
  }
  const res = tukeyHsd(groups, 0.95)
  const k = levels.length
  const rows: [string, string, number, number, number, number, number][] = []
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const [a, b] = res.statistic[i][j] >= 0 ? [i, j] : [j, i]
      const se = Math.sqrt(mse * (1 / groups[a].length + 1 / groups[b].length))
      rows.push([levels[a], levels[b], res.statistic[a][b], se, res.low[a][b], res.high[a][b], res.pvalue[a][b]])
    }
  }
  rows.sort((p, q) => q[2] - p[2])
  return r.outline('Means Comparisons: Tukey HSD', [
    r.outline('Ordered Differences Report', [
      r.table(
        [['Level', 'text'], ['- Level', 'text'], 'Difference', 'Std Err Dif', 'Lower CL', 'Upper CL', ['p-Value', 'pvalue']],
        rows,
      ),
    ]),
  ])
}
