import { useEffect, useMemo, useState } from 'react'
import { LaunchDialog } from '../../components/LaunchDialog'
import { labelAt } from '../../lib/data'
import { levelsOf } from '../../lib/levels'
import type { Column } from '../../state/store'
import { findColumn, isCategorical, useActiveTable, useStore } from '../../state/store'
import { acceptsY, buildChartParams, CHART_TYPES, chartNeeds, EMPTY_LIMITS, limitsToText, yHint, type ChartType, type LimitText } from './settings'
import { SpecLimitFields } from './SpecLimitFields'
import './quality.css'

/** Analyze › Control Chart: pick the chart type and cast the process column (and optional subgroups). */
export function ControlChartDialog({ onClose }: { onClose: () => void }) {
  const table = useActiveTable()
  const openReport = useStore((s) => s.openReport)
  const [chartType, setChartType] = useState<ChartType>('imr')
  const [assigned, setAssigned] = useState<Record<string, string[]>>({})
  const [subgroupSize, setSubgroupSize] = useState('5')
  const [sampleSize, setSampleSize] = useState('')
  const [defectLevel, setDefectLevel] = useState('')
  const [limits, setLimits] = useState<LimitText>(EMPTY_LIMITS)

  const ys = (assigned.y ?? []).map((id) => findColumn(table, id)).filter((c): c is Column => !!c)
  const firstY = ys[0]
  const needs = chartNeeds(chartType, firstY, (assigned.subgroup ?? []).length > 0, (assigned.sample_size ?? []).length > 0)

  // Prefill spec limits from the first Y column's Spec Limits property.
  useEffect(() => {
    setLimits(limitsToText(firstY?.props.specLimits))
  }, [firstY?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- only when the first Y changes

  const levels = useMemo(() => {
    if (!table || !firstY || !isCategorical(firstY.modelingType)) return []
    return levelsOf(
      Array.from({ length: table.nRows }, (_, r) => labelAt(firstY, r)),
      firstY.props.valueOrder,
    )
  }, [table, firstY])
  const level = levels.includes(defectLevel) ? defectLevel : (levels[0] ?? '')

  const { params, error } = buildChartParams({ chartType, subgroupSize, sampleSize, defectLevel: level, limits }, needs, ys)
  const description = CHART_TYPES.find((t) => t.value === chartType)!.description

  return (
    <LaunchDialog
      title="Control Chart"
      description="Track a process over time and flag points outside its control limits."
      className="quality-dialog"
      roles={[
        {
          key: 'y',
          label: 'Y, Process',
          hint: yHint(chartType),
          accept: (c) => acceptsY(chartType, c),
          acceptHint: `${CHART_TYPES.find((t) => t.value === chartType)!.label} charts need a numeric column.`,
        },
        { key: 'subgroup', label: 'Subgroup', hint: 'Optional: rows with the same label form a subgroup', required: false, max: 1 },
        {
          key: 'sample_size',
          label: 'Sample Size',
          hint: 'Optional: units inspected per row (P, NP, U)',
          required: false,
          max: 1,
          accept: (c) => !isCategorical(c.modelingType),
          acceptHint: 'Sample Size needs a numeric column.',
        },
      ]}
      onAssignedChange={setAssigned}
      canLaunch={() => error === null}
      onLaunch={(a) => {
        const roles: Record<string, string[]> = { y: a.y }
        if (a.subgroup?.length) roles.subgroup = a.subgroup
        if (a.sample_size?.length) roles.sample_size = a.sample_size
        openReport({ kind: 'control_chart', roles, params })
        onClose()
      }}
      onCancel={onClose}
      aside={
        <div className="quality-settings">
          <div className="section-title">Chart</div>
          <div className="form-grid">
            <label htmlFor="cc-type">Chart type</label>
            <select id="cc-type" value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
              {CHART_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {needs.subgroupSize && (
              <>
                <label htmlFor="cc-size">Subgroup size</label>
                <input id="cc-size" type="number" min={1} step={1} value={subgroupSize} onChange={(e) => setSubgroupSize(e.target.value)} />
              </>
            )}
            {needs.sampleSize && (
              <>
                <label htmlFor="cc-n">Sample size</label>
                <input id="cc-n" type="number" min={1} placeholder="units per row" value={sampleSize} onChange={(e) => setSampleSize(e.target.value)} />
              </>
            )}
            {needs.defectLevel && (
              <>
                <label htmlFor="cc-level">Nonconforming level</label>
                <select id="cc-level" value={level} onChange={(e) => setDefectLevel(e.target.value)}>
                  {levels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <p className="quality-hint">{description}</p>
          {needs.specLimits && (
            <>
              <div className="section-title">
                Spec limits <span className="muted">(optional; adds capability)</span>
              </div>
              <SpecLimitFields value={limits} onChange={setLimits} idPrefix="cc" />
            </>
          )}
          {error && ys.length > 0 && <p className="report-text tone-warning">{error}</p>}
        </div>
      }
    />
  )
}
