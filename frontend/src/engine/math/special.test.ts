import { describe, expect, it } from 'vitest'
import {
  betainc,
  betaincc,
  betaincinv,
  erf,
  erfc,
  expit,
  gamma,
  gammainc,
  gammaincc,
  gammainccinv,
  gammaincinv,
  gammaln,
  logsumexp,
} from './special'
import { expectClose, reference } from './testing'

const ref = reference.special

describe('special functions vs scipy.special', () => {
  it('gammaln and gamma', () => {
    for (const [x, y] of ref.gammaln) expectClose(gammaln(x), y, 2e-15, 4e-15, `gammaln(${x})`)
    for (const [x, y] of ref.gamma) expectClose(gamma(x), y, 2e-13, 0, `gamma(${x})`)
  })

  it('erf and erfc', () => {
    for (const [x, y] of ref.erf) expectClose(erf(x), y, 2e-16, 1e-300, `erf(${x})`)
    for (const [x, y] of ref.erfc) expectClose(erfc(x), y, 1e-14, 0, `erfc(${x})`)
  })

  it('regularized incomplete beta and its inverse', () => {
    for (const [a, b, x, lower, upper] of ref.betainc) {
      expectClose(betainc(a, b, x), lower, 1e-12, 1e-300, `betainc(${a}, ${b}, ${x})`)
      expectClose(betaincc(a, b, x), upper, 1e-12, 1e-300, `betaincc(${a}, ${b}, ${x})`)
    }
    for (const [a, b, p, x] of ref.betaincinv) expectClose(betaincinv(a, b, p), x, 1e-12, 1e-300, `betaincinv(${a}, ${b}, ${p})`)
  })

  it('regularized incomplete gamma and its inverses', () => {
    for (const [a, x, lower, upper] of ref.gammainc) {
      expectClose(gammainc(a, x), lower, 1e-13, 1e-300, `gammainc(${a}, ${x})`)
      expectClose(gammaincc(a, x), upper, 1e-13, 1e-300, `gammaincc(${a}, ${x})`)
    }
    for (const [a, p, x, xc] of ref.gammaincinv) {
      expectClose(gammaincinv(a, p), x, 1e-12, 0, `gammaincinv(${a}, ${p})`)
      expectClose(gammainccinv(a, p), xc, 1e-12, 0, `gammainccinv(${a}, ${p})`)
    }
  })

  it('expit and logsumexp', () => {
    for (const [x, y] of ref.expit) expectClose(expit(x), y, 1e-15, 0, `expit(${x})`)
    for (const [v, y] of ref.logsumexp) expectClose(logsumexp(v), y, 1e-15, 0, `logsumexp(${v})`)
    expect(logsumexp([])).toBe(-Infinity)
  })
})
