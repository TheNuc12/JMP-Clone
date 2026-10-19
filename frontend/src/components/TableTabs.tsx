import { useState } from 'react'
import { useStore } from '../state/store'
import './data.css'

/** One tab per open data table. Double-click a tab to rename it. */
export function TableTabs() {
  const tables = useStore((s) => s.tables)
  const activeTableId = useStore((s) => s.activeTableId)
  const setActiveTable = useStore((s) => s.setActiveTable)
  const renameTable = useStore((s) => s.renameTable)
  const closeTable = useStore((s) => s.closeTable)
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)

  const finishRename = () => {
    if (renaming && renaming.text.trim()) renameTable(renaming.id, renaming.text.trim())
    setRenaming(null)
  }

  const close = (id: string, name: string) => {
    // Closing can't be undone, so confirm when the table has edits.
    const edited = (useStore.getState().history[id]?.past.length ?? 0) > 0
    if (edited && !window.confirm(`Close ${name}? Your edits to this table will be lost unless you saved the session.`)) return
    closeTable(id)
  }

  return (
    <nav className="tabs table-tabs" role="tablist" aria-label="Data tables">
      {tables.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTableId} className={`tab${t.id === activeTableId ? ' active' : ''}`}>
          {renaming?.id === t.id ? (
            <input
              className="tab-rename"
              value={renaming.text}
              autoFocus
              aria-label="Table name"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenaming({ id: t.id, text: e.target.value })}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishRename()
                else if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              className="tab-title"
              onClick={() => setActiveTable(t.id)}
              onDoubleClick={() => setRenaming({ id: t.id, text: t.name })}
              title={`${t.name}: ${t.nRows} rows, ${t.columns.length} columns. Double-click to rename.`}
            >
              {t.name}
            </button>
          )}
          <button className="tab-close" aria-label={`Close ${t.name}`} onClick={() => close(t.id, t.name)}>
            ×
          </button>
        </div>
      ))}
    </nav>
  )
}
