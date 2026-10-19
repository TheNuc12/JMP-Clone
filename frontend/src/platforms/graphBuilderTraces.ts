// Turns Graph Builder roles + elements into Plotly traces. Pure, so it can be unit tested.

import type { Data, Layout, Shape } from 'plotly.js'
import { completeRows, groupRows, labelAt, numberAt, selectedPoints } from '../lib/data'
import { levelsOf } from '../lib/levels'
import { jitter } from '../lib/random'
import { binCount, binIndex, boxStats, linearFit, lowess, mean, niceBins } from '../lib/stats'
import { BAR, BAR_EDGE, BAR_SELECTED, BOX, paletteColor, POINT } from '../lib/theme'
import { formatNumber } from '../lib/format'
import type { Column, GBElement } from '../state/store'
import { isCategorical } from '../state/store'

export interface GraphInput {
  x?: Column
  y?: Column
  overlay?: Column
  elements: GBElement[]
  rows: number[]
  selected: Uint8Array
  nSelected: number
}

export interface Graph {
  data: Data[]
  layout: Partial<Layout>
  /** Per trace: the rows a point (or bar) stands for, used for linked selection. */
  lookup: (((point: number) => number[] | undefined) | undefined)[]
}

const cat = (c?: Column) => !!c && isCategorical(c.modelingType)

export const ELEMENT_LABELS: Record<GBElement, string> = {
  points: 'Points',
  smoother: 'Smoother',
  line_of_fit: 'Line of Fit',
  line: 'Line',
  bar: 'Bar',
  box: 'Box Plot',
  histogram: 'Histogram',
}

export function availableElements(x?: Column, y?: Column): GBElement[] {
  if (x && y) {
    if (!cat(x) && !cat(y)) return ['points', 'smoother', 'line_of_fit', 'line']
    if (cat(x) !== cat(y)) return ['points', 'box', 'bar', 'line']
    return ['points']
  }
  const only = x ?? y
  if (!only) return []
  return cat(only) ? ['bar', 'points'] : ['histogram', 'points', 'box']
}

export function defaultElements(x?: Column, y?: Column): GBElement[] {
  if (x && y) {
    if (!cat(x) && !cat(y)) return ['points', 'smoother']
    if (cat(x) !== cat(y)) return ['points', 'box']
    return ['points']
  }
  const only = x ?? y
  if (!only) return []
  return cat(only) ? ['bar'] : ['histogram']
}

/**
 * Toggle an element. With a single variable, count-scaled elements (histogram, bar) can't
 * share an axis with points / box plots, so turning one kind on turns the other off.
 */
export function toggleElement(current: GBElement[], element: GBElement, single: boolean): GBElement[] {
  if (current.includes(element)) return current.filter((e) => e !== element)
  const counted: GBElement[] = ['histogram', 'bar']
  let next = current
  if (single) next = counted.includes(element) ? [] : current.filter((e) => !counted.includes(e))
  return [...next, element]
}

interface Group {
  label: string | null
  color: string
  rows: number[]
}

function overlayGroups(rows: number[], overlay?: Column): Group[] {
  if (!overlay || !cat(overlay)) return [{ label: null, color: POINT, rows }]
  const byLabel = groupRows(rows, overlay)
  const groups = levelsOf(byLabel.keys()).map((label, i) => ({ label, color: paletteColor(i), rows: byLabel.get(label)! }))
  const missing = rows.filter((r) => labelAt(overlay, r) === null)
  if (missing.length) groups.push({ label: 'Missing', color: '#adb5bd', rows: missing })
  return groups
}

function markerFor(group: Group, rows: number[], overlay?: Column) {
  if (overlay && !cat(overlay)) {
    return {
      color: rows.map((r) => numberAt(overlay, r)),
      colorscale: 'Viridis',
      showscale: true,
      colorbar: { title: { text: overlay.name }, thickness: 12 },
      size: 7,
    }
  }
  return { color: group.color, size: 7, opacity: 0.85 }
}

function pointsTrace(xs: (number | string)[], ys: (number | string)[], rows: number[], group: Group, input: GraphInput): Data {
  return {
    type: 'scatter',
    mode: 'markers',
    x: xs,
    y: ys,
    name: group.label ?? 'Points',
    legendgroup: group.label ?? undefined,
    showlegend: group.label !== null,
    customdata: rows.map((r) => r + 1),
    marker: markerFor(group, rows, input.overlay),
    hovertemplate: 'Row %{customdata}<extra></extra>',
    selectedpoints: selectedPoints(rows, input.selected, input.nSelected) ?? undefined,
    selected: { marker: { opacity: 1, size: 9 } },
    unselected: { marker: { opacity: 0.2 } },
  } as Data
}

