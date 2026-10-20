// Regression models as statsmodels 0.15 fits them: OLS by pseudo-inverse, Logit and MNLogit
// by its Newton–Raphson, and the logit OrderedModel by BFGS on numerical derivatives.

import { t } from './distributions'
import { eigh, inv, type Matrix, matmul, matrixRank, pinvExtended, solve, transpose } from './linalg'
import { approxFprime, approxHess, fminBfgs } from './optimize'
import { expit, logit as logOdds } from './special'
import { sum } from './stats'

const EPS = 2.220446049250313e-16

const dot = (x: readonly number[], y: readonly number[]) => x.reduce((s, v, i) => s + v * y[i], 0)

/**
 * statsmodels' constant detection (hasconst=None): 1 when X has a nonzero constant column
 * or an implicit constant (the ones vector lies in its column span), else 0.
 */
export function kConstant(X: Matrix): number {
  const p = X.length ? X[0].length : 0
  for (let j = 0; j < p; j++) {
    const first = X[0][j]
    if (first !== 0 && X.every((row) => row[j] === first)) return 1
  }
  return matrixRank(X.map((row) => [1, ...row])) === matrixRank(X) ? 1 : 0
}

/** Sorted distinct values and each observation's index among them (np.unique(..., return_inverse=True)). */
function encode(y: readonly number[]): { levels: number[]; codes: number[] } {
  const levels = [...new Set(y)].sort((a, b) => a - b)
  const index = new Map(levels.map((v, i) => [v, i]))
  return { levels, codes: y.map((v) => index.get(v) as number) }
}

// ------------------------------------------------------------------------------ OLS

export interface OLSResult {
  params: number[]
  bse: number[]
  tvalues: number[]
  pvalues: number[]
  /** scale · (XᵀX)⁺ */
  cov: Matrix
  fitted: number[]
  resid: number[]
  nobs: number
  rank: number
  kConstant: number
  dfModel: number
  dfResid: number
  ssr: number
  ess: number
  centeredTss: number
  uncenteredTss: number
  rsquared: number
  rsquaredAdj: number
  /** ssr / dfResid */
  scale: number
}

/**
 * sm.OLS(y, X).fit(): the pseudo-inverse solution (singular values below 1e-15 · max are
 * dropped), so a rank-deficient X gets the minimum-norm fit and df from its numerical rank.
 */
export function ols(y: readonly number[], X: Matrix): OLSResult {
  const n = X.length
  const { pinv, s } = pinvExtended(X)
  const rank = s.filter((v) => v > s[0] * s.length * EPS).length
  const params = pinv.map((row) => dot(row, y))
  const normalizedCov = matmul(pinv, transpose(pinv))
  const fitted = X.map((row) => dot(row, params))
  const resid = y.map((v, i) => v - fitted[i])
  const ssr = dot(resid, resid)
  const k = kConstant(X)
  const dfResid = n - rank
  const scale = ssr / dfResid
  const cov = normalizedCov.map((row) => row.map((v) => v * scale))
  const bse = cov.map((row, i) => Math.sqrt(row[i]))
  const tvalues = params.map((b, i) => b / bse[i])
  const ybar = sum(y) / n
  const centeredTss = sum(y.map((v) => (v - ybar) ** 2))
  const uncenteredTss = dot(y, y)
  const tss = k ? centeredTss : uncenteredTss
  const rsquared = 1 - ssr / tss
  return {
    params, bse, tvalues, cov, fitted, resid, rank, ssr, centeredTss, uncenteredTss, rsquared, scale, dfResid,
    pvalues: tvalues.map((tv) => 2 * t.sf(Math.abs(tv), dfResid)),
    nobs: n,
    kConstant: k,
    dfModel: rank - k,
    ess: tss - ssr,
    rsquaredAdj: 1 - ((n - k) / dfResid) * (1 - rsquared),
  }
}

/** Mean predictions with t confidence limits (get_prediction(Xnew).summary_frame(alpha)). */
export function olsPredict(fit: OLSResult, Xnew: Matrix, alpha = 0.05): { mean: number[]; se: number[]; lower: number[]; upper: number[] } {
  const q = t.ppf(1 - alpha / 2, fit.dfResid)
  const mean = Xnew.map((row) => dot(row, fit.params))
  const se = Xnew.map((row) => Math.sqrt(dot(row, fit.cov.map((c) => dot(c, row)))))
  return { mean, se, lower: mean.map((m, i) => m - q * se[i]), upper: mean.map((m, i) => m + q * se[i]) }
}

// --------------------------------------------------------------------- Newton fits

/**
 * statsmodels' Newton–Raphson (_fit_newton): steps by the score and Hessian of −loglike / n
 * with a 1e-10 ridge until no parameter moves more than 1e-8; `converged` is false only when
 * maxiter steps were taken. `derivatives` returns the unridged Hessian.
 */
