import type { ModelingType } from '../api/types'
import { useActiveTable, useStore } from '../state/store'
import { Menu } from './Menu'
import { ModelingIcon } from './ModelingIcon'

export const COLUMN_DRAG_TYPE = 'application/x-sift-column'

const TYPES: ModelingType[] = ['continuous', 'ordinal', 'nominal']
const LABELS: Record<ModelingType, string> = { continuous: 'Continuous', ordinal: 'Ordinal', nominal: 'Nominal' }

/** Column list with modeling types (click the icon to change it); columns can be dragged into Graph Builder. */
export function ColumnsPanel() {
  const table = useActiveTable()
  const setModelingType = useStore((s) => s.setModelingType)
  const activeColumnId = useStore((s) => s.activeColumnId)
  const setActiveColumn = useStore((s) => s.setActiveColumn)
  const openDialog = useStore((s) => s.openDialog)
  if (!table) return null
  return (
    <div className="side-section">
      <div className="side-title">
        Columns <span className="muted">({table.columns.length})</span>
      </div>
      <ul className="column-list">
        {table.columns.map((c) => (
          <li
            key={c.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(COLUMN_DRAG_TYPE, c.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className={activeColumnId === c.id ? 'active' : ''}
            onClick={() => setActiveColumn(c.id)}
            onDoubleClick={() => openDialog({ kind: 'column_info', columnId: c.id })}
            title={`${c.name} — ${c.dataType}, ${c.modelingType}${c.props.formula ? ', formula' : ''}. Double-click for Column Info.`}
          >
            <Menu
              trigger={<ModelingIcon type={c.modelingType} />}
              triggerClassName="icon-button"
              items={TYPES.map((t) => ({
                label: LABELS[t],
                checked: c.modelingType === t,
                disabled: t === 'continuous' && c.dataType === 'character',
                hint: t === 'continuous' && c.dataType === 'character' ? 'Character columns cannot be continuous' : undefined,
                onSelect: () => setModelingType(c.id, t),
              }))}
            />
            <span className="column-name">{c.name}</span>
            {c.props.formula && (
              <span className={`formula-badge${c.formulaError ? ' error' : ''}`} title={c.formulaError ?? `Formula: ${c.props.formula}`}>
                ƒ
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RowsPanel() {
  const table = useActiveTable()
  if (!table) return null
  const { nSelected, nExcluded } = table
  return (
    <div className="side-section">
      <div className="side-title">Rows</div>
      <table className="rows-table">
        <tbody>
          <tr>
            <th>All rows</th>
            <td>{table.nRows}</td>
          </tr>
          <tr>
            <th>Selected</th>
            <td>{nSelected}</td>
          </tr>
          <tr>
            <th>Excluded</th>
            <td>{nExcluded}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
