import { describe, expect, it } from 'vitest'
import { cholesky, crossprod, eigh, inv, lstsq, LinAlgError, matmul, matrixRank, pinv, qr, slogdet, solve, svd, transpose } from './linalg'
import { expectAllClose, expectClose, reference } from './testing'

const ref = reference.linalg

describe('linalg vs numpy.linalg', () => {
  it('svd, rank, pinv and lstsq', () => {
    ref.cases.forEach((c: Record<string, number[][] & number[]>, i: number) => {
      const { u, s, v } = svd(c.a)
      expectAllClose(s, c.singular_values, 1e-13, 1e-14, `svd[${i}].s`)
      // A = U diag(s) Vᵀ
      const usv = u.map((row) => v.map((vrow) => row.reduce((acc, uk, k) => acc + uk * s[k] * vrow[k], 0)))
      expectAllClose(usv, c.a, 0, 1e-13, `svd[${i}] reconstruction`)
      expect(matrixRank(c.a)).toBe(c.rank)
      expectAllClose(pinv(c.a), c.pinv, 1e-11, 1e-13, `pinv[${i}]`)
      expectAllClose(lstsq(c.a, c.lstsq_b).x, c.lstsq_x, 1e-11, 1e-13, `lstsq[${i}]`)
    })
  })

  it('qr follows LAPACK sign conventions', () => {
    for (const [label, cases] of [['cases', ref.cases.filter((c: { q?: unknown }) => c.q)], ['contrasts', ref.contrasts]] as const) {
      cases.forEach((c: { a: number[][]; q: number[][]; r: number[][] }, i: number) => {
        const { q, r } = qr(c.a)
        expectAllClose(q, c.q, 0, 1e-13, `${label}[${i}].q`)
        expectAllClose(r, c.r, 0, 1e-13, `${label}[${i}].r`)
      })
    }
  })

  it('inv, solve and slogdet', () => {
    for (const c of ref.cases.filter((x: { inv?: unknown }) => x.inv)) {
      expectAllClose(inv(c.a), c.inv, 1e-12, 1e-14, 'inv')
      expectAllClose(solve(c.a, c.solve_b), c.solve_x, 1e-12, 1e-14, 'solve')
      const { sign, logabsdet } = slogdet(c.a)
      expect(sign).toBe(c.det_sign)
      expectClose(logabsdet, c.logdet, 1e-13, 1e-14, 'logdet')
    }
    expect(() => inv(ref.singular_inv)).toThrow(LinAlgError)
    expect(() => solve(ref.singular_inv, [1, 1])).toThrow('Singular matrix')
    expect(slogdet(ref.singular_inv)).toEqual({ sign: 0, logabsdet: -Infinity })
  })

  it('eigh and cholesky', () => {
    expectAllClose(eigh(ref.eigh.a).values, ref.eigh.values, 1e-12, 1e-13, 'eigh')
    const { values, vectors } = eigh(ref.eigh.a)
    const recon = matmul(matmul(vectors, values.map((d, i) => values.map((_, j) => (i === j ? d : 0)))), transpose(vectors))
    expectAllClose(recon, ref.eigh.a, 0, 1e-12, 'eigh reconstruction')
    const spd = crossprod(ref.cases[1].a)
    const l = cholesky(spd)
    expectAllClose(matmul(l, transpose(l)), spd, 1e-14, 1e-14, 'cholesky')
    expect(() => cholesky([[1, 2], [2, 1]])).toThrow(LinAlgError)
  })
})
