import type { ReportConfig } from '../../state/store'

/** Fit Model report: one model fit per response. */
export function FitModelReport({ report }: { report: ReportConfig }) {
  void report
  return <p className="report-text">Fit Model reports are not implemented yet.</p>
}
