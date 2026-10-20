// Bivariate platform: continuous Y by continuous X, scatter plot with fits
// (port of backend/app/analyses/bivariate.py).

import type { AnalysisColumn, AnalysisResult, Curve, OutlineNode, ReportNode } from '../../api/types'
import { grid, mean, numericValues, std, sum } from '../common'
import { f } from '../math/distributions'
import type { Matrix } from '../math/linalg'
import { ols, olsPredict } from '../math/models'
import { pearsonr } from '../math/stats'
import * as r from '../report'
import { allEqual, excludedNote, extent } from './shared'

const OPTIONS: [string, string, boolean][] = [
  ['fit_mean', 'Fit Mean', false],
  ['fit_line', 'Fit Line', true],
  ['fit_quadratic', 'Fit Polynomial (Quadratic)', false],
  ['correlation', 'Correlation', false],
]

export function analyze(yCol: AnalysisColumn, xCol: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  const [opts, items] = r.resolveOptions(OPTIONS, options)
  const yname = yCol.name
  const xname = xCol.name
  const yAll = numericValues(yCol)
  const xAll = numericValues(xCol)
  const keep = yAll.map((y, i) => Number.isFinite(y) && Number.isFinite(xAll[i]))
  const x = xAll.filter((_, i) => keep[i])
  const y = yAll.filter((_, i) => keep[i])
  const n = x.length
  const title = `Bivariate Fit of ${yname} By ${xname}`

  const nodes: ReportNode[] = []
  const curves: Curve[] = []
  const reports: ReportNode[] = []

  if (n < 2) {
    nodes.push(r.warning(`Only ${n} row(s) with both ${yname} and ${xname} nonmissing; at least 2 are needed.`))
  } else {
    const xConstant = allEqual(x)
    const yConstant = allEqual(y)
    if (opts.fit_mean) {
      const [curve, rep] = fitMean(x, y)
      curves.push(curve)
      reports.push(rep)
    }
    if (opts.fit_line || opts.fit_quadratic) {
      if (xConstant) reports.push(r.warning(`${xname} is constant; a regression line cannot be fit.`))
      // The slope is exactly zero; its t ratio would only report rounding noise.
      else if (yConstant) reports.push(r.warning(`${yname} is constant; there is no variation for a regression line to explain.`))
      else {
        if (opts.fit_line) {
          const [curve, rep] = polyFit(x, y, 1, xname, yname)
          curves.push(curve)
          reports.push(rep)
        }
        if (opts.fit_quadratic) {
          if (new Set(x).size < 3) reports.push(r.warning('A quadratic fit needs at least 3 distinct X values.'))
          else {
            const [curve, rep] = polyFit(x, y, 2, xname, yname)
            curves.push(curve)
            reports.push(rep)
          }
        }
      }
    }
    if (opts.correlation) reports.push(correlation(x, y, xname, yname))
  }

  nodes.unshift(r.plot({ kind: 'scatter', x: xname, y: yname, curves }))
  nodes.push(...reports)
  if (n < keep.length) nodes.push(r.text(excludedNote(keep.length, n)))
  return { analysis: 'bivariate', title, options: items, nodes: [r.outline(title, nodes)] }
}

function fitMean(x: number[], y: number[]): [Curve, OutlineNode] {
  const n = y.length
  const m = mean(y)
  const sd = std(y, 1)
  const [lo, hi] = extent(x)
  const curve: Curve = { label: 'Fit Mean', x: [lo, hi], y: [m, m], lower: null, upper: null }
  const rep = r.outline('Fit Mean', [
    r.summary([
      ['Mean', m],
      ['Std Dev [RMSE]', sd],
      ['Std Error', sd / Math.sqrt(n)],
      ['SSE', sum(y.map((v) => (v - m) ** 2))],
    ]),
  ])
  return [curve, rep]
}

function signed(coef: number): string {
  return coef < 0 ? `- ${r.fmtNum(-coef, 6)}` : `+ ${r.fmtNum(coef, 6)}`
}