function newton(
  start: number[],
  derivatives: (params: number[]) => { score: number[]; hess: Matrix },
  maxiter: number,
  afterStep?: (params: number[]) => void,
): { params: number[]; iterations: number; converged: boolean } {
  let params = start
  let old = start.map(() => Infinity)
  let iterations = 0
  while (iterations < maxiter && params.some((p, i) => Math.abs(p - old[i]) > 1e-8)) {
    const { score, hess } = derivatives(params)
    hess.forEach((row, i) => (row[i] += 1e-10))
    old = params
    const step = solve(hess, score)
    params = old.map((p, i) => p - step[i])
    afterStep?.(params)
    iterations++
  }
  return { params, iterations, converged: iterations !== maxiter }
}

export interface LogitResult {
  params: number[]
  bse: number[]
  cov: Matrix
  llf: number
  converged: boolean
  iterations: number
  /** statsmodels' PerfectSeparationWarning: an iterate predicted every response within 1e-8. */
  perfectPrediction: boolean
}

/**
 * Binary logistic regression P(y = 1) = expit(X β) as sm.Logit(y, X).fit(maxiter=...) fits it
 * (statsmodels' default maxiter is 35). Throws LinAlgError if a Hessian is exactly singular.
 */
export function logit(y: readonly number[], X: Matrix, { maxiter = 35 } = {}): LogitResult {
  const n = X.length
  const predict = (params: number[]) => X.map((row) => expit(dot(row, params)))
  const info = (p: number[]) => {
    // XᵀWX / n with W = diag(p (1 − p)).
    const k = X[0].length
    const h = Array.from({ length: k }, () => new Array<number>(k).fill(0))
    X.forEach((row, i) => {
      const w = p[i] * (1 - p[i])
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) h[a][b] += w * row[a] * row[b]
    })
    return h.map((row) => row.map((v) => v / n))
  }
  let perfectPrediction = false
  const fit = newton(
    X[0].map(() => 0),
    (params) => {
      const p = predict(params)
      const score = X[0].map((_, j) => -X.reduce((s, row, i) => s + (y[i] - p[i]) * row[j], 0) / n)
      return { score, hess: info(p) }
    },
    maxiter,
    (params) => {
      if (predict(params).every((p, i) => Math.abs(p - y[i]) <= 1e-8)) perfectPrediction = true
    },
  )
  const cov = inv(info(predict(fit.params))).map((row) => row.map((v) => v / n))
  const linear = X.map((row) => dot(row, fit.params))
  return {
    params: fit.params,
    bse: cov.map((row, i) => Math.sqrt(row[i])),
    cov,
    llf: sum(linear.map((z, i) => Math.log(expit((2 * y[i] - 1) * z)))),
    converged: fit.converged,
    iterations: fit.iterations,
    perfectPrediction,
  }
}

export interface MNLogitResult {
  /** K × (J − 1): column j holds the coefficients of outcome j + 1 against outcome 0. */
  params: Matrix
  bse: Matrix
  /** Covariance of the stacked parameters, equation-major (index j · K + k). */
  cov: Matrix
  llf: number
  converged: boolean
  iterations: number
  /** Outcome probabilities (one column per outcome, in sorted code order) for new design rows. */
  predict(X: Matrix): Matrix
}

/**
 * Multinomial logit as sm.MNLogit(codes, X).fit(maxiter=...) fits it: outcomes are the sorted
 * distinct codes and the lowest is the reference. Throws LinAlgError on a singular Hessian.
 */
