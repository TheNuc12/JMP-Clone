import { useEffect, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { COLUMN_DRAG_TYPE } from './ColumnsPanel'
import { ModelingIcon } from './ModelingIcon'

export interface RoleSpec {
  key: string
  label: string
  hint: string
}

interface Props {
  title: string
  description: string
  roles: RoleSpec[]
  aside?: ReactNode
  onLaunch: (assignments: Record<string, string[]>) => void
  onCancel: () => void
}

/** Platform launch window: select columns and cast them into roles. */
export function LaunchDialog({ title, description, roles, aside, onLaunch, onCancel }: Props) {
  const table = useStore((s) => s.table)
  const [picked, setPicked] = useState<string[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)
  const [assigned, setAssigned] = useState<Record<string, string[]>>(() => Object.fromEntries(roles.map((r) => [r.key, []])))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  if (!table) return null
  const names = table.columns.map((c) => c.name)

  const pick = (index: number, e: MouseEvent) => {
    const name = names[index]
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
      setPicked(names.slice(a, b + 1))
    } else if (e.ctrlKey || e.metaKey) {
      setPicked(picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name])
      setAnchor(index)
    } else {
      setPicked([name])
      setAnchor(index)
    }
  }

  const cast = (role: string, columns: string[]) => {
    if (!columns.length) return
    setAssigned((a) => ({ ...a, [role]: [...a[role], ...columns.filter((c) => !a[role].includes(c))] }))
    setPicked([])
  }

  const remove = (role: string, column: string) => setAssigned((a) => ({ ...a, [role]: a[role].filter((c) => c !== column) }))

  const onDrop = (role: string) => (e: DragEvent) => {
    e.preventDefault()
    const name = e.dataTransfer.getData(COLUMN_DRAG_TYPE)
    if (name) cast(role, picked.includes(name) ? picked : [name])
  }

  const ready = roles.every((r) => assigned[r.key].length > 0)
  const typeOf = (name: string) => table.columns.find((c) => c.name === name)!.modelingType

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal launch-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <p>{description}</p>
        </header>
        <div className="launch-body">
          <div className="launch-columns">
            <div className="launch-section-title">Select Columns</div>
            <ul className="launch-list" role="listbox" aria-multiselectable="true">
              {names.map((name, i) => (
                <li
                  key={name}
                  role="option"
                  aria-selected={picked.includes(name)}
                  className={picked.includes(name) ? 'picked' : ''}
                  onMouseDown={(e) => {
                    if (e.shiftKey) e.preventDefault()
                  }}
                  onClick={(e) => pick(i, e)}
                  onDoubleClick={() => cast(roles[0].key, [name])}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(COLUMN_DRAG_TYPE, name)}
                >
                  <ModelingIcon type={typeOf(name)} /> {name}
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
                </button>
                <ul
                  className="role-list"
                  onDragOver={(e) => e.dataTransfer.types.includes(COLUMN_DRAG_TYPE) && e.preventDefault()}
                  onDrop={onDrop(role.key)}
                >
                  {assigned[role.key].length === 0 && <li className="role-placeholder">{role.hint}</li>}
                  {assigned[role.key].map((c) => (
                    <li key={c}>
                      <ModelingIcon type={typeOf(c)} /> {c}
                      <button className="chip-remove" aria-label={`Remove ${c}`} onClick={() => remove(role.key, c)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {aside}
          </div>
        </div>
        <footer className="modal-footer">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={() => onLaunch(assigned)}>
            OK
          </button>
        </footer>
      </div>
    </div>
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
