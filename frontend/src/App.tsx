import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { api } from './api/client'
import logo from './assets/logo.svg'
import type { DataTablePayload, SampleInfo } from './api/types'
import { ColumnsPanel, RowsPanel } from './components/ColumnsPanel'
import { DataGrid } from './components/DataGrid'
import { DialogHost } from './components/DialogHost'
import { Menu, type MenuItem } from './components/Menu'
import { TableTabs } from './components/TableTabs'
import { Welcome } from './components/Welcome'
import { downloadTableCsv } from './lib/csv'
import { downloadSession, isSessionFile, openSessionFile, startAutosave } from './lib/session'
import { reportTitle, ReportView } from './platforms/registry'
import { canRedo, canUndo, useActiveTable, useStore, useTableReports } from './state/store'

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.sift'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
}

export default function App() {
  const table = useActiveTable()
  const hasTables = useStore((s) => s.tables.length > 0)
  const reports = useTableReports()
  const activeReportId = useStore((s) => s.activeReportId)
  const activeColumnId = useStore((s) => s.activeColumnId)
  const dialogOpen = useStore((s) => s.dialog !== null)
  const notice = useStore((s) => s.notice)
  const undoable = useStore(canUndo)
  const redoable = useStore(canRedo)
  const store = useStore.getState

  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [split, setSplit] = useState(0.42)
  const fileInput = useRef<HTMLInputElement>(null)
  const workspace = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.samples().then(setSamples, (e: Error) => store().notify(e.message, 'error'))
  }, [store])

  useEffect(() => startAutosave(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen || isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') store().clearSelection()
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        store().undo()
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        store().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, store])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => store().dismissNotice(), notice.tone === 'error' ? 8000 : 4000)
    return () => clearTimeout(timer)
  }, [notice, store])

  const run = useCallback(
    async (task: () => Promise<string | void>) => {
      setBusy(true)
      try {
        const message = await task()
        if (message) store().notify(message)
      } catch (e) {
        store().notify((e as Error).message, 'error')
      } finally {
        setBusy(false)
      }
    },
    [store],
  )

  const openTable = (fetcher: () => Promise<DataTablePayload>) =>
    run(async () => {
      const payload = await fetcher()
      store().addTable(payload)
      return `Opened ${payload.name}: ${payload.n_rows} rows, ${payload.columns.length} columns`
    })

  const openFile = (file: File | undefined) => {
    if (!file) return
    if (isSessionFile(file)) run(async () => (await openSessionFile(file), `Opened session ${file.name}`))
    else openTable(() => api.upload(file))
  }

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    setDropping(false)
    openFile(e.dataTransfer.files[0])
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const box = workspace.current?.getBoundingClientRect()
    if (!box) return
    const move = (ev: MouseEvent) => setSplit(Math.min(0.8, Math.max(0.15, (ev.clientX - box.left) / box.width)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const safely = (action: () => void) => () => {
    try {
      action()
    } catch (e) {
      store().notify((e as Error).message, 'error')
    }
  }

  const noTable = !table
  const open = store().openDialog
  const nSelected = table?.nSelected ?? 0
  const active = reports.find((r) => r.id === activeReportId) ?? reports[reports.length - 1]

  const fileMenu: MenuItem[] = [
    { label: 'New Data Table', onSelect: () => store().newTable() },
    { label: 'Open…', shortcut: 'CSV · Excel · .sift', onSelect: () => fileInput.current?.click() },
    { label: '', separator: true },
    ...samples.map((s) => ({ label: `Sample: ${s.name}`, onSelect: () => openTable(() => api.sample(s.id)), hint: s.description })),
    { label: '', separator: true },
    { label: 'Save Session…', disabled: !hasTables, onSelect: safely(downloadSession) },
    { label: 'Export Table as CSV…', disabled: noTable, onSelect: safely(() => table && downloadTableCsv(table)) },
    { label: '', separator: true },
    { label: 'Close Table', disabled: noTable, onSelect: () => store().closeTable() },
  ]
  const editMenu: MenuItem[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !undoable, onSelect: () => store().undo() },
    { label: 'Redo', shortcut: 'Ctrl+Shift+Z', disabled: !redoable, onSelect: () => store().redo() },
  ]
  const rowsMenu: MenuItem[] = [
    { label: 'Add Rows…', disabled: noTable, onSelect: () => open({ kind: 'add_rows' }) },
    { label: 'Delete Selected Rows', disabled: noTable || nSelected === 0, onSelect: () => store().deleteRows() },
    { label: '', separator: true },
    { label: 'Select All Rows', disabled: noTable, onSelect: () => store().selectAll() },
    { label: 'Clear Selection', shortcut: 'Esc', disabled: noTable, onSelect: () => store().clearSelection() },
    { label: 'Invert Selection', disabled: noTable, onSelect: () => store().invertSelection() },
    { label: '', separator: true },
    { label: 'Exclude / Unexclude', disabled: noTable || nSelected === 0, onSelect: () => store().toggleExcludeSelected() },
    { label: 'Clear Row States', disabled: noTable, onSelect: () => store().clearRowStates() },
  ]
  const activeColumn = table?.columns.find((c) => c.id === activeColumnId)
  const colsMenu: MenuItem[] = [
    { label: 'New Column…', disabled: noTable, onSelect: () => open({ kind: 'new_column' }) },
    {
      label: activeColumn ? `Column Info: ${activeColumn.name}…` : 'Column Info…',
      disabled: !activeColumn,
      hint: 'Click a column header first',
      onSelect: () => activeColumn && open({ kind: 'column_info', columnId: activeColumn.id }),
    },
    {
      label: activeColumn ? `Delete Column: ${activeColumn.name}` : 'Delete Column',
      disabled: !activeColumn,
      onSelect: () => activeColumn && store().deleteColumns([activeColumn.id]),
    },
  ]
  const doeMenu: MenuItem[] = [
    { label: 'Full Factorial Design…', onSelect: () => open({ kind: 'doe', design: 'full_factorial' }) },
    { label: 'Screening Design (Fractional Factorial)…', onSelect: () => open({ kind: 'doe', design: 'fractional_factorial' }) },
    { label: 'Response Surface Design…', onSelect: () => open({ kind: 'doe', design: 'response_surface' }) },
    { label: 'Custom Design (D-optimal)…', onSelect: () => open({ kind: 'doe', design: 'custom' }) },
  ]
  const analyzeMenu: MenuItem[] = [
    { label: 'Distribution', disabled: noTable, onSelect: () => open({ kind: 'distribution' }) },
    { label: 'Fit Y by X', disabled: noTable, onSelect: () => open({ kind: 'fit_y_by_x' }) },
    { label: 'Fit Model', disabled: noTable, onSelect: () => open({ kind: 'fit_model' }) },
    { label: '', separator: true },
    { label: 'Control Chart', disabled: noTable, onSelect: () => open({ kind: 'control_chart' }) },
    { label: 'Process Capability', disabled: noTable, onSelect: () => open({ kind: 'capability' }) },
  ]
  const graphMenu: MenuItem[] = [
    {
      label: 'Graph Builder',
      disabled: noTable,
      onSelect: () => store().openReport({ kind: 'graph_builder', roles: {}, params: { elements: [] } }),
    },
  ]

  return (
    <div
      className={`app${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={onDrop}
    >
      <header className="menubar">
        <div className="brand">
          <img src={logo} alt="" width={20} height={20} />
          Sift
        </div>
        <Menu trigger="File" items={fileMenu} />
        <Menu trigger="Edit" items={editMenu} />
        <Menu trigger="Rows" items={rowsMenu} />
        <Menu trigger="Cols" items={colsMenu} />
        <Menu trigger="DOE" items={doeMenu} />
        <Menu trigger="Analyze" items={analyzeMenu} />
        <Menu trigger="Graph" items={graphMenu} />
        <Menu trigger="Help" items={[{ label: 'About Sift', onSelect: () => open({ kind: 'about' }) }]} />
        <div className="menubar-status">
          {busy && <span className="spinner" />}
          {table && (
            <span>
              <strong>{table.name}</strong> · {table.nRows} rows · {table.columns.length} cols
            </span>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            openFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </header>

      {!table ? (
        <Welcome
          samples={samples}
          busy={busy}
          onOpenFile={() => fileInput.current?.click()}
          onOpenSample={(id) => openTable(() => api.sample(id))}
          onNewTable={() => store().newTable()}
        />
      ) : (
        <div className="workspace" ref={workspace}>
          <aside className="sidebar">
            <ColumnsPanel />
            <RowsPanel />
          </aside>
          <section className="table-pane" style={{ flexBasis: reports.length ? `${split * 100}%` : '100%' }}>
            <TableTabs />
            <DataGrid />
          </section>
          {reports.length > 0 && (
            <>
              <div className="splitter" onMouseDown={startResize} role="separator" aria-orientation="vertical" />
              <section className="reports-pane">
                <nav className="tabs" role="tablist">
                  {reports.map((r) => (
                    <div key={r.id} role="tab" aria-selected={r.id === active?.id} className={`tab${r.id === active?.id ? ' active' : ''}`}>
                      <button className="tab-title" onClick={() => store().setActiveReport(r.id)} title={reportTitle(r, table)}>
                        {reportTitle(r, table)}
                      </button>
                      <button className="tab-close" aria-label="Close report" onClick={() => store().closeReport(r.id)}>
                        ×
                      </button>
                    </div>
                  ))}
                </nav>
                <div className="report-body">{active && <ReportView key={active.id} report={active} />}</div>
              </section>
            </>
          )}
        </div>
      )}

      <DialogHost />

      {notice && (
        <div className={`toast tone-${notice.tone}`} role="status" onClick={() => store().dismissNotice()}>
          {notice.text}
        </div>
      )}
      {dropping && <div className="drop-overlay">Drop a CSV, Excel or .sift file to open it</div>}
    </div>
  )
}
