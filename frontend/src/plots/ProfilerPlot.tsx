import type { ProfilerPlot } from '../api/types'
import type { Column } from '../state/store'

/** Interactive prediction profiler for a fitted least squares model. */
export function ProfilerChart({ spec }: { spec: ProfilerPlot; rows: number[]; columns: Map<string, Column> }) {
  return <p className="report-text">Prediction profiler for {spec.model.response} is not implemented yet.</p>
}
