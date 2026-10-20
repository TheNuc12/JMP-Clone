// Timing checks for Distribution and Fit Y by X on 10k rows (results are covered by the
// golden tests).

import { describe, expect, it } from 'vitest'
import type { AnalysisColumn, AnalyzeRequest } from '../../api/types'
import { defaultRng } from '../math/random'
import { runAnalysis } from '.'

const N = 10_000
const rng = defaultRng(42)
const x = Array.from({ length: N }, () => rng.uniform(0, 10))
const noise = Array.from({ length: N }, () => rng.uniform(-3, 3))
const y = x.map((v, i) => 2 + 1.5 * v + noise[i])
const g = x.map((_, i) => ['A', 'B', 'C', 'D'][i % 4])
const yo = x.map((v, i) => (v + noise[i] < 3 ? 'Low' : v + noise[i] < 7 ? 'Mid' : 'High'))
const yb = x.map((v, i) => (v + noise[i] > 5 ? 'Yes' : 'No'))

const cont = (name: string, values: number[]): AnalysisColumn => ({ name, modeling_type: 'continuous', values })
const cat = (name: string, values: string[], modeling_type: 'nominal' | 'ordinal' = 'nominal'): AnalysisColumn => ({ name, modeling_type, values })
const all = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]))

const cases: [string, AnalyzeRequest][] = [
  ['distribution continuous', { platform: 'distribution', y: cont('y', y), options: all(['fit_normal']) }],
  ['distribution categorical', { platform: 'distribution', y: cat('g', g), options: {} }],
  ['bivariate', { platform: 'fit_y_by_x', y: cont('y', y), x: cont('x', x), options: all(['fit_mean', 'fit_line', 'fit_quadratic', 'correlation']) }],
  [
    'oneway',
    {
      platform: 'fit_y_by_x',
      y: cont('y', y),
      x: cat('g', g),
      options: all(['means_anova', 'means_std', 'box_plots', 'unequal_variances', 'nonparametric']),
    },
  ],
  ['oneway tukey', { platform: 'fit_y_by_x', y: cont('y', y), x: cat('g', g), options: all(['tukey']) }],
  ['contingency', { platform: 'fit_y_by_x', y: cat('yb', yb), x: cat('g', g), options: {} }],
  ['logistic binary', { platform: 'fit_y_by_x', y: cat('yb', yb), x: cont('x', x), options: all(['odds_ratios']) }],
  ['logistic nominal', { platform: 'fit_y_by_x', y: cat('g', g), x: cont('x', x), options: {} }],
  ['logistic ordinal', { platform: 'fit_y_by_x', y: cat('yo', yo, 'ordinal'), x: cont('x', x), options: {} }],
]

describe('Distribution and Fit Y by X on 10k rows', () => {
  it.each(cases)('%s runs quickly', (_, req) => {
    runAnalysis(req) // warm up
    const start = performance.now()
    runAnalysis(req)
    const elapsed = performance.now() - start
    // Ordinal logistic uses BFGS with numerical derivatives, like statsmodels; Tukey's
    // studentized range integrals cost the same at any row count.
    expect(elapsed).toBeLessThan(['logistic ordinal', 'oneway tukey'].includes(_) ? 1500 : 200)
  })
})
