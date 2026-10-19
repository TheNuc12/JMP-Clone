import { describe, expect, it } from 'vitest'
import type { Column, GBElement } from '../state/store'
import { availableElements, buildFacetedGraph, buildGraph, defaultElements, MAX_FACETS, toggleElement } from './graphBuilderTraces'

const height: Column = { id: 'h', props: {}, name: 'height', dataType: 'numeric', modelingType: 'continuous', values: [60, 62, null, 65, 70, 58] }
const weight: Column = { id: 'w', props: {}, name: 'weight', dataType: 'numeric', modelingType: 'continuous', values: [100, 110, 120, 130, 150, 95] }
const sex: Column = { id: 's', props: {}, name: 'sex', dataType: 'character', modelingType: 'nominal', values: ['F', 'M', 'F', 'M', 'M', null] }
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

  it('keeps the smoother within the range of the data', () => {
    // Two tight clusters far apart: local linear fits extrapolate between them.
    const xs = [0, 0.001, 0.002, 0.003, 10, 10.001, 10.002]
    const ys = [1, 5, 2, 4, 3, 1, 5]
    const cx: Column = { id: 'cx', props: {}, name: 'cx', dataType: 'numeric', modelingType: 'continuous', values: xs }
    const cy: Column = { id: 'cy', props: {}, name: 'cy', dataType: 'numeric', modelingType: 'continuous', values: ys }
    const all = xs.map((_, i) => i)
    const g = buildGraph({ x: cx, y: cy, elements: ['smoother'], rows: all, selected: new Uint8Array(xs.length), nSelected: 0 })
    const curve = g.data[0] as { y: number[] }
    expect(curve.y.length).toBeGreaterThan(0)
    for (const v of curve.y) {
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(5)
    }
  })

  it('uses category positions for a categorical X', () => {
    const g = buildGraph({ x: sex, y: weight, elements: ['bar'], rows, selected: none, nSelected: 0 })
    const bar = g.data[0] as { x: number[]; y: number[] }
    expect(bar.x).toEqual([0, 1])
    expect(bar.y[0]).toBeCloseTo((100 + 120) / 2)
    expect(bar.y[1]).toBeCloseTo((110 + 130 + 150) / 3)
  })
})

