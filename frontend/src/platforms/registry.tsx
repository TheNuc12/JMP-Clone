import type { ReportConfig, TableDoc } from '../state/store'
import { findColumn } from '../state/store'
import { FitModelReport } from './fitModel/FitModelReport'
import { GraphBuilder } from './GraphBuilder'
import { PlatformReport } from './PlatformReport'

const NAMES: Record<ReportConfig['kind'], string> = {
  distribution: 'Distribution',
  fit_y_by_x: 'Fit Y by X',
  fit_model: 'Fit Model',
  control_chart: 'Control Chart',
  capability: 'Process Capability',
  graph_builder: 'Graph Builder',
}

/** Tab title: platform name plus the columns it analyzes. */
export function reportTitle(report: ReportConfig, table: TableDoc | null): string {
  const names = (role: string) => (report.roles[role] ?? []).map((id) => findColumn(table, id)?.name ?? '?')
  const y = names('y')
  const x = names('x')
  const detail = report.kind === 'fit_y_by_x' || report.kind === 'graph_builder' ? [y.join(', '), x.join(', ')].filter(Boolean).join(' by ') : y.join(', ')
  return detail ? `${NAMES[report.kind]} · ${detail}` : NAMES[report.kind]
}

export function ReportView({ report }: { report: ReportConfig }) {
  switch (report.kind) {
    case 'graph_builder':
      return <GraphBuilder report={report} />
    case 'fit_model':
      return <FitModelReport report={report} />
    default:
      return <PlatformReport report={report} />
  }
}
