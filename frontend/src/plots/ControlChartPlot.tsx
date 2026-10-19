import type { ControlChartPlot } from '../api/types'
import type { Column } from '../state/store'

/** Control chart with limits, zones and flagged test failures. */
export function ControlChartChart({ spec }: { spec: ControlChartPlot; rows: number[]; columns: Map<string, Column> }) {
  return <p className="report-text">{spec.title}: chart rendering is not implemented yet.</p>
}
