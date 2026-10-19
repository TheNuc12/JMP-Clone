import { useMemo } from 'react'
import type { Data, Layout, Shape } from 'plotly.js'
import type { LogisticPlot, MosaicPlot, OnewayPlot, ScatterPlot } from '../api/types'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { completeRows, labelAt, numberAt, selectedPoints } from '../lib/data'
import { jitter, rowNoise } from '../lib/random'
import { BAND, BOX, DIAMOND, FIT, paletteColor, POINT, tint } from '../lib/theme'
import type { Column } from '../state/store'
import { useStore } from '../state/store'

interface PlotProps<S> {
  spec: S
  rows: number[]
  columns: Map<string, Column>
}

const CURVE_COLORS = [FIT, '#1971c2', '#2f9e44', '#7048e8']
const BAND_ALT = 'rgba(25, 113, 194, 0.12)'

function pointTrace(xs: number[], ys: number[], rows: number[], selected: Uint8Array, nSelected: number, extra: object = {}): Data {
  return {
    type: 'scatter',
    mode: 'markers',
    x: xs,
    y: ys,
    customdata: rows.map((r) => r + 1),
    marker: { color: POINT, size: 6, opacity: 0.85 },
    hovertemplate: 'Row %{customdata}<extra></extra>',
    selectedpoints: selectedPoints(rows, selected, nSelected) ?? undefined,
    selected: { marker: { opacity: 1, size: 8 } },
    unselected: { marker: { opacity: 0.2 } },
    ...extra,
  } as Data
}

/** Bivariate scatter plot with fitted curves and confidence bands. */
export function ScatterChart({ spec, rows, columns }: PlotProps<ScatterPlot>) {
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const xCol = columns.get(spec.x)
  const yCol = columns.get(spec.y)
  const used = useMemo(() => (xCol && yCol ? completeRows(rows, [xCol, yCol]) : []), [rows, xCol, yCol])

  const data = useMemo<Data[]>(() => {
    if (!xCol || !yCol) return []
    const traces: Data[] = [
      pointTrace(
        used.map((r) => numberAt(xCol, r)!),
        used.map((r) => numberAt(yCol, r)!),
        used,
        selected,
        nSelected,
        { hovertemplate: `Row %{customdata}<br>${spec.x}: %{x}<br>${spec.y}: %{y}<extra></extra>` },
      ),
    ]
    spec.curves.forEach((curve, i) => {
      const color = CURVE_COLORS[i % CURVE_COLORS.length]
      if (curve.lower && curve.upper) {
        traces.push(
          { type: 'scatter', mode: 'lines', x: curve.x, y: curve.lower, line: { width: 0 }, hoverinfo: 'skip' },
          {
            type: 'scatter',
            mode: 'lines',
            x: curve.x,
            y: curve.upper,
            line: { width: 0 },
            fill: 'tonexty',
            fillcolor: i === 0 ? BAND : BAND_ALT,
            hoverinfo: 'skip',
          },
        )
      }
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: curve.x,
        y: curve.y,
        name: curve.label,
        line: { color, width: 2 },
        hovertemplate: `${curve.label}<extra></extra>`,
      })
    })
    return traces
  }, [xCol, yCol, used, spec, selected, nSelected])

  const layout = useMemo<Partial<Layout>>(
    () => ({
      xaxis: axis({ title: { text: spec.x } }),
      yaxis: axis({ title: { text: spec.y } }),
      showlegend: spec.curves.length > 1,
      legend: { orientation: 'h', y: -0.22 },
    }),
    [spec],
  )

  if (!xCol || !yCol) return null
  return <PlotlyChart data={data} layout={layout} height={340} pointRows={(curve, point) => (curve === 0 ? [used[point]] : undefined)} />
}

