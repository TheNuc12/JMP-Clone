import { describe, expect, it } from 'vitest'
import type { LinearModelSpec, ReportNode } from '../api/types'
import type { Column } from '../state/store'
import { designRow, findModel, predict, predictionFormula, predictRows, tCdf, tQuantile } from './model'

const spec: LinearModelSpec = {
  response: 'y',
  factors: [
    { name: 'height', kind: 'continuous', min: 50, max: 70, mean: 60 },
    { name: 'sex', kind: 'categorical', levels: ['F', 'M'] },
    { name: 'temp', kind: 'continuous', min: 0, max: 10, mean: 5 },
  ],
  terms: [
    { label: 'Intercept', parts: [] },
    { label: 'height', parts: [{ factor: 'height', center: 0, power: 1 }] },
    { label: 'sex[F]', parts: [{ factor: 'sex', center: 0, power: 1, level: 'F' }] },
    {
      label: '(height-60)*sex[F]',
      parts: [
        { factor: 'height', center: 60, power: 1 },
        { factor: 'sex', center: 0, power: 1, level: 'F' },
      ],
    },
    { label: '(temp-5)*(temp-5)', parts: [{ factor: 'temp', center: 5, power: 2 }] },
  ],
  coef: [100, 2.5, -4, 0.5, -1.25],
  cov: [
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 0, 1],
  ],
  df_error: 10,
  rmse: 2,
}

describe('t distribution', () => {
  it('matches reference quantiles', () => {
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228138852, 6)
    expect(tQuantile(0.975, 1)).toBeCloseTo(12.70620474, 5)
    expect(tQuantile(0.975, 30)).toBeCloseTo(2.042272456, 6)
    expect(tQuantile(0.025, 30)).toBeCloseTo(-2.042272456, 6)
    expect(tCdf(0, 5)).toBeCloseTo(0.5, 12)
    expect(tCdf(2.015048373, 5)).toBeCloseTo(0.95, 6)
  })
})

describe('model evaluation', () => {
  it('builds effect-coded, centered, powered and crossed design rows', () => {
    expect(designRow(spec, { height: 62, sex: 'M', temp: 7 })).toEqual([1, 62, -1, -2, 4])
    expect(designRow(spec, { height: 62, sex: 'F', temp: 5 })).toEqual([1, 62, 1, 2, 0])
    expect(designRow(spec, { height: null, sex: 'F', temp: 5 })).toBeNull()
  })

  it('predicts with a t-based confidence interval', () => {
    const p = predict(spec, { height: 62, sex: 'M', temp: 7 })!
    expect(p.value).toBeCloseTo(100 + 2.5 * 62 + 4 - 1 - 5)
    const half = tQuantile(0.975, 10) * Math.sqrt(1 + 62 * 62 + 1 + 4 + 16)
    expect(p.upper - p.value).toBeCloseTo(half)
    expect(p.value - p.lower).toBeCloseTo(half)
  })

  it('predicts table rows, leaving missing factors empty', () => {
    const column = (name: string, values: (number | string | null)[]): Column => ({
      id: name,
      name,
      dataType: typeof values[0] === 'string' ? 'character' : 'numeric',
      modelingType: typeof values[0] === 'string' ? 'nominal' : 'continuous',
      values,
      props: {},
    })
    const columns = new Map([
      ['height', column('height', [62, 60, null])],
      ['sex', column('sex', ['M', 'F', 'F'])],
      ['temp', column('temp', [7, 5, 5])],
    ])
    const preds = predictRows(spec, columns, [0, 1, 2])
    expect(preds[0]).toBeCloseTo(predict(spec, { height: 62, sex: 'M', temp: 7 })!.value)
    expect(preds[1]).toBeCloseTo(100 + 150 - 4)
    expect(preds[2]).toBeNull()
  })

  it('finds the model inside nested report nodes', () => {
    const nodes: ReportNode[] = [
      { type: 'outline', title: 'a', closed: false, children: [{ type: 'row', children: [{ type: 'plot', plot: { kind: 'profiler', model: spec } }] }] },
    ]
    expect(findModel(nodes)).toBe(spec)
    expect(findModel([])).toBeNull()
  })
})

describe('prediction formula', () => {
  it('writes the model in the formula language', () => {
    expect(predictionFormula(spec)).toBe(
      '100 + 2.5 * :height - 4 * Match(:sex, "F", 1, "M", -1, ., ., 0) + 0.5 * (:height - 60) * Match(:sex, "F", 1, "M", -1, ., ., 0) - 1.25 * (:temp - 5) ^ 2',
    )
  })

  it('quotes awkward names and handles negative centers and intercepts', () => {
    const odd: LinearModelSpec = {
      ...spec,
      factors: [
        { name: 'body mass', kind: 'continuous', mean: -3 },
        { name: 'grp', kind: 'categorical', levels: ['a "1"', 'b'] },
      ],
      terms: [
        { label: 'Intercept', parts: [] },
        { label: '(body mass+3)*grp[a "1"]', parts: [{ factor: 'body mass', center: -3, power: 1 }, { factor: 'grp', center: 0, power: 1, level: 'a "1"' }] },
      ],
      coef: [-1.5, 0.125],
      cov: [
        [0, 0],
        [0, 0],
      ],
    }
    expect(predictionFormula(odd)).toBe('-1.5 + 0.125 * (:"body mass" + 3) * Match(:grp, "a \\"1\\"", 1, "b", -1, ., ., 0)')
  })
})
