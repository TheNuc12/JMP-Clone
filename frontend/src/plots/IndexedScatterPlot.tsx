import { useMemo } from 'react'
import type { Data, Layout, Shape } from 'plotly.js'
import type { IndexedScatterPlot } from '../api/types'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { selectedPoints } from '../lib/data'
import { FIT, POINT } from '../lib/theme'
import type { Column } from '../state/store'
import { useNSelected, useSelected } from '../state/store'

/** Points computed by the engine (residuals, actual by predicted, ...), linked to table rows. */
export function IndexedScatterChart({ spec, rows }: { spec: IndexedScatterPlot; rows: number[]; columns: Map<string, Column> }) {
  const selected = useSelected()
  const nSelected = useNSelected()
  const tableRows = useMemo(() => spec.indices.map((i) => rows[i]), [spec.indices, rows])

  const data = useMemo<Data[]>(
    () => [
      {
        type: 'scatter',
        mode: 'markers',
        x: spec.x,
        y: spec.y,
        customdata: tableRows.map((r) => r + 1),
        marker: { color: POINT, size: 6, opacity: 0.85 },
        hovertemplate: `Row %{customdata}<br>${spec.x_label}: %{x}<br>${spec.y_label}: %{y}<extra></extra>`,
        selectedpoints: selectedPoints(tableRows, selected, nSelected) ?? undefined,
        selected: { marker: { opacity: 1, size: 8 } },
        unselected: { marker: { opacity: 0.2 } },
      } as Data,
      ...spec.curves.map(
        (c): Data => ({ type: 'scatter', mode: 'lines', x: c.x, y: c.y, name: c.label, line: { color: FIT, width: 1.5 }, hoverinfo: 'skip' }),
      ),
    ],
    [spec, tableRows, selected, nSelected],
  )

  const layout = useMemo<Partial<Layout>>(
    () => ({
      xaxis: axis({ title: { text: spec.x_label } }),
      yaxis: axis({ title: { text: spec.y_label } }),
      shapes: spec.hlines.map(
        (h): Partial<Shape> => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: h.value, y1: h.value, line: { color: '#868e96', width: 1, dash: 'dot' } }),
      ),
    }),
    [spec],
  )

  return <PlotlyChart data={data} layout={layout} height={300} pointRows={(curve, point) => (curve === 0 ? [tableRows[point]] : undefined)} />
}
