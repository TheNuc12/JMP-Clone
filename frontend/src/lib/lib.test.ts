import { describe, expect, it } from 'vitest'
import { formatCell, formatNumber, formatPValue } from './format'
import { labelOf, levelsOf } from './levels'
import { jitter, rowNoise } from './random'
import { binCount, binIndex, boxStats, kernelSmooth, linearFit, niceBins, quantileSorted } from './stats'

describe('levels', () => {
  it('labels numbers the way the backend expects', () => {
    expect(labelOf(12)).toBe('12')
    expect(labelOf(12.5)).toBe('12.5')
    expect(labelOf(null)).toBeNull()
    expect(labelOf(NaN)).toBeNull()
    expect(labelOf('F')).toBe('F')
  })

  it('orders numeric labels numerically and others as strings', () => {
    expect(levelsOf(['10', '9', '2', null, '9'])).toEqual(['2', '9', '10'])
    expect(levelsOf(['b', 'B', 'a'])).toEqual(['B', 'a', 'b'])
    expect(levelsOf(['10', 'x', '9'])).toEqual(['10', '9', 'x'])
  })
})

describe('format', () => {
  it('shows up to seven significant digits', () => {
    expect(formatNumber(3.98624218)).toBe('3.986242')
    expect(formatNumber(12658.6812)).toBe('12658.68')
    expect(formatNumber(40)).toBe('40')
    expect(formatNumber(-0.000123456789)).toBe('-0.0001234568')
    expect(formatNumber(1.5e-12)).toBe('1.5e-12')
  })

  it('formats p-values JMP style', () => {
    expect(formatPValue(0.00001)).toBe('<.0001*')
    expect(formatPValue(0.0312)).toBe('0.0312*')
    expect(formatPValue(0.4417)).toBe('0.4417')
  })

  it('applies cell formats', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(39, 'integer')).toBe('39')
    expect(formatCell(0.125, 'percent')).toBe('12.5%')
    expect(formatCell('Model', 'text')).toBe('Model')
  })
})

describe('stats', () => {
  const tenValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('uses the (n+1)p quantile definition', () => {
    expect(quantileSorted(tenValues, 0.25)).toBeCloseTo(2.75)
    expect(quantileSorted(tenValues, 0.5)).toBeCloseTo(5.5)
    expect(quantileSorted(tenValues, 0.75)).toBeCloseTo(8.25)
    expect(quantileSorted(tenValues, 0)).toBe(1)
    expect(quantileSorted(tenValues, 1)).toBe(10)
  })

  it('stops whiskers at the last point inside 1.5 IQR', () => {
    const b = boxStats([...tenValues, 40])!
    expect(b.upper_whisker).toBe(10)
    expect(b.lower_whisker).toBe(1)
    expect(b.median).toBe(6)
  })

  it('fits a line exactly when the data are linear', () => {
    const fit = linearFit([1, 2, 3, 4], [3, 5, 7, 9])!
    expect(fit.intercept).toBeCloseTo(1)
    expect(fit.slope).toBeCloseTo(2)
    expect(fit.r2).toBeCloseTo(1)
    expect(linearFit([1, 1], [2, 3])).toBeNull()
  })

  it('smooths linear data back onto the line', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i)
    const s = kernelSmooth(xs, xs.map((x) => 2 * x + 1), 1.5, 20)
    s.x.forEach((x, i) => expect(s.y[i]).toBeCloseTo(2 * x + 1, 6))
  })

  it('builds nice bins that cover every value', () => {
    const values = [52.9, 55.1, 60.2, 69.8]
    const bins = niceBins(values)
    expect(bins.start).toBeLessThanOrEqual(52.9)
    expect(bins.end).toBeGreaterThanOrEqual(69.8)
    expect([1, 2, 5, 10]).toContain(bins.size)
    const n = binCount(bins)
    for (const v of values) {
      const i = binIndex(v, bins)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(n)
    }
    expect(binIndex(bins.end, bins)).toBe(n - 1)
  })
})

describe('random', () => {
  it('is deterministic per row and bounded', () => {
    expect(rowNoise(5)).toBe(rowNoise(5))
    expect(rowNoise(5, 1)).not.toBe(rowNoise(5, 2))
    for (let r = 0; r < 500; r++) {
      const j = jitter(r, 0.5)
      expect(j).toBeGreaterThanOrEqual(-0.25)
      expect(j).toBeLessThan(0.25)
    }
  })
})

describe('kernelSmooth', () => {
  it('is smooth and stays near the data for sparse noisy points', () => {
    const xs = [160, 165, 171, 174, 180, 183, 190, 197]
    const ys = [74, 82, 77, 85, 79, 86, 81, 88]
    const s = kernelSmooth(xs, ys)
    const steps = s.y.slice(1).map((y, i) => Math.abs(y - s.y[i]))
    expect(Math.max(...steps)).toBeLessThan(0.5) // no jumps between neighbouring grid points
    expect(Math.min(...s.y)).toBeGreaterThan(Math.min(...ys))
    expect(Math.max(...s.y)).toBeLessThan(Math.max(...ys))
  })
})
