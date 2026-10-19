import type { AnalysisResult } from '../../api/types'
import type { MenuItem } from '../../components/Menu'
import { findModel, predictionFormula, predictRows } from '../../lib/model'
import type { Column, ReportConfig } from '../../state/store'
import { findColumn, useActiveTable, useStore } from '../../state/store'
import { AnalysisPanel } from '../AnalysisPanel'

/** Fit Model report: one model fit per response. */
export function FitModelReport({ report }: { report: ReportConfig }) {
  const table = useActiveTable()
  const updateReport = useStore((s) => s.updateReport)
  const addColumn = useStore((s) => s.addColumn)
  const notify = useStore((s) => s.notify)
  if (!table) return null

  const effectIds = (report.params.effects as string[][] | undefined) ?? []
  const effects = effectIds.map((e) => e.map((id) => findColumn(table, id)?.name ?? id))
  const params = { ...report.params, effects }
  const allRows = Array.from({ length: table.nRows }, (_, i) => i)

  const saveItems = (yId: string, columns: Map<string, Column>, result: AnalysisResult): MenuItem[] => {
    if (result.analysis === 'fit_model_logistic') return []
    const model = findModel(result.nodes)
    const response = findColumn(table, yId)
    const hint = model ? undefined : 'Turn on the Prediction Profiler to save model columns'
    const save = (name: string, values: (number | null)[], formula?: string) => {
      addColumn({ name, dataType: 'numeric', modelingType: 'continuous', values, props: formula ? { formula } : {} })
      notify(`Added column ${name}`)
    }
    return [
      {
        label: 'Save Predicteds',
        disabled: !model,
        hint,
        onSelect: () => model && save(`Pred ${model.response}`, predictRows(model, columns, allRows)),
      },
      {
        label: 'Save Residuals',
        disabled: !model || !response,
        hint,
        onSelect: () => {
          if (!model || !response) return
          const pred = predictRows(model, columns, allRows)
          const resid = pred.map((p, r) => {
            const y = response.values[r]
            return p === null || typeof y !== 'number' ? null : y - p
          })
          save(`Residual ${model.response}`, resid)
        },
      },
      {
        label: 'Save Prediction Formula',
        disabled: !model,
        hint,
        onSelect: () => model && save(`Pred Formula ${model.response}`, predictRows(model, columns, allRows), predictionFormula(model)),
      },
    ]
  }

  return (
    <div className="report-stack">
      {(report.roles.y ?? []).map((yId) => (
        <AnalysisPanel
          key={yId}
          platform="fit_model"
          y={yId}
          roles={{ factors: report.roles.factors ?? [] }}
          params={params}
          options={report.options[yId] ?? {}}
          onOptionsChange={(o) => updateReport(report.id, (r) => ({ ...r, options: { ...r.options, [yId]: o } }))}
          menuItems={(result, ctx) => saveItems(yId, ctx.columns, result)}
        />
      ))}
    </div>
  )
}