/** Oneway plot: jittered points per level with means diamonds, box plots and the grand mean. */
export function OnewayChart({ spec, rows, columns }: PlotProps<OnewayPlot>) {
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const xCol = columns.get(spec.x)
  const yCol = columns.get(spec.y)
  const levelIndex = useMemo(() => new Map(spec.levels.map((l, i) => [l, i])), [spec.levels])
  const used = useMemo(
    () => (xCol && yCol ? completeRows(rows, [xCol, yCol]).filter((r) => levelIndex.has(labelAt(xCol, r)!)) : []),
    [rows, xCol, yCol, levelIndex],
  )

  const data = useMemo<Data[]>(() => {
    if (!xCol || !yCol) return []
    const width = spec.show_diamonds || spec.show_boxes ? 0.3 : 0.45
    return [
      pointTrace(
        used.map((r) => levelIndex.get(labelAt(xCol, r)!)! + jitter(r, width)),
        used.map((r) => numberAt(yCol, r)!),
        used,
        selected,
        nSelected,
        {
          text: used.map((r) => labelAt(xCol, r)),
          hovertemplate: `Row %{customdata}<br>${spec.x}: %{text}<br>${spec.y}: %{y}<extra></extra>`,
        },
      ),
    ]
  }, [xCol, yCol, used, levelIndex, spec, selected, nSelected])

  const layout = useMemo<Partial<Layout>>(() => {
    const shapes: Partial<Shape>[] = []
    const maxN = Math.max(1, ...spec.groups.map((g) => g.n))
    if (spec.grand_mean !== null) {
      shapes.push({
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        y0: spec.grand_mean,
        y1: spec.grand_mean,
        line: { color: '#868e96', width: 1, dash: 'dot' },
      })
    }
    spec.groups.forEach((g, i) => {
      if (spec.show_boxes && g.box) {
        const b = g.box
        const line = { color: BOX, width: 1.2 }
        const w = 0.18
        shapes.push(
          { type: 'rect', x0: i - w, x1: i + w, y0: b.q1, y1: b.q3, line },
          { type: 'line', x0: i - w, x1: i + w, y0: b.median, y1: b.median, line },
          { type: 'line', x0: i, x1: i, y0: b.lower_whisker, y1: b.q1, line },
          { type: 'line', x0: i, x1: i, y0: b.q3, y1: b.upper_whisker, line },
        )
      }
      if (spec.show_diamonds && g.mean !== null && g.ci_lower !== null && g.ci_upper !== null) {
        // Diamond width is proportional to the group's sample size, as in JMP.
        const w = 0.08 + 0.32 * (g.n / maxN)
        shapes.push(
          {
            type: 'path',
            path: `M ${i - w} ${g.mean} L ${i} ${g.ci_upper} L ${i + w} ${g.mean} L ${i} ${g.ci_lower} Z`,
            line: { color: DIAMOND, width: 1.5 },
          },
          { type: 'line', x0: i - w, x1: i + w, y0: g.mean, y1: g.mean, line: { color: DIAMOND, width: 1.5 } },
        )
      }
    })
    return {
      xaxis: axis({
        title: { text: spec.x },
        tickmode: 'array',
        tickvals: spec.levels.map((_, i) => i),
        ticktext: spec.levels,
        range: [-0.6, spec.levels.length - 0.4],
        showgrid: false,
      }),
      yaxis: axis({ title: { text: spec.y } }),
      shapes,
    }
  }, [spec])

  if (!xCol || !yCol) return null
  return <PlotlyChart data={data} layout={layout} height={340} pointRows={(curve, point) => (curve === 0 ? [used[point]] : undefined)} />
}

/** Mosaic plot: column widths follow X's distribution, heights Y's conditional distribution. */
export function MosaicChart({ spec, rows, columns }: PlotProps<MosaicPlot>) {
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const xCol = columns.get(spec.x)
  const yCol = columns.get(spec.y)

  // cells[i][j] = rows with x level i and y level j
  const cells = useMemo(() => {
    const grid = spec.x_levels.map(() => spec.y_levels.map(() => [] as number[]))
    if (!xCol || !yCol) return grid
    const xi = new Map(spec.x_levels.map((l, i) => [l, i]))
    const yi = new Map(spec.y_levels.map((l, j) => [l, j]))
    for (const r of rows) {
      const i = xi.get(labelAt(xCol, r) ?? '')
      const j = yi.get(labelAt(yCol, r) ?? '')
      if (i !== undefined && j !== undefined) grid[i][j].push(r)
    }
    return grid
  }, [rows, xCol, yCol, spec])

  const { data, layout } = useMemo(() => {
    const totals = cells.map((row) => row.reduce((n, c) => n + c.length, 0))
    const grand = totals.reduce((a, b) => a + b, 0) || 1
    const gap = 0.01
    const centers: number[] = []
    const widths: number[] = []
    let left = 0
    for (const t of totals) {
      const w = t / grand
      centers.push(left + w / 2)
      widths.push(Math.max(0, w - gap))
      left += w
    }
    const traces: Data[] = []
    spec.y_levels.forEach((level, j) => {
      const color = paletteColor(j)
      const sel = cells.map((row, i) => (totals[i] ? row[j].reduce((n, r) => n + selected[r], 0) / totals[i] : 0))
      const all = cells.map((row, i) => (totals[i] ? row[j].length / totals[i] : 0))
      const common = {
        type: 'bar' as const,
        x: centers,
        width: widths,
        selected: { marker: { opacity: 1 } },
        unselected: { marker: { opacity: 1 } },
      }
      traces.push(
        { ...common, y: sel, marker: { color, line: { color: '#fff', width: 0 } }, hoverinfo: 'skip', showlegend: false },
        {
          ...common,
          y: all.map((a, i) => a - sel[i]),
          name: level,
          marker: { color: nSelected ? tint(color) : color, line: { color: '#fff', width: 0.5 } },
          customdata: cells.map((row) => row[j].length),
          text: spec.x_levels,
          textposition: 'none',
          hovertemplate: `${spec.x}: %{text}<br>${spec.y}: ${level}<br>Count: %{customdata}<extra></extra>`,
        },
      )
    })
    const plotLayout: Partial<Layout> = {
      barmode: 'stack',
      bargap: 0,
      showlegend: true,
      legend: { title: { text: spec.y }, traceorder: 'reversed' },
      xaxis: axis({ title: { text: spec.x }, range: [0, 1], tickmode: 'array', tickvals: centers, ticktext: spec.x_levels, showgrid: false }),
      yaxis: axis({ title: { text: spec.y }, range: [0, 1], showgrid: false }),
    }
    return { data: traces, layout: plotLayout }
  }, [cells, spec, selected, nSelected])

  if (!xCol || !yCol) return null
  return <PlotlyChart data={data} layout={layout} height={320} pointRows={(curve, point) => cells[point]?.[Math.floor(curve / 2)]} />
}

