// Logistic platform: categorical Y by continuous X (port of backend/app/analyses/logistic.py).
//
// Binary and nominal responses use (multinomial) logistic regression with the last level as
// the reference. Ordinal responses with more than two levels use a cumulative logit model,
// reported as logit P(Y <= k) = Intercept[k] + slope * x.

import type { AnalysisColumn, AnalysisResult, ReportNode } from '../../api/types'
import { grid, labelValues, levelsOf, numericValues, sum } from '../common'
import { chi2, norm } from '../math/distributions'
import { matmul, transpose } from '../math/linalg'
import { logit, mnlogit, orderedLogit } from '../math/models'
import { expit } from '../math/special'
import * as r from '../report'
import { allEqual, excludedNote, extent } from './shared'

const OPTIONS: [string, string, boolean][] = [['odds_ratios', 'Odds Ratios', false]]

/** Model-independent summary of a fitted logistic model. */
interface FitResult {
  terms: string[]
  estimates: number[]
  stdErrors: number[]
  /** Indices of slope terms (for odds ratios). */
  slopes: number[]
  negLlf: number
  nParams: number
  /** x grid -> (L-1) x len(x) cumulative probabilities. */
  cumProbs: (gx: number[]) => number[][]
  notes: string[]
  /** statsmodels would have warned (separation, no convergence, singular Hessian). */
  warned: boolean
}

const withConstant = (x: number[]) => x.map((v) => [1, v])

/** logit P(Y = levels[0]) = b0 + b1 * x. */
function fitBinary(x: number[], yIdx: number[], levels: string[], xname: string): FitResult {
  const endog = yIdx.map((c) => (c === 0 ? 1 : 0))
  const res = logit(endog, withConstant(x), { maxiter: 200 })
  const b = res.params
  return {
    terms: ['Intercept', xname],
    estimates: b,
    stdErrors: res.bse,
    slopes: [1],
    negLlf: -res.llf,
    nParams: 2,
    cumProbs: (gx) => [gx.map((v) => expit(b[0] + b[1] * v))],
    notes: [`For log odds of ${levels[0]}/${levels[1]}`],
    warned: res.perfectPrediction || !res.converged,
  }
}

/** Multinomial logit; log odds of each level versus the last level. */
function fitNominal(x: number[], yIdx: number[], levels: string[], xname: string): FitResult {
  const L = levels.length
  // statsmodels uses code 0 as the reference, so map the last level to 0.
  const codes = yIdx.map((c) => (c === L - 1 ? 0 : c + 1))
  const res = mnlogit(codes, withConstant(x), { maxiter: 200 })
  const terms: string[] = []
  const est: number[] = []
  const se: number[] = []
  const slopes: number[] = []
  for (let c = 0; c < L - 1; c++) {
    terms.push(`Intercept[${levels[c]}]`, `${xname}[${levels[c]}]`)
    est.push(res.params[0][c], res.params[1][c])
    se.push(res.bse[0][c], res.bse[1][c])
    slopes.push(terms.length - 1)
  }
  const cumProbs = (gx: number[]) => {
    const pred = res.predict(withConstant(gx))
    // Back to level order (the reference level is column 0), then cumulate.
    const cum = pred.map((row) => {
      const probs = [...row.slice(1), row[0]]
      let acc = 0
      return probs.map((p) => (acc += p))
    })
    return Array.from({ length: L - 1 }, (_, k) => cum.map((row) => row[k]))
  }
  return {
    terms,
    estimates: est,
    stdErrors: se,
    slopes,
    negLlf: -res.llf,
    nParams: 2 * (L - 1),
    cumProbs,
    notes: levels.slice(0, -1).map((level) => `For log odds of ${level}/${levels[L - 1]}`),
    warned: !res.converged,
  }
}

/** Cumulative logit with a common slope: logit P(Y <= k) = a_k + b * x. */
function fitOrdinal(x: number[], yIdx: number[], levels: string[], xname: string): FitResult {
  const L = levels.length
  const res = orderedLogit(yIdx, x.map((v) => [v]), { maxiter: 1000 })
  if (!res.cov) throw new Error('need covariance of parameters for computing (unnormalized) covariances')
  const p = res.params
  const cov = res.cov
  // params = [beta, thr0, log(thr1 - thr0), ...]; P(Y <= k) = F(thr_k - beta * x)
  const thresholds = res.thresholds
  // Delta method for the thresholds: d thr_k / d thr0 = 1, d thr_k / d delta_i = exp(delta_i), i <= k.
  const jac = Array.from({ length: L - 1 }, () => new Array<number>(L).fill(0))
  for (let k = 0; k < L - 1; k++) jac[k][1] = 1.0
  for (let k = 1; k < L - 1; k++) for (let i = 1; i <= k; i++) jac[k][1 + i] = Math.exp(p[1 + i])
  const jcj = matmul(matmul(jac, cov), transpose(jac))
  const thrSe = jcj.map((row, k) => Math.sqrt(row[k]))
  const slope = -p[0]
  const slopeSe = Math.sqrt(cov[0][0])

  const terms = [...levels.slice(0, -1).map((level) => `Intercept[${level}]`), xname]
  return {
    terms,
    estimates: [...thresholds, slope],
    stdErrors: [...thrSe, slopeSe],
    slopes: [terms.length - 1],
    negLlf: -res.llf,
    nParams: L,
    cumProbs: (gx) => thresholds.map((th) => gx.map((v) => expit(th + slope * v))),
    notes: ['Cumulative logit: log odds of P(Y <= level) for each Intercept[level]'],
    warned: !res.converged,
  }
}