export function mnlogit(codes: readonly number[], X: Matrix, { maxiter = 35 } = {}): MNLogitResult {
  const n = X.length
  const K = X[0].length
  const { levels, codes: outcome } = encode(codes)
  const J = levels.length
  const probs = (rows: Matrix, flat: number[]) =>
    rows.map((row) => {
      const e = [1]
      for (let j = 0; j < J - 1; j++) e.push(Math.exp(row.reduce((s, x, k) => s + x * flat[j * K + k], 0)))
      const total = e.reduce((s, v) => s + v, 0)
      return e.map((v) => v / total)
    })
  const derivatives = (flat: number[]) => {
    const pr = probs(X, flat)
    const score = new Array<number>((J - 1) * K).fill(0)
    const hess = Array.from({ length: (J - 1) * K }, () => new Array<number>((J - 1) * K).fill(0))
    X.forEach((row, i) => {
      for (let a = 0; a < J - 1; a++) {
        const resid = (outcome[i] === a + 1 ? 1 : 0) - pr[i][a + 1]
        for (let k = 0; k < K; k++) score[a * K + k] -= resid * row[k]
        for (let b = 0; b < J - 1; b++) {
          const w = pr[i][a + 1] * ((a === b ? 1 : 0) - pr[i][b + 1])
          for (let k = 0; k < K; k++) for (let l = 0; l < K; l++) hess[a * K + k][b * K + l] += w * row[k] * row[l]
        }
      }
    })
    return { score: score.map((v) => v / n), hess: hess.map((row) => row.map((v) => v / n)) }
  }
  const fit = newton(new Array<number>((J - 1) * K).fill(0), derivatives, maxiter)
  const cov = inv(derivatives(fit.params).hess).map((row) => row.map((v) => v / n))
  const reshape = (flat: number[]) => Array.from({ length: K }, (_, k) => Array.from({ length: J - 1 }, (_, j) => flat[j * K + k]))
  const pr = probs(X, fit.params)
  return {
    params: reshape(fit.params),
    bse: reshape(cov.map((row, i) => Math.sqrt(row[i]))),
    cov,
    llf: sum(pr.flatMap((row, i) => row.map((p, j) => (outcome[i] === j ? 1 : 0) * Math.log(p)))),
    converged: fit.converged,
    iterations: fit.iterations,
    predict: (rows) => probs(rows, fit.params),
  }
}

// ------------------------------------------------------------------ ordered logit

export interface OrderedLogitResult {
  /** [β₁ … β_m, θ₀, log(θ₁ − θ₀), …]: statsmodels' OrderedModel parameterization. */
  params: number[]
  /** Inverse of the negated numerical Hessian; null when it is not positive definite (HessianInversionWarning). */
  cov: Matrix | null
  bse: number[]
  llf: number
  /** False on statsmodels' ConvergenceWarning (BFGS hit maxiter or lost precision). */
  converged: boolean
  iterations: number
  /** The finite cut points θ₀ < θ₁ < … with P(Y ≤ k | x) = expit(θ_k − x β). */
  thresholds: number[]
}

/**
 * Cumulative logit model as OrderedModel(y, exog, distr="logit").fit(method="bfgs", maxiter=...)
 * fits it, BFGS iterations and numerical derivatives included. exog must not contain a constant
 * (statsmodels raises for one, explicit or implicit, and so does this).
 */
export function orderedLogit(y: readonly number[], exog: Matrix, { maxiter = 500 } = {}): OrderedLogitResult {
  if (kConstant(exog) > 0) throw new Error('There should not be a constant in the model')
  const n = exog.length
  const m = exog[0].length
  const { levels, codes } = encode(y)
  const L = levels.length
  const thresholdsOf = (params: readonly number[]) => {
    const th = [params[m]]
    for (let k = 1; k < L - 1; k++) th.push(th[k - 1] + Math.exp(params[m + k]))
    return th
  }
  const loglike = (params: number[]) => {
    const cut = [-Infinity, ...thresholdsOf(params), Infinity]
    const beta = params.slice(0, m)
    return sum(
      exog.map((row, i) => {
        const xb = dot(row, beta)
        const prob = Math.max(expit(cut[codes[i] + 1] - xb) - expit(cut[codes[i]] - xb), 0)
        return Math.log(prob + 1e-20)
      }),
    )
  }
  // Start from the null model: thresholds at the logits of the cumulative frequencies.
  let cumulative = 0
  const cutStart = levels.slice(0, -1).map((_, k) => {
    cumulative += codes.filter((c) => c === k).length / n
    return logOdds(Math.min(Math.max(cumulative, 0), 1))
  })
  const start = [...new Array<number>(m).fill(0), cutStart[0], ...cutStart.slice(1).map((c, k) => Math.log(c - cutStart[k]))]
  const res = fminBfgs(
    (p) => -loglike(p) / n,
    (p) => approxFprime(p, loglike).map((g) => -g / n),
    start,
    { maxiter },
  )
  const negHess = approxHess(res.x, loglike).map((row) => row.map((v) => -v))
  let cov: Matrix | null = null
  if (negHess.every((row) => row.every(Number.isFinite))) {
    const { values, vectors } = eigh(negHess)
    if (Math.min(...values) > 0) {
      const hinv = vectors.map((ri) => vectors.map((rj) => ri.reduce((s, v, k) => s + v * (1 / values[k]) * rj[k], 0)))
      cov = hinv.map((row, i) => row.map((v, j) => (v + hinv[j][i]) / 2))
    }
  }
  return {
    params: res.x,
    cov,
    bse: res.x.map((_, i) => (cov ? Math.sqrt(cov[i][i]) : NaN)),
    llf: loglike(res.x),
    converged: res.warnflag === 0,
    iterations: res.iterations,
    thresholds: thresholdsOf(res.x),
  }
}
