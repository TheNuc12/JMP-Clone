import { useMemo } from 'react'
import type { Annotations, Data, Layout } from 'plotly.js'
import type { ControlChartPlot, ControlPoint } from '../api/types'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { formatNumber } from '../lib/format'
import { DIAMOND, POINT, REFERENCE } from '../lib/theme'
import type { Column } from '../state/store'
import { useNSelected, useSelected } from '../state/store'

const ZONE = '#adb5bd'

/**
 * A line through `values` at positions `xs` drawn as steps centred on each point, padded half
 * a unit at both ends, so constant limits read as straight lines and varying limits as steps.
 */
export function stepLine(values: (number | null)[], xs: number[]): { x: number[]; y: (number | null)[] } {
  const n = values.length
  if (n === 0) return { x: [], y: [] }
  return { x: [xs[0] - 0.5, ...xs, xs[n - 1] + 0.5], y: [values[0], ...values, values[n - 1]] }
}

/**
 * X positions for points: their own numbers when every label is an increasing whole number
 * (sample or subgroup numbers, so a moving range chart lines up under its individuals chart),
 * otherwise 1..n with the labels as tick text.
 */
export function pointPositions(points: ControlPoint[]): { xs: number[]; numbered: boolean } {
  const nums = points.map((p) => (/^\d+$/.test(p.label) ? Number(p.label) : NaN))
  const numbered = points.length > 0 && nums.every((v, i) => Number.isFinite(v) && (i === 0 || v > nums[i - 1]))
  return { xs: numbered ? nums : points.map((_, i) => i + 1), numbered }
}

/** Zone line at center + k sigma, with sigma taken from the upper limit (LCLs may be clipped at 0). */
export function zoneValues(points: ControlPoint[], k: number): (number | null)[] {
  return points.map((p) => (p.center === null || p.ucl === null ? null : p.center + (k * (p.ucl - p.center)) / 3))
}

/** Last non-null value of a series, for the limit labels at the right edge. */
function last(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]
  return null
}

function rowList(rows: number[]): string {
  const shown = rows.slice(0, 8).map((r) => r + 1)
  return rows.length > 8 ? `${shown.join(', ')}, … (${rows.length})` : shown.join(', ')
}

/** Control chart with step limits, optional zones, flagged test failures and linked row selection. */
export function ControlChartChart({ spec, rows }: { spec: ControlChartPlot; rows: number[]; columns: Map<string, Column> }) {
  const selected = useSelected()
  const nSelected = useNSelected()
  const pointRows = useMemo(() => spec.points.map((p) => p.indices.map((i) => rows[i])), [spec.points, rows])

  const { data, layout } = useMemo(() => {
    const pts = spec.points
    const n = pts.length
    const { xs, numbered } = pointPositions(pts)
    const xEnd = n ? xs[n - 1] + 0.5 : 0.5
    const values = pts.map((p) => p.value)
    const flagged = pts.map((p) => p.tests.length > 0)
    const centers = pts.map((p) => p.center)
    const ucls = pts.map((p) => p.ucl)
    const lcls = pts.map((p) => p.lcl)
    const selectedPts = nSelected ? pts.flatMap((_, i) => (pointRows[i].some((r) => selected[r]) ? [i] : [])) : undefined

    const traces: Data[] = [
      {
        type: 'scatter',
        mode: 'lines+markers',
        x: xs,
        y: values,
        connectgaps: false,
        line: { color: '#868e96', width: 1 },
        marker: { color: flagged.map((f) => (f ? REFERENCE : POINT)), size: flagged.map((f) => (f ? 8 : 6)) },
        hovertext: pts.map(
          (p, i) =>
            `${spec.x_label} ${p.label}<br>${spec.y_label}: ${p.value === null ? '·' : formatNumber(p.value, 6)}` +
            `<br>Rows: ${rowList(pointRows[i])}` +
            (p.tests.length ? `<br><b>Failed test${p.tests.length > 1 ? 's' : ''} ${p.tests.join(', ')}</b>` : ''),
        ),
        hoverinfo: 'text',
        selectedpoints: selectedPts,
        selected: { marker: { opacity: 1, size: 10 } },
        unselected: { marker: { opacity: 0.25 } },
      } as Data,
    ]
    const step = (ys: (number | null)[], color: string, dash: 'solid' | 'dash' | 'dot', width: number, name: string): Data => ({
      type: 'scatter',
      mode: 'lines',
      ...stepLine(ys, xs),
      line: { color, width, dash, shape: 'hvh' },
      connectgaps: false,
      hoverinfo: 'skip',
      name,
    })
    traces.push(step(centers, DIAMOND, 'solid', 1.5, 'Center'))
    if (ucls.some((v) => v !== null)) traces.push(step(ucls, REFERENCE, 'solid', 1.3, 'UCL'))
    if (lcls.some((v) => v !== null)) traces.push(step(lcls, REFERENCE, 'solid', 1.3, 'LCL'))
    if (spec.show_zones) {
      for (const k of [-2, -1, 1, 2]) traces.push(step(zoneValues(pts, k), ZONE, 'dot', 1, `Zone ${k}σ`))
    }

    const annotations: Partial<Annotations>[] = []
    pts.forEach((p, i) => {
      if (!p.tests.length || p.value === null) return
      annotations.push({
        x: xs[i],
        y: p.value,
        text: p.tests.join(','),
        showarrow: false,
        yshift: 11,
        font: { color: REFERENCE, size: 10 },
      })
    })
    const edge = (value: number | null, label: string, color: string) => {
      if (value === null) return
      annotations.push({
        x: xEnd,
        y: value,
        xanchor: 'left',
        xshift: 4,
        text: `${label}=${formatNumber(value, 5)}`,
        showarrow: false,
        font: { color, size: 10 },
      })
    }
    edge(last(ucls), 'UCL', REFERENCE)
    edge(last(centers), 'Avg', DIAMOND)
    edge(last(lcls), 'LCL', REFERENCE)

    // Numbered points use the default numeric axis; other labels show (thinned) at their points.
    const every = Math.max(1, Math.ceil(n / 25))
    // Numbered axes start at 1, so a moving range chart (first point 2) lines up with its I chart.
    const range = n ? [(numbered ? Math.min(xs[0], 1) : xs[0]) - 0.7, xs[n - 1] + 0.7] : [0, 1]
    const xaxis = numbered
      ? axis({ title: { text: spec.x_label }, range })
      : axis({
          title: { text: spec.x_label },
          range,
          tickmode: 'array',
          tickvals: xs.filter((_, i) => i % every === 0),
          ticktext: pts.filter((_, i) => i % every === 0).map((p) => p.label),
        })

    const plotLayout: Partial<Layout> = {
      margin: { l: 60, r: 96, t: 14, b: 48 },
      xaxis: { ...xaxis, showgrid: false },
      yaxis: axis({ title: { text: spec.y_label } }),
      annotations,
    }
    return { data: traces, layout: plotLayout }
  }, [spec, pointRows, selected, nSelected])

  return (
    <PlotlyChart
      data={data}
      layout={layout}
      height={300}
      uirevision={`${spec.title}|${spec.points.length}`}
      pointRows={(curve, point) => (curve === 0 ? pointRows[point] : undefined)}
    />
  )
}