describe('buildFacetedGraph', () => {
  const shift: Column = { id: 'sh', props: {}, name: 'shift', dataType: 'character', modelingType: 'nominal', values: ['Day', 'Night', 'Day', 'Night', 'Day', 'Night'] }
  type Trace = { name?: string; xaxis?: string; yaxis?: string; x: number[]; showlegend?: boolean; marker?: { color?: string } }
  type Axis = { domain: number[]; matches?: string; showticklabels?: boolean; title?: unknown }
  const axisOf = (layout: object, key: string) => (layout as Record<string, Axis>)[key]

  it('is buildGraph when there are no group roles', () => {
    const input = { x: height, y: weight, elements: ['points', 'smoother'] as GBElement[], rows, selected: none, nSelected: 0 }
    const g = buildFacetedGraph(input)
    expect(g.data).toEqual(buildGraph(input).data)
    expect(g.facets).toEqual({ xLevels: [], yLevels: [], hiddenLevels: 0, missingRows: 0 })
  })

  it('lays out one panel per group combination on its own axes', () => {
    const g = buildFacetedGraph({ x: height, y: weight, groupX: sex, groupY: shift, elements: ['points'], rows, selected: none, nSelected: 0 })
    expect(g.facets.xLevels).toEqual(['F', 'M'])
    expect(g.facets.yLevels).toEqual(['Day', 'Night'])
    expect(g.facets.missingRows).toBe(1) // row 5 has no sex
    const traces = g.data as Trace[]
    expect(traces.map((t) => [t.xaxis, t.yaxis])).toEqual([
      ['x', 'y'],
      ['x2', 'y2'],
      ['x3', 'y3'],
      ['x4', 'y4'],
    ])
    // Panels share ranges with the first panel; tick labels only on the outer axes.
    expect(axisOf(g.layout, 'xaxis2').matches).toBe('x')
    expect(axisOf(g.layout, 'yaxis4').matches).toBe('y')
    expect(axisOf(g.layout, 'xaxis').showticklabels).toBe(false)
    expect(axisOf(g.layout, 'xaxis3').showticklabels).toBe(true)
    expect(axisOf(g.layout, 'yaxis2').showticklabels).toBe(false)
    expect(axisOf(g.layout, 'yaxis3').showticklabels).toBe(true)
    // First Group Y level on top, first Group X level on the left.
    expect(axisOf(g.layout, 'yaxis').domain[0]).toBeGreaterThan(axisOf(g.layout, 'yaxis3').domain[1])
    expect(axisOf(g.layout, 'xaxis').domain[1]).toBeLessThan(axisOf(g.layout, 'xaxis2').domain[0])
    const labels = (g.layout.annotations ?? []).map((a) => a.text)
    expect(labels).toEqual(expect.arrayContaining(['F', 'M', 'Day', 'Night', '<b>sex</b>', '<b>shift</b>']))
  })

  it('maps points in every panel back to their rows', () => {
    const g = buildFacetedGraph({ x: height, y: weight, groupX: sex, groupY: shift, elements: ['points'], rows, selected: none, nSelected: 0 })
    // Panels in reading order: (F, Day), (M, Day), (F, Night), (M, Night).
    expect(g.lookup[0]?.(0)).toEqual([0]) // row 2 (F, Day) has no height
    expect(g.lookup[1]?.(0)).toEqual([4])
    expect((g.data[2] as Trace).x).toEqual([])
    expect([g.lookup[3]?.(0), g.lookup[3]?.(1)]).toEqual([[1], [3]])
  })

  it('keeps overlay colors and one legend entry per level across panels', () => {
    const g = buildFacetedGraph({ x: height, y: weight, overlay: sex, groupX: shift, elements: ['points'], rows, selected: none, nSelected: 0 })
    const traces = g.data as Trace[]
    const colors = (name: string) => new Set(traces.filter((t) => t.name === name).map((t) => t.marker?.color))
    expect(colors('F').size).toBe(1)
    expect(colors('M').size).toBe(1)
    expect([...colors('F')][0]).not.toBe([...colors('M')][0])
    const legend = traces.filter((t) => t.showlegend).map((t) => t.name)
    expect(legend.sort()).toEqual(['F', 'M', 'Missing'])
  })

  it('moves shapes onto their panel axes', () => {
    const g = buildFacetedGraph({ x: sex, y: weight, groupY: shift, elements: ['box'], rows, selected: none, nSelected: 0 })
    const refs = new Set((g.layout.shapes ?? []).map((s) => `${s.xref}/${s.yref}`))
    expect(refs).toEqual(new Set(['x/y', 'x2/y2']))
  })

  it('autoranges value axes next to fixed category axes', () => {
    const g = buildFacetedGraph({ x: sex, y: weight, groupY: shift, elements: ['points'], rows, selected: none, nSelected: 0 })
    const axes = g.layout as Record<string, { range?: number[]; autorange?: boolean }>
    expect(axes.xaxis.range).toBeDefined()
    expect(axes.xaxis.autorange).toBeUndefined()
    expect(axes.yaxis.autorange).toBe(true)
    expect(axes.yaxis2.autorange).toBe(true)
  })

  it('shares histogram bins across panels', () => {
    const g = buildFacetedGraph({ y: weight, groupX: shift, elements: ['histogram'], rows, selected: none, nSelected: 0 })
    const bars = (g.data as { y: number[]; xaxis: string }[]).filter((_, i) => i % 2 === 0)
    expect(bars).toHaveLength(2)
    expect(bars[0].y).toEqual(bars[1].y)
  })

  it('caps the number of panels per direction', () => {
    const n = MAX_FACETS + 3
    const many: Column = { id: 'm', props: {}, name: 'many', dataType: 'numeric', modelingType: 'ordinal', values: Array.from({ length: n }, (_, i) => i) }
    const value: Column = { id: 'v', props: {}, name: 'v', dataType: 'numeric', modelingType: 'continuous', values: Array.from({ length: n }, (_, i) => i) }
    const allRows = Array.from({ length: n }, (_, i) => i)
    const g = buildFacetedGraph({ y: value, groupX: many, elements: ['points'], rows: allRows, selected: new Uint8Array(n), nSelected: 0 })
    expect(g.facets.xLevels).toHaveLength(MAX_FACETS)
    expect(g.facets.hiddenLevels).toBe(3)
  })
})
