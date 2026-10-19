import type { Platform } from '../api/types'
import type { ReportConfig } from '../state/store'
import { useStore } from '../state/store'
import { AnalysisPanel } from './AnalysisPanel'

/**
 * Report for platforms whose request is "one Y (and maybe one X) plus extra roles and
 * params": Distribution, Fit Y by X, Control Chart and Process Capability. One panel per
 * Y column, or per (Y, X) pair for Fit Y by X.
 */
export function PlatformReport({ report }: { report: ReportConfig }) {
  const updateReport = useStore((s) => s.updateReport)
  const setOptions = (key: string, options: Record<string, boolean>) =>
    updateReport(report.id, (r) => ({ ...r, options: { ...r.options, [key]: options } }))
  const { y = [], x = [], ...otherRoles } = report.roles
  const platform = report.kind as Platform
  // params.per_y holds settings that differ by Y column (e.g. each column's spec limits).
  const { per_y: perY, ...shared } = report.params as { per_y?: Record<string, Record<string, unknown>> }

  const panels =
    report.kind === 'fit_y_by_x'
      ? y.flatMap((yId) => x.map((xId) => ({ key: `${yId}|${xId}`, y: yId, x: xId })))
      : y.map((yId) => ({ key: yId, y: yId, x: undefined }))

  return (
    <div className={report.kind === 'distribution' ? 'report-columns' : 'report-stack'}>
      {panels.map((p) => (
        <AnalysisPanel
          key={p.key}
          platform={platform}
          y={p.y}
          x={p.x}
          roles={otherRoles}
          params={{ ...shared, ...perY?.[p.y] }}
          options={report.options[p.key] ?? {}}
          onOptionsChange={(o) => setOptions(p.key, o)}
        />
      ))}
    </div>
  )
}
