import { describe, expect, it } from 'vitest'
import type { Column } from '../../state/store'
import { addEffects, crossEffects, effectName, isValidEffect, macroEffects } from './effects'

const col = (id: string, modelingType: Column['modelingType']): Column => ({
  id,
  name: id.toUpperCase(),
  dataType: modelingType === 'continuous' ? 'numeric' : 'character',
  modelingType,
  values: [],
  props: {},
})
const byId = new Map([col('a', 'continuous'), col('b', 'continuous'), col('g', 'nominal')].map((c) => [c.id, c]))

describe('effects', () => {
  it('adds without duplicates regardless of order', () => {
    expect(addEffects([['a'], ['a', 'b']], [['a'], ['b', 'a'], ['b']])).toEqual([['a'], ['a', 'b'], ['b']])
  })

  it('crosses like JMP', () => {
    expect(crossEffects(['b'], [['a'], ['g']])).toEqual([['a', 'b'], ['g', 'b']])
    expect(crossEffects(['a', 'g'], [])).toEqual([['a', 'g']])
    expect(crossEffects([], [['a'], ['g']])).toEqual([['a', 'g']])
    expect(crossEffects(['a'], [])).toEqual([])
  })

  it('allows powers of continuous columns only', () => {
    expect(isValidEffect(['a', 'a'], byId)).toBe(true)
    expect(isValidEffect(['g', 'g'], byId)).toBe(false)
    expect(isValidEffect(['missing'], byId)).toBe(false)
  })

  it('expands macros', () => {
    const name = (effects: string[][]) => effects.map((e) => effectName(e, byId))
    expect(name(macroEffects('full_factorial', ['a', 'b', 'g'], byId))).toEqual(['A', 'B', 'G', 'A*B', 'A*G', 'B*G', 'A*B*G'])
    expect(name(macroEffects('factorial_2', ['a', 'b', 'g'], byId))).toEqual(['A', 'B', 'G', 'A*B', 'A*G', 'B*G'])
    expect(name(macroEffects('response_surface', ['a', 'g'], byId))).toEqual(['A', 'G', 'A*G', 'A*A'])
    expect(name(macroEffects('polynomial_2', ['a', 'b'], byId))).toEqual(['A', 'B', 'A*A', 'B*B'])
  })
})
