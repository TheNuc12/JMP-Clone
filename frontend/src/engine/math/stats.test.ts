import { describe, expect, it } from 'vitest'
import { bartlett, corrcoef, fisherExact, kruskal, levene, lilliefors, mean, median, pearsonr, rankdata, shapiro, std, sum, tukeyHsd, variance } from './stats'
import { expectAllClose, expectClose, reference } from './testing'

const ref = reference.stats

describe('numpy reductions', () => {
  it('sum, mean and var round exactly as numpy (pairwise summation)', () => {
    for (const r of ref.reductions) {
      expect(sum(r.x)).toBe(r.sum)
      expect(mean(r.x)).toBe(r.mean)
      expect(variance(r.x)).toBe(r.var)
      expect(variance(r.x, 1)).toBe(r.var1)
      expect(std(r.x, 1)).toBe(Math.sqrt(r.var1))
      expect(median(r.x)).toBe(r.median)
    }
    expect(sum([])).toBe(0)
    expect(variance([5], 1)).toBeNaN()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([1, NaN])).toBeNaN()
  })

  it('rankdata averages ties', () => {
    for (const { x, ranks } of ref.rankdata) expect(rankdata(x)).toEqual(ranks)
  })

  it('corrcoef', () => {
    expectAllClose(corrcoef(reference.linalg.corrcoef.x), reference.linalg.corrcoef.r, 1e-14, 1e-15, 'corrcoef')
  })
})

describe('tests vs scipy.stats / statsmodels', () => {
  it('shapiro', () => {
    for (const { x, w, p } of ref.shapiro) {
      expectClose(shapiro(x).statistic, w, 1e-13, 0, `shapiro W (n=${x.length})`)
      expectClose(shapiro(x).pvalue, p, 1e-11, 0, `shapiro p (n=${x.length})`)
    }
    expect(() => shapiro([1, 2])).toThrow()
  })

  it('lilliefors (asymptotic regime)', () => {
    for (const { x, d, p } of ref.lilliefors) {
      const res = lilliefors(x)
      expectClose(res.statistic, d, 1e-13, 0, `lilliefors D (n=${x.length})`)
      expectClose(res.pvalue, p, 1e-12, 0, `lilliefors p (n=${x.length})`)
    }
    expect(() => lilliefors([1, 2, 3])).toThrow('at least 4')
    expect(() => lilliefors([1, 2, 3, 4, 5])).toThrow(RangeError)
  })

  it('levene, bartlett and kruskal', () => {
    for (const g of ref.groups) {
      const label = `groups ${g.groups.map((x: number[]) => x.length).join('/')}`
      const check = (res: { statistic: number; pvalue: number }, [stat, p]: number[], name: string) => {
        expectClose(res.statistic, stat, 1e-12, 0, `${name} stat, ${label}`)
        expectClose(res.pvalue, p, 1e-11, 1e-300, `${name} p, ${label}`)
      }
      check(levene(g.groups, 'median'), g.levene_median, 'levene median')
      check(levene(g.groups, 'mean'), g.levene_mean, 'levene mean')
      check(bartlett(g.groups), g.bartlett, 'bartlett')
      check(kruskal(g.groups), g.kruskal, 'kruskal')
    }
  })

  it('tukey_hsd', { timeout: 60000 }, () => {
    for (const g of ref.groups) {
      const res = tukeyHsd(g.groups)
      const label = `tukey ${g.groups.map((x: number[]) => x.length).join('/')}`
      expectAllClose(res.statistic, g.tukey.statistic, 1e-14, 1e-14, `${label} diff`)
      expectAllClose(res.pvalue, g.tukey.pvalue, 0, 2e-11, `${label} p`)
      expectAllClose(res.low, g.tukey.low, 1e-10, 1e-12, `${label} low`)
      expectAllClose(res.high, g.tukey.high, 1e-10, 1e-12, `${label} high`)
    }
    expect(() => tukeyHsd([[1, 2], [3]])).toThrow('greater than one')
  })

  it('fisher_exact', () => {
    for (const row of ref.fisher) {
      for (const alt of ['less', 'greater', 'two-sided'] as const) {
        expectClose(fisherExact(row.table, alt).pvalue, row[alt], 1e-12, 0, `fisher ${alt} ${JSON.stringify(row.table)}`)
      }
    }
  })

  it('pearsonr', () => {
    for (const { x, y, r, p } of ref.pearson) {
      const res = pearsonr(x, y)
      expectClose(res.statistic, r, 1e-14, 0, `pearson r (n=${x.length})`)
      expectClose(res.pvalue, p, 1e-12, 0, `pearson p (n=${x.length})`)
    }
    expect(pearsonr([1, 1, 1], [1, 2, 3]).statistic).toBeNaN()
    expect(pearsonr([1, 2], [3, 1])).toEqual({ statistic: -1, pvalue: 1 })
  })
})