export function analyze(yCol: AnalysisColumn, xCol: AnalysisColumn, options: Record<string, boolean>): AnalysisResult {
  const [opts, items] = r.resolveOptions(OPTIONS, options)
  const yname = yCol.name
  const xname = xCol.name
  const title = `Logistic Fit of ${yname} By ${xname}`
  const yAll = labelValues(yCol)
  const xAll = numericValues(xCol)
  const keep = yAll.flatMap((yv, i) => (yv !== null && Number.isFinite(xAll[i]) ? [i] : []))
  const x = keep.map((i) => xAll[i])
  const y = keep.map((i) => yAll[i] as string)
  const levels = levelsOf(y, yCol.levels)
  const n = keep.length
  const L = levels.length

  const result = (children: ReportNode[]): AnalysisResult => {
    if (n < yAll.length) children.push(r.text(excludedNote(yAll.length, n)))
    return { analysis: 'logistic', title, options: items, nodes: [r.outline(title, children)] }
  }

  if (L < 2) return result([r.warning(`${yname} needs at least 2 levels with data for a logistic fit.`)])
  if (n < 3 || allEqual(x)) return result([r.warning(`${xname} must vary across at least 3 rows for a logistic fit.`)])

  const index = new Map(levels.map((level, i) => [level, i]))
  const yIdx = y.map((v) => index.get(v)!)
  const ordinal = yCol.modeling_type === 'ordinal' && L > 2

  let fit: FitResult
  try {
    if (L === 2) fit = fitBinary(x, yIdx, levels, xname)
    else if (ordinal) fit = fitOrdinal(x, yIdx, levels, xname)
    else fit = fitNominal(x, yIdx, levels, xname)
  } catch (e) {
    // Singular matrices, separation, etc.
    return result([r.warning(`The logistic model could not be fit: ${(e as Error).message}`)])
  }
  const unstable =
    fit.warned ||
    fit.negLlf < 1e-6 || // fitted probabilities are all 0 or 1: complete separation
    !fit.stdErrors.every(Number.isFinite) ||
    fit.stdErrors.some((se, i) => se > 100 * (Math.abs(fit.estimates[i]) + 1))

  const counts = levels.map((_, i) => yIdx.filter((c) => c === i).length)
  const reduced = -sum(counts.map((c) => c * Math.log(c / n)))
  const full = fit.negLlf
  const diff = reduced - full
  const df = fit.slopes.length
  const chisq = 2 * diff
  const k = fit.nParams
  const aicc = 2 * full + 2 * k + (n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : NaN)
  const bic = 2 * full + k * Math.log(n)

  const [lo, hi] = extent(x)
  const gx = grid(lo, hi)
  const cum = fit.cumProbs(gx).map((row) => row.map((p) => Math.min(Math.max(p, 0), 1)))

  const children: ReportNode[] = []
  if (unstable) {
    children.push(
      r.warning('Unstable fit: the model did not converge cleanly (possibly quasi-complete separation). Estimates may be unreliable.'),
    )
  }
  children.push(r.plot({ kind: 'logistic', x: xname, y: yname, y_levels: levels, curve_x: gx, cum_probs: cum }))
  children.push(
    r.outline('Whole Model Test', [
      r.table(
        [['Model', 'text'], '-LogLikelihood', ['DF', 'integer'], 'ChiSquare', ['Prob>ChiSq', 'pvalue']],
        [
          ['Difference', diff, df, chisq, chi2.sf(chisq, df)],
          ['Full', full, null, null, null],
          ['Reduced', reduced, null, null, null],
        ],
      ),
      r.summary([
        ['RSquare (U)', reduced > 0 ? diff / reduced : null],
        ['AICc', aicc],
        ['BIC', bic],
        ['Observations (or Sum Wgts)', n, 'integer'],
      ]),
    ]),
  )
  const paramRows = fit.terms.map((term, i) => {
    const est = fit.estimates[i]
    const se = fit.stdErrors[i]
    const wald = (est / se) ** 2
    return [term, est, se, wald, Number.isFinite(wald) ? chi2.sf(wald, 1) : null]
  })
  children.push(
    r.outline('Parameter Estimates', [
      r.table([['Term', 'text'], 'Estimate', 'Std Error', 'ChiSquare', ['Prob>ChiSq', 'pvalue']], paramRows),
      ...fit.notes.map((note) => r.text(note)),
    ]),
  )
  if (opts.odds_ratios) {
    const z = norm.ppf(0.975)
    const rows = fit.slopes.map((i) => {
      const b = fit.estimates[i]
      const se = fit.stdErrors[i]
      return [fit.terms[i], Math.exp(b), Math.exp(b - z * se), Math.exp(b + z * se)]
    })
    children.push(
      r.outline('Odds Ratios', [
        r.table([['Term', 'text'], 'Odds Ratio (per unit)', 'Lower 95%', 'Upper 95%'], rows),
        r.text(`Odds ratio for a one unit change in ${xname}`),
      ]),
    )
  }
  return result(children)
}