/** OLS linear (degree 1) or centered quadratic (degree 2) fit. */
function polyFit(x: number[], y: number[], degree: 1 | 2, xname: string, yname: string): [Curve, OutlineNode] {
  const xbar = mean(x)
  let design: (xs: number[]) => Matrix
  let terms: string[]
  let heading: string
  if (degree === 1) {
    design = (xs) => xs.map((v) => [1, v])
    terms = ['Intercept', xname]
    heading = 'Linear Fit'
  } else {
    design = (xs) => xs.map((v) => [1, v, (v - xbar) * (v - xbar)])
    const centre = xbar >= 0 ? `${xname}-${r.fmtNum(xbar, 6)}` : `${xname}+${r.fmtNum(-xbar, 6)}`
    terms = ['Intercept', xname, `(${centre})^2`]
    heading = 'Polynomial Fit Degree=2'
  }

  const fit = ols(y, design(x))
  const [lo, hi] = extent(x)
  const gx = grid(lo, hi)
  const frame = olsPredict(fit, design(gx), 0.05)

  const b = fit.params
  let equation = `${yname} = ${r.fmtNum(b[0], 6)} ${signed(b[1])}*${xname}`
  if (degree === 2) equation += ` ${signed(b[2])}*${terms[2]}`

  const n = y.length
  const dfModel = Math.trunc(fit.dfModel)
  const dfError = Math.trunc(fit.dfResid)
  const ssModel = fit.ess
  const ssError = fit.ssr
  const ssTotal = fit.centeredTss
  const msModel = dfModel ? ssModel / dfModel : null
  const msError = dfError ? ssError / dfError : null
  const fRatio = msModel !== null && msError ? msModel / msError : null
  const pF = fRatio !== null ? f.sf(fRatio, dfModel, dfError) : null

  const children: ReportNode[] = [r.text(equation, 'equation')]
  if (dfError === 0) children.push(r.warning('No degrees of freedom for error; the fit is exact.'))
  children.push(
    r.outline('Summary of Fit', [
      r.summary([
        ['RSquare', ssTotal > 0 ? fit.rsquared : null],
        ['RSquare Adj', ssTotal > 0 && dfError ? fit.rsquaredAdj : null],
        ['Root Mean Square Error', msError !== null ? Math.sqrt(msError) : null],
        ['Mean of Response', mean(y)],
        ['Observations (or Sum Wgts)', n, 'integer'],
      ]),
    ]),
    r.outline('Analysis of Variance', [
      r.table(
        [['Source', 'text'], ['DF', 'integer'], 'Sum of Squares', 'Mean Square', 'F Ratio', ['Prob > F', 'pvalue']],
        [
          ['Model', dfModel, ssModel, msModel, fRatio, pF],
          ['Error', dfError, ssError, msError, null, null],
          ['C. Total', n - 1, ssTotal, null, null, null],
        ],
      ),
    ]),
    r.outline('Parameter Estimates', [
      r.table(
        [['Term', 'text'], 'Estimate', 'Std Error', 't Ratio', ['Prob>|t|', 'pvalue']],
        terms.map((term, i) =>
          dfError ? [term, b[i], fit.bse[i], fit.tvalues[i], fit.pvalues[i]] : [term, b[i], null, null, null],
        ),
      ),
    ]),
  )
  const hasBand = dfError > 0
  const curve: Curve = {
    label: heading,
    x: gx,
    y: frame.mean,
    lower: hasBand ? frame.lower : null,
    upper: hasBand ? frame.upper : null,
  }
  return [curve, r.outline(heading, children)]
}

/** numpy's np.cov(x, y, ddof=1)[0, 1]. */
function covariance(x: number[], y: number[]): number {
  const mx = mean(x)
  const my = mean(y)
  let s = 0
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my)
  return s / (x.length - 1)
}

function correlation(x: number[], y: number[], xname: string, yname: string): OutlineNode {
  const n = x.length
  let corr: number | null = null
  let cov: number | null = null
  let p: number | null = null
  const note: ReportNode[] = []
  if (n < 3 || allEqual(x) || allEqual(y)) {
    note.push(r.warning('Correlation needs at least 3 rows and nonconstant variables.'))
  } else {
    const res = pearsonr(x, y)
    corr = res.statistic
    p = res.pvalue
    cov = covariance(x, y)
  }
  const sd = (v: number[]) => (v.length > 1 ? std(v, 1) : null)
  return r.outline('Correlation', [
    ...note,
    r.table(
      [['Variable', 'text'], 'Mean', 'Std Dev'],
      [
        [xname, mean(x), sd(x)],
        [yname, mean(y), sd(y)],
      ],
    ),
    r.summary([
      ['Correlation', corr],
      ['Covariance', cov],
      ['Signif. Prob', p, 'pvalue'],
      ['Number', n, 'integer'],
    ]),
  ])
}
