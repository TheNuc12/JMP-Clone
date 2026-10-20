// Contingency platform: categorical Y by categorical X, mosaic, crosstab and chi-square tests
// (port of backend/app/analyses/contingency.py).

import type { AnalysisColumn, AnalysisResult, OutlineNode, ReportNode } from '../../api/types'
import { labelValues, levelsOf, sum } from '../common'
import { chi2 } from '../math/distributions'
import { fisherExact } from '../math/stats'
import * as r from '../report'
import { excludedNote } from './shared'

const OPTIONS: [string, string, boolean][] = [
  ['contingency_table', 'Contingency Table', true],
  ['tests', 'Tests', true],
]

/** Counts table (x levels by y levels) over rows where both are nonmissing. */
export function crosstab(yCol: AnalysisColumn, xCol: AnalysisColumn): { xLevels: string[]; yLevels: string[]; counts: number[][] } {
  const xs = labelValues(xCol)
  const ys = labelValues(yCol)
  const pairs: [string, string][] = []
  xs.forEach((xv, i) => {
    const yv = ys[i]
    if (xv !== null && yv !== null && yv !== undefined) pairs.push([xv, yv])
  })
  const xLevels = levelsOf(pairs.map((p) => p[0]), xCol.levels)
  const yLevels = levelsOf(pairs.map((p) => p[1]), yCol.levels)
  const xi = new Map(xLevels.map((l, i) => [l, i]))
  const yi = new Map(yLevels.map((l, j) => [l, j]))
  const counts = xLevels.map(() => yLevels.map(() => 0))
  for (const [xv, yv] of pairs) counts[xi.get(xv)!][yi.get(yv)!] += 1
  return { xLevels, yLevels, counts }
}

interface ChiSquare {
  n: number
  df: number
  negLoglike: number
  rsquareU: number
  g2: number
  pG2: number
  pearson: number
  pPearson: number
  smallExpected: number
}

/** Likelihood ratio and Pearson chi-square tests of independence. */
export function chiSquareTests(counts: number[][]): ChiSquare {
  const rows = counts.map((row) => sum(row))
  const cols = counts[0].map((_, j) => sum(counts.map((row) => row[j])))
  const n = sum(counts.flat())
  const expected = rows.map((ri) => cols.map((cj) => (ri * cj) / n))
  const obs = counts.flat()
  const exp = expected.flat()
  const nz = obs.map((o, i) => [o, exp[i]]).filter(([o]) => o > 0)
  const g2 = 2.0 * sum(nz.map(([o, e]) => o * Math.log(o / e)))
  const pearson = sum(obs.map((o, i) => (o - exp[i]) ** 2 / exp[i]))
  const df = (counts.length - 1) * (counts[0].length - 1)
  const colsPresent = cols.filter((c) => c > 0)
  const reduced = -sum(colsPresent.map((c) => c * Math.log(c / n))) // -LogLike of the Y-margin-only model
  return {
    n,
    df,
    negLoglike: g2 / 2.0,
    rsquareU: reduced > 0 ? g2 / 2.0 / reduced : NaN,
    g2,
    pG2: chi2.sf(g2, df),
    pearson,
    pPearson: chi2.sf(pearson, df),
    smallExpected: exp.filter((e) => e < 5).length / exp.length,
  }
}

export function analyze(yCol: AnalysisColumn, xCol: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  const [opts, items] = r.resolveOptions(OPTIONS, options)
  const yname = yCol.name
  const xname = xCol.name
  const title = `Contingency Analysis of ${yname} By ${xname}`
  const { xLevels, yLevels, counts } = crosstab(yCol, xCol)
  const n = sum(counts.flat())

  if (n === 0) {
    const nodes = [r.outline(title, [r.warning(`No rows with both ${yname} and ${xname} nonmissing.`)])]
    return { analysis: 'contingency', title, options: items, nodes }
  }

  const children: ReportNode[] = [
    r.outline('Mosaic Plot', [r.plot({ kind: 'mosaic', x: xname, y: yname, x_levels: xLevels, y_levels: yLevels, counts })]),
  ]
  if (opts.contingency_table) {
    children.push(
      r.outline('Contingency Table', [
        { type: 'crosstab', row_title: xname, col_title: yname, row_levels: xLevels, col_levels: yLevels, counts },
      ]),
    )
  }
  if (opts.tests) children.push(tests(counts, yname, xname))

  const total = Math.max(yCol.values.length, xCol.values.length)
  if (n < total) children.push(r.text(excludedNote(total, n)))
  return { analysis: 'contingency', title, options: items, nodes: [r.outline(title, children)] }
}

function tests(counts: number[][], yname: string, xname: string): OutlineNode {
  if (counts.length < 2 || counts[0].length < 2) {
    return r.outline('Tests', [r.warning(`Tests need at least 2 levels of both ${xname} and ${yname}.`)])
  }
  const t = chiSquareTests(counts)
  const children: ReportNode[] = [
    r.summary([
      ['N', t.n, 'integer'],
      ['DF', t.df, 'integer'],
      ['-LogLike', t.negLoglike],
      ['RSquare (U)', t.rsquareU],
    ]),
    r.table(
      [['Test', 'text'], 'ChiSquare', ['Prob>ChiSq', 'pvalue']],
      [
        ['Likelihood Ratio', t.g2, t.pG2],
        ['Pearson', t.pearson, t.pPearson],
      ],
    ),
  ]
  if (t.smallExpected > 0.2) children.push(r.warning('Warning: 20% of cells have expected count less than 5, ChiSquare suspect.'))
  if (counts.length === 2 && counts[0].length === 2) {
    children.push(
      r.outline("Fisher's Exact Test", [
        r.table(
          [['Test', 'text'], ['Prob', 'pvalue'], ['Alternative Hypothesis', 'text']],
          [
            ['Left', fisherExact(counts, 'less').pvalue, 'Odds ratio is less than 1'],
            ['Right', fisherExact(counts, 'greater').pvalue, 'Odds ratio is greater than 1'],
            ['2-Tail', fisherExact(counts, 'two-sided').pvalue, 'Odds ratio is not equal to 1'],
          ],
        ),
      ]),
    )
  }
  return r.outline('Tests', children)
}
