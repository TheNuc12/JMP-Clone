import type { ReportConfig } from '../state/store'
import { useStore } from '../state/store'
import { AnalysisPanel } from './AnalysisPanel'

type DistributionConfig = Extract<ReportConfig, { kind: 'distribution' }>
type FitConfig = Extract<ReportConfig, { kind: 'fit_y_by_x' }>

function useOptionSetter(id: string) {
  const updateReport = useStore((s) => s.updateReport)
  return (key: string, options: Record<string, boolean>) =>
    updateReport(id, (r) => ('options' in r ? { ...r, options: { ...r.options, [key]: options } } : r))
}

/** Distribution platform: one panel per Y column, laid out side by side like JMP. */
export function DistributionReport({ report }: { report: DistributionConfig }) {
  const setOptions = useOptionSetter(report.id)
  return (
    <div className="report-columns">
      {report.y.map((y) => (
        <AnalysisPanel
          key={y}
          platform="distribution"
          y={y}
          options={report.options[y] ?? {}}
          onOptionsChange={(o) => setOptions(y, o)}
        />
      ))}
    </div>
  )
}

/** Fit Y by X: one panel per (Y, X) pair; the analysis type follows the modeling types. */
export function FitYByXReport({ report }: { report: FitConfig }) {
  const setOptions = useOptionSetter(report.id)
  return (
    <div className="report-stack">
      {report.y.flatMap((y) =>
        report.x.map((x) => {
          const key = `${y}|${x}`
          return (
            <AnalysisPanel
              key={key}
              platform="fit_y_by_x"
              y={y}
              x={x}
              options={report.options[key] ?? {}}
              onOptionsChange={(o) => setOptions(key, o)}
            />
          )
        }),
      )}
    </div>
  )
}