/** Interpolate y at x on a curve sampled at ascending xs. */
function interpolate(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0]
  const last = xs.length - 1
  if (x >= xs[last]) return ys[last]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo])
  return ys[lo] + t * (ys[hi] - ys[lo])
}

/** Logistic plot: cumulative probability curves with each point placed inside its level's band. */
export function LogisticChart({ spec, rows, columns }: PlotProps<LogisticPlot>) {
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const xCol = columns.get(spec.x)
  const yCol = columns.get(spec.y)
  const levelIndex = useMemo(() => new Map(spec.y_levels.map((l, i) => [l, i])), [spec.y_levels])
  const used = useMemo(
    () => (xCol && yCol ? completeRows(rows, [xCol, yCol]).filter((r) => levelIndex.has(labelAt(yCol, r)!)) : []),
    [rows, xCol, yCol, levelIndex],
  )

  const data = useMemo<Data[]>(() => {
    if (!xCol || !yCol || spec.curve_x.length === 0) return []
    const last = spec.y_levels.length - 1
    const band = (k: number, x: number) => (k < 0 ? 0 : k >= last ? 1 : interpolate(spec.curve_x, spec.cum_probs[k], x))
    const xs = used.map((r) => numberAt(xCol, r)!)
    const ys = used.map((r, i) => {
      const k = levelIndex.get(labelAt(yCol, r)!)!
      const lo = band(k - 1, xs[i])
      const hi = band(k, xs[i])
      return lo + (0.1 + 0.8 * rowNoise(r, 7)) * (hi - lo)
    })
    const traces: Data[] = [
      pointTrace(xs, ys, used, selected, nSelected, {
        marker: { color: used.map((r) => paletteColor(levelIndex.get(labelAt(yCol, r)!)!)), size: 6, opacity: 0.85 },
        text: used.map((r) => labelAt(yCol, r)),
        hovertemplate: `Row %{customdata}<br>${spec.x}: %{x}<br>${spec.y}: %{text}<extra></extra>`,
      }),
    ]
    spec.cum_probs.forEach((ys2, k) => {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: spec.curve_x,
        y: ys2,
        line: { color: FIT, width: 2 },
        hovertemplate: `P(${spec.y} ≤ ${spec.y_levels[k]}) = %{y:.3f}<extra></extra>`,
      })
    })
    return traces
  }, [xCol, yCol, used, levelIndex, spec, selected, nSelected])

  const layout = useMemo<Partial<Layout>>(() => {
    const xMax = spec.curve_x[spec.curve_x.length - 1] ?? 0
    const last = spec.y_levels.length - 1
    const band = (k: number) => (k < 0 ? 0 : k >= last ? 1 : spec.cum_probs[k][spec.cum_probs[k].length - 1])
    return {
      margin: { l: 56, r: 90, t: 12, b: 44 },
      xaxis: axis({ title: { text: spec.x } }),
      yaxis: axis({ title: { text: spec.y }, range: [0, 1] }),
      annotations: spec.y_levels.map((level, k) => ({
        x: xMax,
        y: (band(k - 1) + band(k)) / 2,
        xref: 'x' as const,
        yref: 'y' as const,
        xanchor: 'left' as const,
        xshift: 8,
        showarrow: false,
        text: level,
        font: { color: paletteColor(k) },
      })),
    }
  }, [spec])

  if (!xCol || !yCol) return null
  return <PlotlyChart data={data} layout={layout} height={340} pointRows={(curve, point) => (curve === 0 ? [used[point]] : undefined)} />
}
