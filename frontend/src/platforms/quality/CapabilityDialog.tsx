import { useState } from 'react'
import { LaunchDialog } from '../../components/LaunchDialog'
import type { Column } from '../../state/store'
import { findColumn, isCategorical, useActiveTable, useStore } from '../../state/store'
import { hasLimit, limitParams, limitsToText, parseLimits, type LimitText } from './settings'
import './quality.css'

/** Analyze › Process Capability: spec limits for each Y, prefilled from its Spec Limits property. */
export function CapabilityDialog({ onClose }: { onClose: () => void }) {
  const table = useActiveTable()
  const openReport = useStore((s) => s.openReport)
  const updateColumn = useStore((s) => s.updateColumn)
  const [assigned, setAssigned] = useState<Record<string, string[]>>({})
  const [edited, setEdited] = useState<Record<string, LimitText>>({})
  const [saveProps, setSaveProps] = useState(true)

  const ys = (assigned.y ?? []).map((id) => findColumn(table, id)).filter((c): c is Column => !!c)
  const textOf = (c: Column) => edited[c.id] ?? limitsToText(c.props.specLimits)
  const parsed = ys.map((c) => ({ column: c, ...parseLimits(textOf(c)) }))
  const problem =
    parsed.find((p) => p.error)?.error ??
    (parsed.some((p) => !hasLimit(p.limits)) ? `Enter an LSL or USL for ${parsed.find((p) => !hasLimit(p.limits))!.column.name}.` : null)

  const setField = (c: Column, key: keyof LimitText, value: string) => setEdited((e) => ({ ...e, [c.id]: { ...textOf(c), [key]: value } }))

  return (
    <LaunchDialog
      title="Process Capability"
      description="How well a process fits within its specification limits: Cp, Cpk, Pp, Ppk and expected nonconformance."
      className="quality-dialog"
      roles={[
        {
          key: 'y',
          label: 'Y, Process',
          hint: 'Continuous measurements',
          accept: (c) => !isCategorical(c.modelingType),
          acceptHint: 'Process capability needs continuous columns.',
        },
        { key: 'subgroup', label: 'Subgroup', hint: 'Optional: estimate within sigma from subgroups', required: false, max: 1 },
      ]}
      onAssignedChange={setAssigned}
      canLaunch={() => problem === null}
      onLaunch={(a) => {
        const perY: Record<string, Record<string, number>> = {}
        for (const { column, limits } of parsed) {
          perY[column.id] = limitParams(limits)
          const current = column.props.specLimits
          const changed = (['lsl', 'target', 'usl'] as const).some((k) => (current?.[k] ?? null) !== (limits[k] ?? null))
          if (saveProps && changed) updateColumn(column.id, { props: { ...column.props, specLimits: limits } })
        }
        const roles: Record<string, string[]> = { y: a.y }
        if (a.subgroup?.length) roles.subgroup = a.subgroup
        openReport({ kind: 'capability', roles, params: { per_y: perY } })
        onClose()
      }}
      onCancel={onClose}
      aside={
        <div className="quality-settings">
          <div className="section-title">Spec limits</div>
          {ys.length === 0 ? (
            <p className="quality-hint">Cast one or more Y columns to enter their limits.</p>
          ) : (
            <table className="spec-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>LSL</th>
                  <th>Target</th>
                  <th>USL</th>
                </tr>
              </thead>
              <tbody>
                {ys.map((c) => {
                  const text = textOf(c)
                  return (
                    <tr key={c.id}>
                      <td className="spec-name">{c.name}</td>
                      {(['lsl', 'target', 'usl'] as const).map((k) => (
                        <td key={k}>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`${c.name} ${k.toUpperCase()}`}
                            value={text[k]}
                            onChange={(e) => setField(c, k, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <label className="check-row">
            <input type="checkbox" checked={saveProps} onChange={(e) => setSaveProps(e.target.checked)} />
            Save limits as column property
          </label>
          {problem && ys.length > 0 && <p className="report-text tone-warning">{problem}</p>}
        </div>
      }
    />
  )
}
