import { describe, expect, it } from 'vitest'
import { chi2, f, hypergeom, norm, studentizedRange, t } from './distributions'
import { quad } from './integrate'
import { brentq } from './optimize'
import { expectClose, reference } from './testing'

const ref = reference.distributions

describe('distributions vs scipy.stats', () => {
  it('normal', () => {
    for (const [x, pdf, cdf, sf] of ref.norm) {
      expectClose(norm.pdf(x), pdf, 1e-14, 0, `norm.pdf(${x})`)
      expectClose(norm.cdf(x), cdf, 1e-14, 0, `norm.cdf(${x})`)
      expectClose(norm.sf(x), sf, 1e-14, 0, `norm.sf(${x})`)
    }
    for (const [x, loc, scale, pdf, cdf, sf] of ref.norm_loc_scale) {
      expectClose(norm.pdf(x, loc, scale), pdf, 1e-14, 0, `norm.pdf(${x}, ${loc}, ${scale})`)
      expectClose(norm.cdf(x, loc, scale), cdf, 1e-14, 0, 'norm.cdf loc/scale')
      expectClose(norm.sf(x, loc, scale), sf, 1e-14, 0, 'norm.sf loc/scale')
    }
    for (const [p, x, xi] of ref.norm_ppf) {
      expectClose(norm.ppf(p), x, 1e-14, 0, `norm.ppf(${p})`)
      expectClose(norm.isf(p), xi, 1e-14, 0, `norm.isf(${p})`)
    }
  })

  it('Student t', () => {
    for (const [x, df, pdf, cdf, sf] of ref.t) {
      expectClose(t.pdf(x, df), pdf, 1e-11, 0, `t.pdf(${x}, ${df})`)
      // The incomplete beta continued fraction needs ~√df terms near |t| ≈ √3 and accumulates
      // rounding: ~1e-11 relative at df = 1e5, ~5e-10 at df = 1e7.
      const rtol = df >= 1e6 ? 1e-9 : 2e-11
      expectClose(t.cdf(x, df), cdf, rtol, 0, `t.cdf(${x}, ${df})`)
      expectClose(t.sf(x, df), sf, rtol, 0, `t.sf(${x}, ${df})`)
    }
    for (const [p, df, x, xi] of ref.t_ppf) {
      const rtol = df >= 1e6 ? 1e-9 : 5e-12 // see the cdf note above
      expectClose(t.ppf(p, df), x, rtol, 0, `t.ppf(${p}, ${df})`)
      expectClose(t.isf(p, df), xi, rtol, 0, `t.isf(${p}, ${df})`)
      if (df < 1e6) expectClose(t.cdf(t.ppf(p, df), df), p, 1e-11, 0, `t.cdf(t.ppf(${p}, ${df}))`)
    }
  })

  it('chi-square', () => {
    for (const [x, df, pdf, cdf, sf] of ref.chi2) {
      // scipy's chi2.pdf subtracts logs of order 1e6 at df = 1e5, so it is only good to ~1e-11 there.
      expectClose(chi2.pdf(x, df), pdf, df > 1000 ? 5e-11 : 1e-12, 0, `chi2.pdf(${x}, ${df})`)
      expectClose(chi2.cdf(x, df), cdf, 1e-12, 1e-300, `chi2.cdf(${x}, ${df})`)
      expectClose(chi2.sf(x, df), sf, 1e-12, 1e-300, `chi2.sf(${x}, ${df})`)
    }
    for (const [p, df, x, xi] of ref.chi2_ppf) {
      expectClose(chi2.ppf(p, df), x, 1e-12, 0, `chi2.ppf(${p}, ${df})`)
      expectClose(chi2.isf(p, df), xi, 1e-12, 0, `chi2.isf(${p}, ${df})`)
    }
  })

  it('F', () => {
    for (const [x, d1, d2, pdf, cdf, sf] of ref.f) {
      expectClose(f.pdf(x, d1, d2), pdf, 1e-12, 0, `f.pdf(${x}, ${d1}, ${d2})`)
      expectClose(f.cdf(x, d1, d2), cdf, 1e-12, 1e-300, `f.cdf(${x}, ${d1}, ${d2})`)
      expectClose(f.sf(x, d1, d2), sf, 1e-12, 1e-300, `f.sf(${x}, ${d1}, ${d2})`)
    }
    for (const [p, d1, d2, x, xi] of ref.f_ppf) {
      expectClose(f.ppf(p, d1, d2), x, 1e-11, 0, `f.ppf(${p}, ${d1}, ${d2})`)
      // scipy's far-tail upper F quantiles are inaccurate (its own sf at its isf misses q by
      // up to 1e-3), so there we check the round trip instead.
      if (p < 1e-3) expectClose(f.sf(f.isf(p, d1, d2), d1, d2), p, 1e-12, 0, `f.sf(f.isf(${p}, ${d1}, ${d2}))`)
      else expectClose(f.isf(p, d1, d2), xi, 1e-11, 0, `f.isf(${p}, ${d1}, ${d2})`)
    }
    // F(1, 1) is the square of a Cauchy variate: P(F > x) = q ⇔ x = cot²(πq/2).
    for (const q of [1e-14, 1e-6, 1e-3, 0.3]) expectClose(f.isf(q, 1, 1), 1 / Math.tan((Math.PI * q) / 2) ** 2, 1e-13, 0, `f.isf(${q}, 1, 1)`)
    // F(2, d) has sf(x) = (1 + 2x/d)^(−d/2).
    for (const q of [1e-14, 1e-6, 0.2]) expectClose(f.isf(q, 2, 5), (5 / 2) * (q ** (-2 / 5) - 1), 1e-13, 0, `f.isf(${q}, 2, 5)`)
  })

  it('studentized range', { timeout: 60000 }, () => {
    for (const [q, k, df, cdf, sf] of ref.studentized_range) {
      expectClose(studentizedRange.cdf(q, k, df), cdf, 0, 2e-11, `srange.cdf(${q}, ${k}, ${df})`)
      expectClose(studentizedRange.sf(q, k, df), sf, 0, 2e-11, `srange.sf(${q}, ${k}, ${df})`)
    }
    for (const [p, k, df, q] of ref.studentized_range_ppf) expectClose(studentizedRange.ppf(p, k, df), q, 1e-10, 0, `srange.ppf(${p}, ${k}, ${df})`)
  })

  it('hypergeometric', () => {
    for (const [k, M, n, N, pmf, cdf, sf] of ref.hypergeom) {
      expectClose(hypergeom.pmf(k, M, n, N), pmf, 1e-12, 0, `hypergeom.pmf(${k}, ${M}, ${n}, ${N})`)
      expectClose(hypergeom.cdf(k, M, n, N), cdf, 1e-12, 1e-300, `hypergeom.cdf(${k}, ${M}, ${n}, ${N})`)
      expectClose(hypergeom.sf(k, M, n, N), sf, 1e-12, 1e-300, `hypergeom.sf(${k}, ${M}, ${n}, ${N})`)
    }
  })
})

