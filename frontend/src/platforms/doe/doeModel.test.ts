import { describe, expect, it } from 'vitest'
import type { DataTablePayload } from '../../api/types'
import { activeTableOf, useStore } from '../../state/store'
import {
  candidateTerms,
  defaultDraft,
  newFactor,
  parameterCount,
  previewRuns,
  screeningChoice,
  termKey,
  toRequest,
  validate,
  type DesignDraft,
} from './doeModel'

function draft(design: DesignDraft['design'], change: Partial<DesignDraft> = {}): DesignDraft {
  return { ...defaultDraft(design), ...change }
}

describe('defaults', () => {
  it('starts each design with sensible factors and settings', () => {
    expect(defaultDraft('full_factorial').factors.map((f) => f.name)).toEqual(['X1', 'X2', 'X3'])
    expect(defaultDraft('fractional_factorial').factors).toHaveLength(5)
    expect(defaultDraft('response_surface').centerPoints).toBe(6)
    expect(defaultDraft('custom').responses.map((r) => r.name)).toEqual(['Y'])
    for (const d of ['full_factorial', 'fractional_factorial', 'response_surface', 'custom'] as const) {
      expect(validate(defaultDraft(d))).toEqual([])
    }
  })

  it('names new factors after the first free X number', () => {
    expect(newFactor('continuous', ['X1', 'X3']).name).toBe('X2')
    expect(newFactor('categorical', [], 2).levels).toBe('L1, L2')
  })
})

describe('run previews', () => {
  it('matches the designs the backend builds', () => {
    expect(previewRuns(draft('full_factorial'))).toBe(8)
    expect(previewRuns(draft('full_factorial', { replicates: 1, centerPoints: 3 }))).toBe(19)
    expect(previewRuns(draft('fractional_factorial'))).toBe(16)
    expect(previewRuns(draft('fractional_factorial', { resolution: 3 }))).toBe(8)
    expect(previewRuns(draft('response_surface'))).toBe(8 + 6 + 6)
    expect(previewRuns(draft('response_surface', { rsmType: 'box_behnken', centerPoints: 3 }))).toBe(15)
    expect(previewRuns(draft('custom'))).toBe(4 + 4)
    expect(previewRuns(draft('custom', { nRuns: '10' }))).toBe(10)
  })

  it('picks the smallest screening design with the resolution asked for', () => {
    expect(screeningChoice(4, null)).toEqual([8, 4])
    expect(screeningChoice(3, null)).toEqual([8, 99])
    expect(screeningChoice(7, 4)).toEqual([16, 4])
    expect(screeningChoice(7, 5)).toEqual([64, 7])
    expect(screeningChoice(13, 5)).toBeNull()
    expect(screeningChoice(13, null)).toEqual([32, 4])
  })
})

describe('custom model', () => {
  it('lists interactions and quadratics and counts parameters', () => {
    const base = draft('custom')
    const factors = [...base.factors.slice(0, 2), { ...newFactor('categorical', ['X1', 'X2']), name: 'C', levels: 'a, b, c' }]
    const terms = candidateTerms(factors)
    expect(terms.filter((t) => t.group === 'interaction').map((t) => t.label)).toEqual(['X1*X2', 'X1*C', 'X2*C'])
    expect(terms.filter((t) => t.group === 'quadratic').map((t) => t.label)).toEqual(['X1*X1', 'X2*X2'])
    const withTerms = { ...base, factors, extraTerms: [termKey([factors[0].id, factors[2].id]), termKey([factors[0].id, factors[0].id])] }
    // 1 + X1 + X2 + C(2) + X1*C(2) + X1*X1
    expect(parameterCount(withTerms)).toBe(8)
    expect(toRequest(withTerms).model).toEqual([['X1'], ['X2'], ['C'], ['X1', 'C'], ['X1', 'X1']])
  })
})

describe('validation', () => {
  it('explains what is wrong', () => {
    const d = draft('full_factorial')
    const bad = { ...d, factors: [{ ...d.factors[0], low: '5', high: '1' }, { ...d.factors[1], name: 'x1' }] }
    const errors = validate(bad)
    expect(errors).toContain('X1: low must be below high.')
    expect(errors.some((e) => e.startsWith('Names must be unique'))).toBe(true)
  })

  it('checks design-specific rules', () => {
    const cat = { ...newFactor('categorical', ['X1', 'X2', 'X3', 'X4', 'X5']), levels: 'a, b, c' }
    const screening = draft('fractional_factorial')
    expect(validate({ ...screening, factors: [...screening.factors, cat] })[0]).toMatch(/2-level factors/)
    const rsm = draft('response_surface')
    expect(validate({ ...rsm, factors: [...rsm.factors, cat] })).toContain('Response surface designs use continuous factors only.')
    expect(validate({ ...draft('custom'), nRuns: '2' })).toContain('The model has 4 parameters, so the design needs at least 4 runs.')
    expect(validate({ ...draft('full_factorial'), factors: [{ ...cat }], centerPoints: 2 })).toContain('Center points need at least one continuous factor.')
  })
})

describe('request', () => {
  it('sends trimmed names, parsed levels and the seed', () => {
    const d = draft('full_factorial', { seed: '42', randomize: false })
    const factors = [{ ...d.factors[0], name: ' Temp ', low: '150', high: '200' }, { ...newFactor('categorical', []), name: 'Mix', levels: 'slow,  fast ,' }]
    const req = toRequest({ ...d, factors })
    expect(req.factors).toEqual([
      { name: 'Temp', kind: 'continuous', low: 150, high: 200 },
      { name: 'Mix', kind: 'categorical', levels: ['slow', 'fast'] },
    ])
    expect(req.seed).toBe(42)
    expect(req.randomize).toBe(false)
    expect(toRequest(draft('full_factorial')).seed).toBeNull()
    expect(toRequest(draft('response_surface'))).toMatchObject({ rsm_type: 'ccd', ccd_alpha: 'rotatable' })
  })
})

describe('making the table', () => {
  it('opens the design as a new table with its model mapped to column ids', () => {
    const payload: DataTablePayload = {
      name: 'DOE Full Factorial',
      n_rows: 2,
      columns: [
        { name: 'Pattern', data_type: 'character', modeling_type: 'nominal', values: ['-', '+'] },
        { name: 'Mix', data_type: 'character', modeling_type: 'nominal', values: ['slow', 'fast'], value_order: ['slow', 'fast'] },
        { name: 'Y', data_type: 'numeric', modeling_type: 'continuous', values: [null, null] },
      ],
      model: { responses: ['Y'], effects: [['Mix']] },
    }
    useStore.getState().addTable(payload)
    const table = activeTableOf(useStore.getState())!
    const id = (name: string) => table.columns.find((c) => c.name === name)!.id
    expect(table.name).toBe('DOE Full Factorial')
    expect(table.model).toEqual({ responses: [id('Y')], effects: [[id('Mix')]] })
    expect(table.columns.find((c) => c.name === 'Mix')!.props.valueOrder).toEqual(['slow', 'fast'])
  })
})
