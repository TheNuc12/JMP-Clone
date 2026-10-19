import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { api } from './api/client'
import type { DataTablePayload, SampleInfo } from './api/types'
import { ColumnsPanel, RowsPanel } from './components/ColumnsPanel'
import { DataGrid } from './components/DataGrid'
import { FitYByXGuide, LaunchDialog } from './components/LaunchDialog'
import { Menu } from './components/Menu'
import { GraphBuilder } from './platforms/GraphBuilder'
import { DistributionReport, FitYByXReport } from './platforms/Reports'
import type { ReportConfig } from './state/store'
import { useStore } from './state/store'

type Dialog = 'distribution' | 'fit_y_by_x' | 'about' | null

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm'

function reportTitle(r: ReportConfig): string {
  switch (r.kind) {
    case 'distribution':
      return `Distribution · ${r.y.join(', ')}`
    case 'fit_y_by_x':
      return `Fit Y by X · ${r.y.join(', ')} by ${r.x.join(', ')}`
    case 'graph_builder':
      return `Graph Builder${r.roles.y || r.roles.x ? ` · ${[r.roles.y, r.roles.x].filter(Boolean).join(' vs ')}` : ''}`
  }
}

export default function App() {
  const table = useStore((s) => s.table)
  const reports = useStore((s) => s.reports)
  const activeReportId = useStore((s) => s.activeReportId)
  const nSelected = useStore((s) => s.nSelected)
  const notice = useStore((s) => s.notice)
  const store = useStore.getState

  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [split, setSplit] = useState(0.42)
  const fileInput = useRef<HTMLInputElement>(null)
  const workspace = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.samples().then(setSamples, (e: Error) => store().notify(e.message, 'error'))
  }, [store])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === 'Escape' && !dialog && !['INPUT', 'TEXTAREA'].includes(target.tagName)) store().clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, store])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => store().dismissNotice(), notice.tone === 'error' ? 8000 : 4000)
    return () => clearTimeout(timer)
  }, [notice, store])

  const load = useCallback(
    async (fetcher: () => Promise<DataTablePayload>) => {
      setBusy(true)
      try {
        const payload = await fetcher()
        store().loadTable(payload)
        store().notify(`Opened ${payload.name}: ${payload.n_rows} rows, ${payload.columns.length} columns`)
      } catch (e) {
        store().notify((e as Error).message, 'error')
      } finally {
        setBusy(false)
      }
    },
    [store],
  )

  const openFile = (file: File | undefined) => file && load(() => api.upload(file))
  const openSample = (id: string) => load(() => api.sample(id))

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

  const active = reports.find((r) => r.id === activeReportId)
  const noTable = !table

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
          <img src="/favicon.svg" alt="" width={20} height={20} />
          Sift
        </div>
        <Menu
          trigger="File"
          items={[
            { label: 'Open…', shortcut: 'CSV / Excel', onSelect: () => fileInput.current?.click() },
            { label: '', separator: true },
            ...samples.map((s) => ({ label: `Sample: ${s.name}`, onSelect: () => openSample(s.id), hint: s.description })),
            { label: '', separator: true },
            { label: 'Close Table', disabled: noTable, onSelect: () => store().closeTable() },
          ]}
        />
        <Menu
          trigger="Rows"
          items={[
            { label: 'Select All Rows', disabled: noTable, onSelect: () => store().selectAll() },
            { label: 'Clear Selection', shortcut: 'Esc', disabled: noTable, onSelect: () => store().clearSelection() },
            { label: 'Invert Selection', disabled: noTable, onSelect: () => store().invertSelection() },
            { label: '', separator: true },
            { label: 'Exclude / Unexclude', disabled: noTable || nSelected === 0, onSelect: () => store().toggleExcludeSelected() },
            { label: 'Clear Row States', disabled: noTable, onSelect: () => store().clearRowStates() },
          ]}
        />
        <Menu
          trigger="Analyze"
          items={[
            { label: 'Distribution', disabled: noTable, onSelect: () => setDialog('distribution') },
            { label: 'Fit Y by X', disabled: noTable, onSelect: () => setDialog('fit_y_by_x') },
          ]}
        />
        <Menu
          trigger="Graph"
          items={[
            {
              label: 'Graph Builder',
              disabled: noTable,
              onSelect: () => store().openReport({ kind: 'graph_builder', roles: {}, elements: [] }),
            },
          ]}
        />
        <Menu trigger="Help" items={[{ label: 'About Sift', onSelect: () => setDialog('about') }]} />
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
        <Welcome samples={samples} busy={busy} onOpenFile={() => fileInput.current?.click()} onOpenSample={openSample} />
      ) : (
        <div className="workspace" ref={workspace}>
          <aside className="sidebar">
            <ColumnsPanel />
            <RowsPanel />
          </aside>
          <section className="table-pane" style={{ flexBasis: reports.length ? `${split * 100}%` : '100%' }}>
            <DataGrid />
          </section>
          {reports.length > 0 && (
            <>
              <div className="splitter" onMouseDown={startResize} role="separator" aria-orientation="vertical" />
              <section className="reports-pane">
                <nav className="tabs" role="tablist">
                  {reports.map((r) => (
                    <div key={r.id} role="tab" aria-selected={r.id === activeReportId} className={`tab${r.id === activeReportId ? ' active' : ''}`}>
                      <button className="tab-title" onClick={() => store().setActiveReport(r.id)} title={reportTitle(r)}>
                        {reportTitle(r)}
                      </button>
                      <button className="tab-close" aria-label="Close report" onClick={() => store().closeReport(r.id)}>
                        ×
                      </button>
                    </div>
                  ))}
                </nav>
                <div className="report-body">
                  {active?.kind === 'distribution' && <DistributionReport key={active.id} report={active} />}
                  {active?.kind === 'fit_y_by_x' && <FitYByXReport key={active.id} report={active} />}
                  {active?.kind === 'graph_builder' && <GraphBuilder key={active.id} report={active} />}
                </div>
              </section>
            </>
          )}
        </div>
      )}

      {dialog === 'distribution' && (
        <LaunchDialog
          title="Distribution"
          description="Histograms, quantiles and summary statistics for each column."
          roles={[{ key: 'y', label: 'Y, Columns', hint: 'One or more columns to describe' }]}
          onCancel={() => setDialog(null)}
          onLaunch={(a) => {
            store().openReport({ kind: 'distribution', y: a.y, options: {} })
            setDialog(null)
          }}
        />
      )}
      {dialog === 'fit_y_by_x' && (
        <LaunchDialog
          title="Fit Y by X"
          description="Relationship between two variables. The analysis depends on their modeling types."
          roles={[
            { key: 'y', label: 'Y, Response', hint: 'Response column(s)' },
            { key: 'x', label: 'X, Factor', hint: 'Factor column(s)' },
          ]}
          aside={<FitYByXGuide />}
          onCancel={() => setDialog(null)}
          onLaunch={(a) => {
            store().openReport({ kind: 'fit_y_by_x', y: a.y, x: a.x, options: {} })
            setDialog(null)
          }}
        />
      )}
      {dialog === 'about' && <About onClose={() => setDialog(null)} />}

      {notice && (
        <div className={`toast tone-${notice.tone}`} role="status" onClick={() => store().dismissNotice()}>
          {notice.text}
        </div>
      )}
      {dropping && <div className="drop-overlay">Drop a CSV or Excel file to open it</div>}
    </div>
  )
}

