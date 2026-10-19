import { useStore } from '../state/store'

/** One tab per open data table. */
export function TableTabs() {
  const tables = useStore((s) => s.tables)
  const activeTableId = useStore((s) => s.activeTableId)
  const setActiveTable = useStore((s) => s.setActiveTable)
  const closeTable = useStore((s) => s.closeTable)
  return (
    <nav className="tabs table-tabs" role="tablist" aria-label="Data tables">
      {tables.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTableId} className={`tab${t.id === activeTableId ? ' active' : ''}`}>
          <button className="tab-title" onClick={() => setActiveTable(t.id)} title={`${t.name}: ${t.nRows} rows, ${t.columns.length} columns`}>
            {t.name}
          </button>
          <button className="tab-close" aria-label={`Close ${t.name}`} onClick={() => closeTable(t.id)}>
            ×
          </button>
        </div>
      ))}
    </nav>
  )
}
