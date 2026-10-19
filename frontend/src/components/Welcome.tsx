import { useEffect, useState } from 'react'
import type { SampleInfo } from '../api/types'
import { clearAutosave, readAutosave, restoreAutosave, type AutosaveInfo } from '../lib/session'
import { useStore } from '../state/store'
import './data.css'

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function timeAgo(date: Date): string {
  const seconds = (date.getTime() - Date.now()) / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  return 'just now'
}

/** Offers to restore the workspace the browser saved last time. */
function ResumeCard() {
  const [info, setInfo] = useState<AutosaveInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useStore((s) => s.notify)

  useEffect(() => {
    let live = true
    readAutosave().then((found) => live && setInfo(found))
    return () => {
      live = false
    }
  }, [])

  if (!info) return null
  const names = info.tables.map((t) => `${t.name} (${t.nRows} row${t.nRows === 1 ? '' : 's'})`).join(', ')

  const resume = async () => {
    setBusy(true)
    try {
      await restoreAutosave()
    } catch (e) {
      notify((e as Error).message, 'error')
      setInfo(null)
      setBusy(false)
    }
  }

  const discard = async () => {
    await clearAutosave()
    setInfo(null)
  }

  return (
    <div className="resume-card" role="region" aria-label="Resume previous session">
      <div className="resume-text">
        <strong>Resume where you left off</strong>
        <span className="muted">
          Saved {timeAgo(info.savedAt)}: {names}
        </span>
      </div>
      <div className="resume-actions">
        <button className="primary" onClick={resume} disabled={busy}>
          Resume
        </button>
        <button onClick={discard} disabled={busy}>
          Discard
        </button>
      </div>
    </div>
  )
}

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
        <p className="tagline">
          Interactive statistical discovery in your browser. Every graph and table is linked: select rows anywhere and they light up
          everywhere.
        </p>
        <div className="welcome-actions">
          <button className="primary big" onClick={onOpenFile} disabled={busy}>
            Open a file…
          </button>
          <button className="big" onClick={onNewTable} disabled={busy}>
            New data table
          </button>
        </div>
        <p className="muted">CSV, Excel or a saved .sift session. You can also drop a file anywhere on this page.</p>
        <ResumeCard />
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