function Welcome({
  samples,
  busy,
  onOpenFile,
  onOpenSample,
}: {
  samples: SampleInfo[]
  busy: boolean
  onOpenFile: () => void
  onOpenSample: (id: string) => void
}) {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <h1>Sift</h1>
        <p className="tagline">Interactive statistical discovery in your browser. Every graph and table is linked: select rows anywhere and they light up everywhere.</p>
        <button className="primary big" onClick={onOpenFile} disabled={busy}>
          Open a CSV or Excel file…
        </button>
        <p className="muted">or drop a file anywhere on this page</p>
        <h2>Sample data</h2>
        <div className="sample-grid">
          {samples.map((s) => (
            <button key={s.id} className="sample-card" onClick={() => onOpenSample(s.id)} disabled={busy}>
              <strong>{s.name}</strong>
              <span>{s.description}</span>
              <span className="muted">
                {s.n_rows} rows · {s.n_cols} columns
              </span>
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal about" role="dialog" aria-modal="true" aria-label="About Sift">
        <header className="modal-header">
          <h2>About Sift</h2>
        </header>
        <div className="about-body">
          <p>Sift is an open-source tool for exploring data interactively, inspired by desktop statistical discovery software.</p>
          <ul>
            <li>
              <strong>Analyze › Distribution</strong>: histograms, quantiles, summary statistics, normal fit.
            </li>
            <li>
              <strong>Analyze › Fit Y by X</strong>: bivariate, oneway, logistic or contingency analysis, chosen from the modeling types.
            </li>
            <li>
              <strong>Graph › Graph Builder</strong>: drag columns onto X, Y and Overlay.
            </li>
            <li>Click or drag across points, bars or rows to select; shift adds, ctrl/cmd toggles, Esc clears.</li>
            <li>Rows › Exclude / Unexclude removes the selected rows from every analysis.</li>
            <li>Click a column's modeling-type icon to change how it is analyzed.</li>
          </ul>
        </div>
        <footer className="modal-footer">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
