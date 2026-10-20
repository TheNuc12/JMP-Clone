import { describe, expect, it } from 'vitest'
import type { AnalysisColumn } from '../../api/types'
import { runAnalysis } from './index'
import { c4, d2, d3, makeSubgroups, movingRangeSigma, paramFloat, paramInt, pooledSigma } from './spc'

describe('control chart constants', () => {
  it('uses the tabulated range constants up to n = 25', () => {
    expect(d2(2)).toBe(1.128379)
    expect(d3(5)).toBe(0.864082)
    expect(d2(25)).toBe(3.930629)
  })

  it('integrates larger subgroups like the reference (scipy quad)', () => {
    expect(d2(30)).toBeCloseTo(4.085521688343026, 8)
    expect(d3(30)).toBeCloseTo(0.6926650954228557, 7)
    expect(d2(26)).toBeCloseTo(3.964315679522575, 8)
    expect(d3(26)).toBeCloseTo(0.704988314929651, 7)
  })

  it('computes c4 from the gamma function', () => {
    expect(c4(2)).toBeCloseTo(0.7978845608028655, 14)
    expect(c4(5)).toBeCloseTo(0.9399856029866253, 14)
    // Differences of large log-gamma values: agreement to ~1e-13.
    expect(c4(100)).toBeCloseTo(0.9974779760712214, 12)
  })
})

describe('subgroups and sigma', () => {
  const values = [1, NaN, 2, 4, 3, 7, 5]

  it('groups by label in order of first appearance, skipping missing values and labels', () => {
    const groups = makeSubgroups(values, ['b', 'b', 'a', null, 'b', 'a', 'c'])
    expect(groups.map((g) => [g.label, g.positions])).toEqual([
      ['b', [0, 4]],
      ['a', [2, 5]],
      ['c', [6]],
    ])
  })

  it('chunks consecutive finite values, or makes one group per value', () => {
    expect(makeSubgroups(values, null, 4).map((g) => g.values)).toEqual([[1, 2, 4, 3], [7, 5]])
    expect(makeSubgroups(values).length).toBe(6)
  })

  it('estimates within sigma from moving ranges or pooled subgroups', () => {
    expect(movingRangeSigma([1, 3, 2])).toBeCloseTo(1.5 / 1.128379, 12)
    expect(movingRangeSigma([5])).toBeNaN()
    expect(pooledSigma([[1, 3], [2, 4, 6], [9]])).toBeCloseTo(Math.sqrt((2 + 8) / 3), 12)
    expect(pooledSigma([[1]])).toBeNaN()
  })

  it('reads numeric params like Python float() / round()', () => {
    expect(paramFloat({ a: ' 7.5 ' }, 'a')).toBe(7.5)
    expect(paramFloat({ a: 'nan' }, 'a')).toBeNull()
    expect(paramFloat({ a: true }, 'a')).toBeNull()
    expect(paramFloat({}, 'a')).toBeNull()
    expect(paramInt({ a: 2.5 }, 'a')).toBe(2)
    expect(paramInt({ a: '3.5' }, 'a')).toBe(4)
  })
})

describe('speed', () => {
  const n = 10_000
  const column: AnalysisColumn = {
    name: 'y',
    modeling_type: 'continuous',
    values: Array.from({ length: n }, (_, i) => Math.sin(i) * 3 + (i % 7) / 10),
  }

  it('charts 10k rows quickly', () => {
    const run = (chartType: string) => {
      const start = performance.now()
      runAnalysis({ platform: 'control_chart', y: column, params: { chart_type: chartType, lsl: -4, usl: 4 }, options: { nelson_tests: true } })
      return performance.now() - start
    }
    run('imr') // warm up
    expect(run('imr')).toBeLessThan(200)
    expect(run('xbar_r')).toBeLessThan(200)
  })

  it('computes capability on 10k rows quickly', () => {
    const start = performance.now()
    runAnalysis({ platform: 'capability', y: column, params: { lsl: -4, usl: 4, target: 0 }, options: {} })
    expect(performance.now() - start).toBeLessThan(200)
  })
})
