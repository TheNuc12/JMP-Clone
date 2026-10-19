import { useMemo } from 'react'
import type { Data, Layout, Shape } from 'plotly.js'
import type { BarPlot, HistogramPlot } from '../api/types'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { completeRows, groupRows, numberAt } from '../lib/data'
import { binCount, binIndex } from '../lib/stats'
import { BAR, BAR_EDGE, BAR_SELECTED, BOX, DIAMOND, FIT, POINT } from '../lib/theme'
import type { Column } from '../state/store'
import { useStore } from '../state/store'
import { formatNumber } from '../lib/format'

interface PlotProps<S> {
  spec: S
  rows: number[]
  columns: Map<string, Column>
}

/** Histogram (with selected rows shaded) and an outlier box plot above it. */
export function HistogramChart({ spec, rows, columns }: PlotProps<HistogramPlot>) {
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const column = columns.get(spec.column)

  const binned = useMemo(() => {
    if (!column) return null
    const used = completeRows(rows, [column])
    const nBins = binCount(spec.bins)
    const rowsPerBin: number[][] = Array.from({ length: nBins }, () => [])
    for (const r of used) rowsPerBin[binIndex(numberAt(column, r)!, spec.bins)].push(r)
    return { used, rowsPerBin }
  }, [column, rows, spec.bins])

  const outliers = useMemo(() => {
    if (!column || !binned || !spec.box) return []
    const { lower_whisker, upper_whisker } = spec.box
    return binned.used.filter((r) => {
      const v = numberAt(column, r)!
      return v < lower_whisker || v > upper_whisker
    })
  }, [column, binned, spec.box])

  const { data, layout } = useMemo(() => {
    if (!column || !binned) return { data: [], layout: {} }
    const { start, size } = spec.bins
    const centers = binned.rowsPerBin.map((_, i) => start + size * (i + 0.5))
    const counts = binned.rowsPerBin.map((b) => b.length)
    const selectedCounts = binned.rowsPerBin.map((b) => b.reduce((n, r) => n + selected[r], 0))
    const hover = binned.rowsPerBin.map(
      (b, i) => `${formatNumber(start + size * i)} – ${formatNumber(start + size * (i + 1))}<br>Count: ${b.length}`,
    )
    const hasBox = spec.box !== null
    const histDomain: [number, number] = hasBox ? [0, 0.8] : [0, 1]
    const traces: Data[] = [
      {
        type: 'bar',
        x: centers,
        y: counts,
        width: size,
        marker: { color: BAR, line: { color: BAR_EDGE, width: 1 } },
        hovertext: hover,
        hoverinfo: 'text',
        selected: { marker: { opacity: 1 } },
        unselected: { marker: { opacity: 1 } },
      } as Data,
      {
        type: 'bar',
        x: centers,
        y: selectedCounts,
        width: size,
        marker: { color: BAR_SELECTED, line: { color: BAR_EDGE, width: 1 } },
        hoverinfo: 'skip',
        selected: { marker: { opacity: 1 } },
        unselected: { marker: { opacity: 1 } },
      } as Data,
    ]
    if (spec.normal) {
      const { mu, sigma } = spec.normal
      const xs: number[] = []
      const ys: number[] = []
      const lo = Math.min(start, mu - 3.5 * sigma)
      const hi = Math.max(spec.bins.end, mu + 3.5 * sigma)
      for (let i = 0; i <= 120; i++) {
        const x = lo + ((hi - lo) * i) / 120
        xs.push(x)
        ys.push((binned.used.length * size * Math.exp(-0.5 * ((x - mu) / sigma) ** 2)) / (sigma * Math.sqrt(2 * Math.PI)))
      }
      traces.push({ type: 'scatter', mode: 'lines', x: xs, y: ys, line: { color: FIT, width: 2 }, hoverinfo: 'skip' })
    }
    const shapes: Partial<Shape>[] = []
    if (spec.box) {
      const b = spec.box
      const line = { color: BOX, width: 1.2 }
      const yref = 'y2' as const
      shapes.push(
        { type: 'rect', xref: 'x', yref, x0: b.q1, x1: b.q3, y0: 0.25, y1: 0.75, line, fillcolor: 'rgba(0,0,0,0)' },
        { type: 'line', xref: 'x', yref, x0: b.median, x1: b.median, y0: 0.25, y1: 0.75, line },
        { type: 'line', xref: 'x', yref, x0: b.lower_whisker, x1: b.q1, y0: 0.5, y1: 0.5, line },
        { type: 'line', xref: 'x', yref, x0: b.q3, x1: b.upper_whisker, y0: 0.5, y1: 0.5, line },
      )
      if (spec.mean_ci) {
        const [lo, hi] = spec.mean_ci
        shapes.push({
          type: 'path',
          xref: 'x',
          yref,
          path: `M ${lo} 0.5 L ${b.mean} 0.68 L ${hi} 0.5 L ${b.mean} 0.32 Z`,
          line: { color: DIAMOND, width: 1.2 },
        })
      }
      traces.push({
        type: 'scatter',
        mode: 'markers',
        x: outliers.map((r) => numberAt(column, r)!),
        y: outliers.map(() => 0.5),
        yaxis: 'y2',
        customdata: outliers,
        marker: { color: POINT, size: 6 },
        hovertemplate: 'Row %{customdata}: %{x}<extra></extra>',
        selectedpoints: nSelected ? outliers.flatMap((r, i) => (selected[r] ? [i] : [])) : undefined,
        selected: { marker: { opacity: 1, size: 8 } },
        unselected: { marker: { opacity: 0.25 } },
      } as Data)
    }
    const plotLayout: Partial<Layout> = {
      barmode: 'overlay',
      bargap: 0,
      xaxis: axis({ title: { text: spec.column } }),
      yaxis: axis({ title: { text: 'Count' }, domain: histDomain, rangemode: 'tozero' }),
      yaxis2: { domain: [0.84, 1], range: [0, 1], showticklabels: false, showgrid: false, zeroline: false, fixedrange: true },
      shapes,
    }
    return { data: traces, layout: plotLayout }
  }, [column, binned, outliers, spec, selected, nSelected])

  if (!column || !binned) return null
  return (
    <PlotlyChart
      data={data}
      layout={layout}
      height={280}
      pointRows={(curve, point) => (curve <= 1 ? binned.rowsPerBin[point] : curve === data.length - 1 && spec.box ? [outliers[point]] : undefined)}
    />
  )
}

