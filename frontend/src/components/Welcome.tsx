import type { SampleInfo } from '../api/types'

export function Welcome({
  samples,
  busy,
  onOpenFile,
  onOpenSample,
  onNewTable,
}: {
  samples: SampleInfo[]
  busy: boolean
  onOpenFile: () => void
  onOpenSample: (id: string) => void
  onNewTable: () => void
}) {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <h1>Sift</h1>
        <p className="tagline">Interactive statistical discovery in your browser. Every graph and table is linked: select rows anywhere and they light up everywhere.</p>
        <div className="welcome-actions">
          <button className="primary big" onClick={onOpenFile} disabled={busy}>
            Open a file…
          </button>
          <button className="big" onClick={onNewTable} disabled={busy}>
            New data table
          </button>
        </div>
        <p className="muted">CSV, Excel or a saved .sift session. You can also drop a file anywhere on this page.</p>
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