function lineTrace(xs: number[], ys: number[], group: Group, name: string, dash?: 'dash' | 'dot'): Data {
  return {
    type: 'scatter',
    mode: 'lines',
    x: xs,
    y: ys,
    name,
    legendgroup: group.label ?? undefined,
    showlegend: false,
    line: { color: group.label === null ? '#c0392b' : group.color, width: 2, dash },
    hovertemplate: `${name}<extra></extra>`,
  }
}

function levelAxis(title: string, levels: string[]): Partial<Layout['xaxis']> {
  return {
    title: { text: title },
    tickmode: 'array',
    tickvals: levels.map((_, i) => i),
    ticktext: levels,
    range: [-0.6, levels.length - 0.4],
    showgrid: false,
  }
}

export function buildGraph(input: GraphInput): Graph {
  const { x, y, overlay } = input
  const elements = new Set(input.elements)
  const data: Data[] = []
  const lookup: Graph['lookup'] = []
  const shapes: Partial<Shape>[] = []
  const layout: Partial<Layout> = { shapes }
  const used = completeRows(input.rows, [x, y].filter((c): c is Column => !!c))
  const groups = overlayGroups(used, overlay)
  layout.showlegend = groups.length > 1
  layout.legend = { title: { text: overlay?.name ?? '' } }

  if (!x && !y) return { data, layout, lookup }

  // Continuous by continuous.
  if (x && y && !cat(x) && !cat(y)) {
    for (const g of groups) {
      const xs = g.rows.map((r) => numberAt(x, r)!)
      const ys = g.rows.map((r) => numberAt(y, r)!)
      if (elements.has('points')) {
        data.push(pointsTrace(xs, ys, g.rows, g, input))
        lookup.push((p) => [g.rows[p]])
      }
      if (elements.has('line')) {
        const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
        data.push(lineTrace(order.map((i) => xs[i]), order.map((i) => ys[i]), g, 'Line'))
        lookup.push(undefined)
      }
      if (elements.has('line_of_fit')) {
        const fit = linearFit(xs, ys)
        if (fit) {
          const lo = Math.min(...xs)
          const hi = Math.max(...xs)
          const name = `${y.name} = ${formatNumber(fit.intercept, 4)} + ${formatNumber(fit.slope, 4)}·${x.name}  (R² ${formatNumber(fit.r2, 3)})`
          data.push(lineTrace([lo, hi], [fit.intercept + fit.slope * lo, fit.intercept + fit.slope * hi], g, name))
          lookup.push(undefined)
        }
      }
      if (elements.has('smoother')) {
        const s = lowess(xs, ys)
        data.push(lineTrace(s.x, s.y, g, 'Smoother'))
        lookup.push(undefined)
      }
    }
    layout.xaxis = { title: { text: x.name } }
    layout.yaxis = { title: { text: y.name } }
    return { data, layout, lookup }
  }

  // One categorical position axis and one continuous value axis.
  if (x && y && cat(x) !== cat(y)) {
    const horizontal = cat(y)
    const posCol = horizontal ? y : x
    const valCol = horizontal ? x : y
    const levels = levelsOf(used.map((r) => labelAt(posCol, r)))
    const levelIndex = new Map(levels.map((l, i) => [l, i]))
    const xy = (pos: number[], val: number[]) => (horizontal ? { x: val, y: pos } : { x: pos, y: val })
    const slot = 0.8 / groups.length
    groups.forEach((g, k) => {
      const offset = groups.length > 1 ? -0.4 + slot * (k + 0.5) : 0
      const byLevel = groupRows(g.rows, posCol)
      const levelRows = levels.map((l) => byLevel.get(l) ?? [])
      if (elements.has('bar')) {
        const pos = levels.map((_, i) => i + offset)
        const means = levelRows.map((rs) => (rs.length ? mean(rs.map((r) => numberAt(valCol, r)!)) : NaN))
        data.push({
          type: 'bar',
          ...xy(pos, means),
          orientation: horizontal ? 'h' : 'v',
          width: groups.length > 1 ? slot * 0.9 : 0.6,
          name: g.label ?? 'Mean',
          legendgroup: g.label ?? undefined,
          showlegend: false,
          marker: { color: g.label === null ? BAR : g.color, opacity: g.label === null ? 1 : 0.55, line: { color: BAR_EDGE, width: 1 } },
          hovertemplate: `Mean: %{${horizontal ? 'x' : 'y'}:.4g}<extra></extra>`,
          selected: { marker: { opacity: 1 } },
          unselected: { marker: { opacity: 1 } },
        } as Data)
        lookup.push((p) => levelRows[p])
      }
      if (elements.has('box')) {
        const half = Math.min(slot * 0.35, 0.22)
        levelRows.forEach((rs, i) => {
          const b = boxStats(rs.map((r) => numberAt(valCol, r)!))
          if (!b) return
          const c = i + offset
          const line = { color: g.label === null ? BOX : g.color, width: 1.3 }
          const seg = (p0: number, p1: number, v0: number, v1: number): Partial<Shape> =>
            horizontal ? { type: 'line', x0: v0, x1: v1, y0: p0, y1: p1, line } : { type: 'line', x0: p0, x1: p1, y0: v0, y1: v1, line }
          shapes.push(
            horizontal
              ? { type: 'rect', x0: b.q1, x1: b.q3, y0: c - half, y1: c + half, line }
              : { type: 'rect', x0: c - half, x1: c + half, y0: b.q1, y1: b.q3, line },
            seg(c - half, c + half, b.median, b.median),
            seg(c, c, b.lower_whisker, b.q1),
            seg(c, c, b.q3, b.upper_whisker),
          )
        })
      }
      if (elements.has('points')) {
        const width = Math.min(slot * 0.8, 0.5)
        const pos = g.rows.map((r) => levelIndex.get(labelAt(posCol, r)!)! + offset + jitter(r, width))
        const val = g.rows.map((r) => numberAt(valCol, r)!)
        const { x: xs, y: ys } = xy(pos, val)
        data.push(pointsTrace(xs, ys, g.rows, g, input))
        lookup.push((p) => [g.rows[p]])
      }
      if (elements.has('line')) {
        const pos: number[] = []
        const means: number[] = []
        levelRows.forEach((rs, i) => {
          if (!rs.length) return
          pos.push(i + offset)
          means.push(mean(rs.map((r) => numberAt(valCol, r)!)))
        })
        const { x: xs, y: ys } = xy(pos, means)
        data.push({ ...lineTrace(xs, ys, g, 'Mean'), mode: 'lines+markers' } as Data)
        lookup.push(undefined)
      }
    })
    const posAxis = levelAxis(posCol.name, levels)
    const valAxis = { title: { text: valCol.name } }
    layout.xaxis = horizontal ? valAxis : posAxis
    layout.yaxis = horizontal ? posAxis : valAxis
    return { data, layout, lookup }
  }

  // Categorical by categorical: jittered points in a grid.
  if (x && y) {
    const xLevels = levelsOf(used.map((r) => labelAt(x, r)))
    const yLevels = levelsOf(used.map((r) => labelAt(y, r)))
    const xi = new Map(xLevels.map((l, i) => [l, i]))
    const yi = new Map(yLevels.map((l, i) => [l, i]))
    for (const g of groups) {
      const xs = g.rows.map((r) => xi.get(labelAt(x, r)!)! + jitter(r, 0.7, 1))
      const ys = g.rows.map((r) => yi.get(labelAt(y, r)!)! + jitter(r, 0.7, 2))
      data.push(pointsTrace(xs, ys, g.rows, g, input))
      lookup.push((p) => [g.rows[p]])
    }
    layout.xaxis = levelAxis(x.name, xLevels)
    layout.yaxis = levelAxis(y.name, yLevels)
    return { data, layout, lookup }
  }

  // A single variable on X or Y.
  const only = (x ?? y)!
  const onY = !x
  const valueAxis = { title: { text: only.name } }
  const countAxis = { title: { text: 'Count' }, rangemode: 'tozero' as const }
  const stripAxis = { showticklabels: false, showgrid: false, range: [-0.6, 0.6], ticks: '' as const }
  const orient = (pos: (number | string)[], val: (number | string)[]) => (onY ? { x: val, y: pos } : { x: pos, y: val })

  if (cat(only)) {
    const levels = levelsOf(used.map((r) => labelAt(only, r)))
    const levelIndex = new Map(levels.map((l, i) => [l, i]))
    if (elements.has('bar')) {
      layout.barmode = groups.length > 1 ? 'stack' : 'overlay'
      for (const g of groups) {
        const byLevel = groupRows(g.rows, only)
        const levelRows = levels.map((l) => byLevel.get(l) ?? [])
        const counts = levelRows.map((rs) => rs.length)
        data.push({
          type: 'bar',
          ...orient(levels, counts),
          orientation: onY ? 'h' : 'v',
          name: g.label ?? 'Count',
          showlegend: g.label !== null,
          marker: { color: g.label === null ? BAR : g.color, line: { color: BAR_EDGE, width: 1 } },
          selected: { marker: { opacity: 1 } },
          unselected: { marker: { opacity: 1 } },
        } as Data)
        lookup.push((p) => levelRows[p])
        if (groups.length === 1) {
          const selectedCounts = levelRows.map((rs) => rs.reduce((n, r) => n + input.selected[r], 0))
          data.push({
            type: 'bar',
            ...orient(levels, selectedCounts),
            orientation: onY ? 'h' : 'v',
            marker: { color: BAR_SELECTED },
            hoverinfo: 'skip',
            selected: { marker: { opacity: 1 } },
            unselected: { marker: { opacity: 1 } },
          } as Data)
          lookup.push((p) => levelRows[p])
        }
      }
      const levelsAxis = { type: 'category' as const, title: { text: only.name } }
      layout.xaxis = onY ? countAxis : levelsAxis
      layout.yaxis = onY ? levelsAxis : countAxis
    } else {
      for (const g of groups) {
        const pos = g.rows.map((r) => levelIndex.get(labelAt(only, r)!)! + jitter(r, 0.6, 1))
        const strip = g.rows.map((r) => jitter(r, 0.9, 2))
        const { x: xs, y: ys } = orient(pos, strip)
        data.push(pointsTrace(xs, ys, g.rows, g, input))
        lookup.push((p) => [g.rows[p]])
      }
      const levelsAxis = levelAxis(only.name, levels)
      layout.xaxis = onY ? stripAxis : levelsAxis
      layout.yaxis = onY ? levelsAxis : stripAxis
    }
    return { data, layout, lookup }
  }

  const values = used.map((r) => numberAt(only, r)!)
  if (elements.has('histogram')) {
    const bins = niceBins(values)
    const n = binCount(bins)
    const centers = Array.from({ length: n }, (_, i) => bins.start + bins.size * (i + 0.5))
    layout.barmode = groups.length > 1 ? 'stack' : 'overlay'
    layout.bargap = 0
    for (const g of groups) {
      const binRows: number[][] = Array.from({ length: n }, () => [])
      for (const r of g.rows) binRows[binIndex(numberAt(only, r)!, bins)].push(r)
      const bar = (counts: number[], color: string, extra: object = {}): Data =>
        ({
          type: 'bar',
          ...orient(centers, counts),
          orientation: onY ? 'h' : 'v',
          width: bins.size,
          marker: { color, line: { color: BAR_EDGE, width: 1 } },
          selected: { marker: { opacity: 1 } },
          unselected: { marker: { opacity: 1 } },
          ...extra,
        }) as Data
      data.push(bar(binRows.map((rs) => rs.length), g.label === null ? BAR : g.color, { name: g.label ?? 'Count', showlegend: g.label !== null }))
      lookup.push((p) => binRows[p])
      if (groups.length === 1) {
        data.push(bar(binRows.map((rs) => rs.reduce((c, r) => c + input.selected[r], 0)), BAR_SELECTED, { hoverinfo: 'skip' }))
        lookup.push((p) => binRows[p])
      }
    }
    layout.xaxis = onY ? countAxis : valueAxis
    layout.yaxis = onY ? valueAxis : countAxis
    return { data, layout, lookup }
  }

  if (elements.has('box')) {
    const b = boxStats(values)
    if (b) {
      const line = { color: BOX, width: 1.3 }
      const half = 0.25
      const seg = (p0: number, p1: number, v0: number, v1: number): Partial<Shape> =>
        onY ? { type: 'line', x0: p0, x1: p1, y0: v0, y1: v1, line } : { type: 'line', x0: v0, x1: v1, y0: p0, y1: p1, line }
      shapes.push(
        onY ? { type: 'rect', x0: -half, x1: half, y0: b.q1, y1: b.q3, line } : { type: 'rect', x0: b.q1, x1: b.q3, y0: -half, y1: half, line },
        seg(-half, half, b.median, b.median),
        seg(0, 0, b.lower_whisker, b.q1),
        seg(0, 0, b.q3, b.upper_whisker),
      )
    }
  }
  if (elements.has('points')) {
    for (const g of groups) {
      const strip = g.rows.map((r) => jitter(r, 0.8, 3))
      const val = g.rows.map((r) => numberAt(only, r)!)
      // For a variable on X the strip runs along Y, and vice versa.
      const { x: xs, y: ys } = onY ? { x: strip, y: val } : { x: val, y: strip }
      data.push(pointsTrace(xs, ys, g.rows, g, input))
      lookup.push((p) => [g.rows[p]])
    }
  }
  layout.xaxis = onY ? stripAxis : valueAxis
  layout.yaxis = onY ? valueAxis : stripAxis
  return { data, layout, lookup }
}
