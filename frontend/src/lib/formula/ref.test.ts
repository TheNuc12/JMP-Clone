import { describe, expect, it } from 'vitest'
import { formulaRef } from '.'

describe('formulaRef', () => {
  it('quotes names that are not identifiers', () => {
    expect(formulaRef('height')).toBe(':height')
    expect(formulaRef('yield_pct')).toBe(':yield_pct')
    expect(formulaRef('Body mass')).toBe(':"Body mass"')
    expect(formulaRef('a"b\\c')).toBe(':"a\\"b\\\\c"')
  })
})
