import { describe, expect, it } from 'vitest'
import type { Column } from '../state/store'
import { availableElements, buildGraph, defaultElements, toggleElement } from './graphBuilderTraces'

const height: Column = { name: 'height', dataType: 'numeric', modelingType: 'continuous', values: [60, 62, null, 65, 70, 58] }
const weight: Column = { name: 'weight', dataType: 'numeric', modelingType: 'continuous', values: [100, 110, 120, 130, 150, 95] }
const sex: Column = { name: 'sex', dataType: 'character', modelingType: 'nominal', values: ['F', 'M', 'F', 'M', 'M', null] }
const rows = [0, 1, 2, 3, 4, 5]
const none = new Uint8Array(6)

describe('graph builder elements', () => {
  it('offers elements that fit the roles', () => {
    expect(availableElements(height, weight)).toContain('smoother')
    expect(availableElements(sex, weight)).toContain('box')
    expect(availableElements(height)).toContain('histogram')
    expect(availableElements(sex)).toEqual(['bar', 'points'])
    expect(availableElements()).toEqual([])
  })

  it('picks sensible defaults', () => {
    expect(defaultElements(height, weight)).toEqual(['points', 'smoother'])
    expect(defaultElements(undefined, weight)).toEqual(['histogram'])
    expect(defaultElements(sex)).toEqual(['bar'])
  })

  it('keeps count-scaled and point elements apart for a single variable', () => {
    expect(toggleElement(['histogram'], 'points', true)).toEqual(['points'])
    expect(toggleElement(['points', 'box'], 'histogram', true)).toEqual(['histogram'])
    expect(toggleElement(['points'], 'smoother', false)).toEqual(['points', 'smoother'])
    expect(toggleElement(['points', 'smoother'], 'points', false)).toEqual(['smoother'])
  })
})

describe('buildGraph', () => {
  it('draws one point per complete row and maps points back to rows', () => {
    const g = buildGraph({ x: height, y: weight, elements: ['points'], rows, selected: none, nSelected: 0 })
    expect(g.data).toHaveLength(1)
    const trace = g.data[0] as { x: number[] }
    expect(trace.x).toHaveLength(5) // row 2 has no height
    expect(g.lookup[0]?.(2)).toEqual([3])
  })

  it('splits traces by overlay level', () => {
    const g = buildGraph({ x: height, y: weight, overlay: sex, elements: ['points', 'line_of_fit'], rows, selected: none, nSelected: 0 })
    const names = g.data.map((t) => (t as { name?: string }).name)
    expect(names).toContain('F')
    expect(names).toContain('M')
    expect(names).toContain('Missing')
    expect(g.layout.showlegend).toBe(true)
  })

  it('histogram counts add up and shade selected rows', () => {
    const selected = new Uint8Array([1, 0, 0, 1, 0, 0])
    const g = buildGraph({ y: weight, elements: ['histogram'], rows, selected, nSelected: 2 })
    const [all, sel] = g.data as { x: number[] }[]
    expect(all.x.reduce((a, b) => a + b, 0)).toBe(6)
    expect(sel.x.reduce((a, b) => a + b, 0)).toBe(2)
    const binRows = all.x.flatMap((_, i) => g.lookup[0]?.(i) ?? [])
    expect(binRows.sort()).toEqual(rows)
  })

  it('uses category positions for a categorical X', () => {
    const g = buildGraph({ x: sex, y: weight, elements: ['bar'], rows, selected: none, nSelected: 0 })
    const bar = g.data[0] as { x: number[]; y: number[] }
    expect(bar.x).toEqual([0, 1])
    expect(bar.y[0]).toBeCloseTo((100 + 120) / 2)
    expect(bar.y[1]).toBeCloseTo((110 + 130 + 150) / 3)
  })
})