/** Frequency bar chart for a categorical column; selected rows are shaded. */
export function BarChart({ spec, rows, columns }: PlotProps<BarPlot>) {
  const selected = useStore((s) => s.selected)
  const column = columns.get(spec.column)

  const groups = useMemo(() => (column ? groupRows(rows, column) : new Map<string, number[]>()), [column, rows])

  const data = useMemo<Data[]>(() => {
    const counts = spec.levels.map((l) => groups.get(l)?.length ?? 0)
    const selectedCounts = spec.levels.map((l) => (groups.get(l) ?? []).reduce((n, r) => n + selected[r], 0))
    const common = { type: 'bar' as const, x: spec.levels, selected: { marker: { opacity: 1 } }, unselected: { marker: { opacity: 1 } } }
    return [
      { ...common, y: counts, marker: { color: BAR, line: { color: BAR_EDGE, width: 1 } }, hovertemplate: '%{x}: %{y}<extra></extra>' },
      { ...common, y: selectedCounts, marker: { color: BAR_SELECTED, line: { color: BAR_EDGE, width: 1 } }, hoverinfo: 'skip' },
    ]
  }, [spec.levels, groups, selected])

  const layout = useMemo<Partial<Layout>>(
    () => ({
      barmode: 'overlay',
      bargap: 0.15,
      xaxis: axis({ type: 'category', title: { text: spec.column } }),
      yaxis: axis({ title: { text: 'Count' }, rangemode: 'tozero' }),
    }),
    [spec.column],
  )

  if (!column) return null
  return <PlotlyChart data={data} layout={layout} height={260} pointRows={(_, point) => groups.get(spec.levels[point])} />
}
