import { describe, expect, it } from 'vitest'
import { formatF, formatG, npRound, pyRound, pyStr } from './pyformat'

describe('formatG matches Python', () => {
  it.each([
    [62.55, 6, '62.55'],
    [-127.0844, 5, '-127.08'],
    [0.0001234, 3, '0.000123'],
    [0.00001234, 3, '1.23e-05'],
    [123456789, 5, '1.2346e+08'],
    [100000, 6, '100000'],
    [1000000, 6, '1e+06'],
    [3.0, 6, '3'],
    [0, 6, '0'],
    [-0.5, 1, '-0.5'],
    [9.99999, 3, '10'],
    [99999.5, 5, '1e+05'],
    [1.5e300, 4, '1.5e+300'],
    [NaN, 6, 'nan'],
    [Infinity, 6, 'inf'],
  ])('%s %.0s', (x, p, expected) => {
    expect(formatG(x as number, p as number)).toBe(expected)
  })
})

describe('pyStr matches str()', () => {
  it.each([
    [12.5, '12.5'],
    [12.0, '12'],
    [0.1, '0.1'],
    [1e-5, '1e-05'],
    [1.5e16, '1.5e+16'],
    [123456789012345.6, '123456789012345.6'],
    [-0.000123, '-0.000123'],
  ])('%s', (x, expected) => {
    expect(pyStr(x as number)).toBe(expected)
  })

  it('keeps .0 on floats when asked', () => {
    expect(pyStr(12, false)).toBe('12.0')
  })
})

describe('rounding', () => {
  it('pyRound rounds from the exact binary value, ties to even', () => {
    expect(pyRound(2.675, 2)).toBe(2.67)
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(0.375, 2)).toBe(0.38)
    expect(pyRound(2.5)).toBe(2)
    expect(pyRound(3.5)).toBe(4)
    expect(pyRound(-2.5)).toBe(-2)
    expect(pyRound(1.23456, 3)).toBe(1.235)
  })

  it('npRound scales first', () => {
    expect(npRound(2.5)).toBe(2)
    expect(npRound(0.125, 2)).toBe(0.12)
    expect(npRound(2.675, 2)).toBe(2.68) // 2.675 * 100 is exactly 267.5 in floating point
    expect(npRound(1234.5, -1)).toBe(1230)
  })

  it('formatF', () => {
    expect(formatF(1.005, 2)).toBe('1.00')
    expect(formatF(2.5, 0)).toBe('3')
  })
})