describe('quad vs scipy.integrate.quad', () => {
  const pdf = (x: number) => norm.pdf(x)
  const ncdf = (x: number) => norm.cdf(x)

  it('integrates polynomials up to degree 31 exactly with one Kronrod panel', () => {
    for (let m = 0; m <= 15; m++) expectClose(quad((x) => x ** (2 * m), -1, 1).value, 2 / (2 * m + 1), 1e-14, 0, `x^${2 * m}`)
  })

  it('matches the control chart constant integrals', () => {
    for (const { n, d2, range_cdf_1_5, er2 } of reference.integrate.spc) {
      expectClose(quad((x) => 1 - ncdf(x) ** n - norm.sf(x) ** n, -Infinity, Infinity).value, d2, 1e-10, 0, `d2(${n})`)
      const cdf = (r: number) => n * quad((x) => pdf(x) * (ncdf(x + r) - ncdf(x)) ** (n - 1), -12, 12, { limit: 400 }).value
      expectClose(cdf(1.5), range_cdf_1_5, 1e-9, 1e-15, `range cdf(${n})`)
      expectClose(2 * quad((r) => r * (1 - cdf(r)), 0, 20, { limit: 400 }).value, er2, 1e-9, 0, `E[R²](${n})`)
    }
  })

  it('handles infinite limits and endpoint singularities', () => {
    const fns: Record<string, [(x: number) => number, number, number]> = {
      gauss: [(x) => Math.exp(-x * x), -Infinity, Infinity],
      inv_sq: [(x) => 1 / (1 + x * x), 0, Infinity],
      sqrt: [Math.sqrt, 0, 1],
      log: [Math.log, 0, 1],
      lower_tail: [Math.exp, -Infinity, 0],
    }
    for (const { name, value } of reference.integrate.generic) {
      const [fn, a, b] = fns[name]
      expectClose(quad(fn, a, b).value, value, 1e-9, 0, name)
    }
  })
})

describe('brentq', () => {
  it('finds roots to the requested tolerance', () => {
    expect(brentq((x) => x * x - 2, 0, 2, { xtol: 1e-15 })).toBeCloseTo(Math.SQRT2, 14)
    expect(brentq((x) => Math.cos(x) - x, 0, 1)).toBeCloseTo(0.7390851332151607, 11)
    expect(() => brentq((x) => x * x + 1, -1, 1)).toThrow()
  })
})
