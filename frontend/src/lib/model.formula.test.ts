import { describe, expect, it } from 'vitest'
import type { LinearModelSpec } from '../api/types'
import type { Column } from '../state/store'
import { evaluateFormula } from './formula'
import { predictionFormula, predictRows } from './model'

// Fit Model's saved prediction formula must reproduce its own predictions when the
// formula engine evaluates it.

const column = (name: string, values: (number | string | null)[], categorical = false): Column => ({
  id: name,
  name,
  dataType: categorical ? 'character' : 'numeric',
  modelingType: categorical ? 'nominal' : 'continuous',
  values,
  props: {},
})

const columns = [
  column('body height', [60, 65.5, 58, null, 70, 62]),
  column('machine', ['A', 'B', 'C', 'B', null, 'A'], true),
  column('temp', [180, 175.5, 190, 185, 170, 200]),
]

const spec: LinearModelSpec = {
  response: 'yield',
  factors: [
    { name: 'body height', kind: 'continuous', min: 58, max: 70, mean: 63.1 },
    { name: 'machine', kind: 'categorical', levels: ['A', 'B', 'C'] },
    { name: 'temp', kind: 'continuous', min: 170, max: 200, mean: 183.4 },
  ],
  terms: [
    { label: 'Intercept', parts: [] },
    { label: 'body height', parts: [{ factor: 'body height', center: 0, power: 1 }] },
    { label: 'machine[A]', parts: [{ factor: 'machine', center: 0, power: 1, level: 'A' }] },
    { label: 'machine[B]', parts: [{ factor: 'machine', center: 0, power: 1, level: 'B' }] },
    {
      label: '(temp-183.4)*machine[B]',
      parts: [
        { factor: 'temp', center: 183.4, power: 1 },
        { factor: 'machine', center: 0, power: 1, level: 'B' },
      ],
    },
    { label: '(temp-183.4)*(temp-183.4)', parts: [{ factor: 'temp', center: 183.4, power: 2 }] },
  ],
  coef: [12.5, 0.75, -2.25, 1.5, 0.125, -0.0125],
  cov: Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0))),
  df_error: 20,
  rmse: 1,
}

describe('saved prediction formula', () => {
  it('evaluates to the same values as the model', () => {
    const rows = columns[0].values.map((_, i) => i)
    const expected = predictRows(spec, new Map(columns.map((c) => [c.name, c])), rows)
    const actual = evaluateFormula(predictionFormula(spec), columns, rows.length)
    expect(actual).toHaveLength(expected.length)
    actual.forEach((v, i) => {
      if (expected[i] === null) expect(v).toBeNull()
      else expect(v as number).toBeCloseTo(expected[i]!, 9)
    })
  })
})
