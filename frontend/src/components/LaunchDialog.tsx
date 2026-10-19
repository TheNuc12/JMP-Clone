import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { Column } from '../state/store'
import { useActiveTable, useStore } from '../state/store'
import { COLUMN_DRAG_TYPE } from './ColumnsPanel'
import { Modal } from './Modal'
import { ModelingIcon } from './ModelingIcon'

export interface RoleSpec {
  key: string
  label: string
  hint: string
  /** Default true: OK stays disabled until the role has a column. */
  required?: boolean
  /** Maximum number of columns; casting into a full single-column role replaces it. */
  max?: number
  /** Columns the role accepts; others are refused with `acceptHint`. */
  accept?: (column: Column) => boolean
  acceptHint?: string
}

interface Props {
  title: string
  description: string
  roles: RoleSpec[]
  /** Pre-filled role assignments (column ids). */
  initial?: Record<string, string[]>
  /** Extra settings shown under the roles. */
  aside?: ReactNode
  /** Extra condition for enabling OK (e.g. a valid setting in `aside`). */
  canLaunch?: (assignments: Record<string, string[]>) => boolean
  onLaunch: (assignments: Record<string, string[]>) => void
  onCancel: () => void
  className?: string
}

/** Platform launch window: select columns and cast them into roles. Assignments are column ids. */
export function LaunchDialog({ title, description, roles, initial, aside, canLaunch, onLaunch, onCancel, className = '' }: Props) {
  const table = useActiveTable()
  const notify = useStore((s) => s.notify)
  const [picked, setPicked] = useState<string[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)
  const [assigned, setAssigned] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(roles.map((r) => [r.key, initial?.[r.key] ?? []])),
  )

  if (!table) return null
  const ids = table.columns.map((c) => c.id)
  const byId = new Map(table.columns.map((c) => [c.id, c]))

  const pick = (index: number, e: MouseEvent) => {
    const id = ids[index]
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
      setPicked(ids.slice(a, b + 1))
    } else if (e.ctrlKey || e.metaKey) {
      setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id])
      setAnchor(index)
    } else {
      setPicked([id])
      setAnchor(index)
    }
  }

  const cast = (roleKey: string, columnIds: string[]) => {
    const role = roles.find((r) => r.key === roleKey)!
    const accepted = columnIds.filter((id) => !role.accept || role.accept(byId.get(id)!))
    if (accepted.length < columnIds.length) notify(role.acceptHint ?? `Some columns can't be used as ${role.label}.`, 'error')
    if (!accepted.length) return
    setAssigned((a) => {
      let next = [...a[roleKey], ...accepted.filter((c) => !a[roleKey].includes(c))]
      if (role.max !== undefined && next.length > role.max) next = next.slice(-role.max)
      return { ...a, [roleKey]: next }
    })
    setPicked([])
  }

  const remove = (role: string, id: string) => setAssigned((a) => ({ ...a, [role]: a[role].filter((c) => c !== id) }))

  const onDrop = (role: string) => (e: DragEvent) => {
    e.preventDefault()
    const name = e.dataTransfer.getData(COLUMN_DRAG_TYPE)
    const column = table.columns.find((c) => c.id === name || c.name === name)
    if (column) cast(role, picked.includes(column.id) ? picked : [column.id])
  }

  const ready = roles.every((r) => r.required === false || assigned[r.key].length > 0) && (!canLaunch || canLaunch(assigned))

  return (
    <Modal
      title={title}
      description={description}
      onClose={onCancel}
      className={`launch-dialog ${className}`}
      footer={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={() => onLaunch(assigned)}>
            OK
          </button>
        </>
      }
    >
      <div className="launch-body">
        <div className="launch-columns">
          <div className="launch-section-title">Select Columns</div>
          <ul className="launch-list" role="listbox" aria-multiselectable="true">
            {table.columns.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={picked.includes(c.id)}
                className={picked.includes(c.id) ? 'picked' : ''}
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault()
                }}
                onClick={(e) => pick(i, e)}
                onDoubleClick={() => cast(roles[0].key, [c.id])}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(COLUMN_DRAG_TYPE, c.id)}
              >
                <ModelingIcon type={c.modelingType} /> {c.name}
              </li>
            ))}
          </ul>
        </div>
        <div className="launch-roles">
          <div className="launch-section-title">Cast Selected Columns into Roles</div>
          {roles.map((role) => (
            <div key={role.key} className="role-row">
              <button className="role-button" onClick={() => cast(role.key, picked)} disabled={!picked.length} title={role.hint}>
                {role.label}
                {role.required === false && <span className="role-optional">optional</span>}
              </button>
              <ul
                className="role-list"
                onDragOver={(e) => e.dataTransfer.types.includes(COLUMN_DRAG_TYPE) && e.preventDefault()}
                onDrop={onDrop(role.key)}
              >
                {assigned[role.key].length === 0 && <li className="role-placeholder">{role.hint}</li>}
                {assigned[role.key].map((id) => {
                  const c = byId.get(id)
                  if (!c) return null
                  return (
                    <li key={id}>
                      <ModelingIcon type={c.modelingType} /> {c.name}
                      <button className="chip-remove" aria-label={`Remove ${c.name}`} onClick={() => remove(role.key, id)}>
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          {aside}
        </div>
      </div>
    </Modal>
  )
}

/** The four Fit Y by X analyses and when each applies. */
export function FitYByXGuide() {
  const cell = (title: string, y: string, x: string) => (
    <div className="guide-cell">
      <strong>{title}</strong>
      <span>
        {y} Y · {x} X
      </span>
    </div>
  )
  return (
    <div className="fit-guide">
      {cell('Bivariate', 'continuous', 'continuous')}
      {cell('Oneway', 'continuous', 'categorical')}
      {cell('Logistic', 'categorical', 'continuous')}
      {cell('Contingency', 'categorical', 'categorical')}
    </div>
  )
}
