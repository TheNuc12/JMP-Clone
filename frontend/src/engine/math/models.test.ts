import { describe, expect, it } from 'vitest'
import { kConstant, logit, mnlogit, ols, olsPredict, orderedLogit } from './models'
import { defaultRng } from './random'
import { expectAllClose, expectClose, reference } from './testing'

const ref = reference.models

describe('models vs statsmodels', () => {
  it('OLS', () => {
    for (const c of ref.ols) {
      const label = `ols p=${c.x[0].length} n=${c.x.length}`
      const fit = ols(c.y, c.x)
      expectAllClose(fit.params, c.params, 1e-12, 0, `${label} params`)
      expectAllClose(fit.bse, c.bse, 1e-11, 0, `${label} bse`)
      expectAllClose(fit.tvalues, c.tvalues, 1e-12, 0, `${label} t`)
      expectAllClose(fit.pvalues, c.pvalues, 1e-10, 0, `${label} p`)
      expect([fit.dfModel, fit.dfResid]).toEqual([c.df_model, c.df_resid])
      // With zero residual df the residuals are rounding noise (~1e-20).
      expectClose(fit.ssr, c.ssr, 1e-13, 1e-12, `${label} ssr`)
      for (const key of ['ess', 'centered_tss', 'rsquared', 'rsquared_adj'] as const) {
        const ours = { ess: fit.ess, centered_tss: fit.centeredTss, rsquared: fit.rsquared, rsquared_adj: fit.rsquaredAdj }[key]
        expectClose(ours, c[key], 1e-13, 0, `${label} ${key}`)
      }
      const pred = olsPredict(fit, c.xnew)
      expectAllClose(pred.mean, c.pred_mean, 1e-12, 0, `${label} predicted mean`)
      expectAllClose(pred.se, c.pred_se, 1e-12, 0, `${label} predicted se`)
      expectAllClose(pred.lower, c.pred_lower, 1e-12, 0, `${label} lower`)
      expectAllClose(pred.upper, c.pred_upper, 1e-12, 0, `${label} upper`)
    }
    expect(kConstant([[1, 2], [1, 3]])).toBe(1)
    expect(kConstant([[0, 2], [0, 3]])).toBe(0)
    expect(kConstant([[1, 0], [0, 1], [1, 0]])).toBe(1) // dummies spanning the constant
  })

  it('Logit, including separated data', () => {
    for (const c of ref.logit) {
      const label = `logit n=${c.x.length}`
      const fit = logit(c.y, c.x, { maxiter: c.maxiter })
      expect(fit.converged, label).toBe(c.converged)
      expect(fit.iterations, label).toBe(c.iterations)
      expect(fit.perfectPrediction, label).toBe(c.warnings.includes('PerfectSeparationWarning'))
      expectAllClose(fit.params, c.params, 1e-12, 0, `${label} params`)
      expectAllClose(fit.bse, c.bse, 1e-11, 0, `${label} bse`)
      expectClose(fit.llf, c.llf, 1e-12, 0, `${label} llf`)
    }
  })

  it('MNLogit', () => {
    for (const c of ref.mnlogit) {
      const label = `mnlogit n=${c.x.length}`
      const fit = mnlogit(c.codes, c.x, { maxiter: c.maxiter })
      expect(fit.converged).toBe(c.converged)
      expectAllClose(fit.params, c.params, 1e-12, 0, `${label} params`)
      expectAllClose(fit.bse, c.bse, 1e-11, 0, `${label} bse`)
      expectAllClose(fit.cov, c.cov, 1e-11, 0, `${label} cov`)
      expectClose(fit.llf, c.llf, 1e-13, 0, `${label} llf`)
      expectAllClose(fit.predict(c.predict_x), c.predict, 1e-12, 0, `${label} predict`)
    }
  })

  it('OrderedModel (logit, BFGS)', () => {
    for (const c of ref.ordered) {
      const label = `ordered n=${c.x.length}`
      const fit = orderedLogit(c.y, c.x, { maxiter: 1000 })
      expect(fit.converged).toBe(!c.warnings.includes('ConvergenceWarning'))
      // The same BFGS path as statsmodels: parameters agree far below its gtol of 1e-5.
      expectAllClose(fit.params, c.params, 1e-7, 1e-9, `${label} params`)
      expectAllClose(fit.thresholds, c.thresholds, 1e-7, 1e-9, `${label} thresholds`)
      expectClose(fit.llf, c.llf, 1e-13, 0, `${label} llf`)
      // statsmodels' covariance inverts a finite-difference Hessian whose rounding noise alone moves
      // it by up to ~1e-4 (relative) for parameters near zero, so only that agreement is possible.
      expectAllClose(fit.cov, c.cov, 3e-4, 0, `${label} cov`)
    }
    expect(() => orderedLogit([0, 1, 1, 0], [[1], [1], [1], [1]])).toThrow('constant')
  })
})

describe('models are fast enough for interactive use', () => {
  const rng = defaultRng(7)
  const n = 10_000
  const X = Array.from({ length: n }, () => [1, ...Array.from({ length: 9 }, () => rng.uniform(-2, 2))])
  const eta = X.map((row) => row.reduce((s, v, j) => s + v * (j % 3 === 0 ? 0.4 : -0.2), 0))

  it('OLS on 10,000 × 10', () => {
    const y = eta.map((e) => e + rng.uniform(-1, 1))
    const start = performance.now()
    const fit = ols(y, X)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(fit.rank).toBe(10)
  })

  it('Logit on 10,000 rows', () => {
    const y = eta.map((e) => (rng.random() < 1 / (1 + Math.exp(-e)) ? 1 : 0))
    const start = performance.now()
    const fit = logit(y, X)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(fit.converged).toBe(true)
  })

  it('OrderedModel on 10,000 rows', () => {
    const y = eta.map((e) => Math.min(3, Math.max(0, Math.floor(e + 2 * rng.uniform(-1, 1) + 2))))
    const start = performance.now()
    const fit = orderedLogit(y, X.map((row) => row.slice(1, 4)), { maxiter: 1000 })
    expect(performance.now() - start).toBeLessThan(2000)
    expect(fit.converged).toBe(true)
  })
})
