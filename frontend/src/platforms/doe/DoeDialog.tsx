import { useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { DesignType, DoeResult } from '../../api/types'
import { Modal } from '../../components/Modal'
import { ModelingIcon } from '../../components/ModelingIcon'
import { ReportNodes, type PlotContext } from '../../components/Report'
import { formatValue } from '../../lib/format'
import { useStore } from '../../state/store'
import {
  candidateTerms,
  defaultCenterPoints,
  defaultDraft,
  DESIGN_DESCRIPTIONS,
  DESIGN_TITLES,
  newFactor,
  newResponse,
  parameterCount,
  previewRuns,
  roman,
  screeningChoice,
  toRequest,
  validate,
  type DesignDraft,
  type FactorDraft,
  type ResponseDraft,
} from './doeModel'
import './doe.css'

const DESIGNS: DesignType[] = ['full_factorial', 'fractional_factorial', 'response_surface', 'custom']
const SHORT_NAMES: Record<DesignType, string> = {
  full_factorial: 'Full Factorial',
  fractional_factorial: 'Screening',
  response_surface: 'Response Surface',
  custom: 'Custom',
}
const NO_PLOTS: PlotContext = { rows: [], columns: new Map() }

/** Design of experiments: define factors and responses, make the design, then open it as a table. */
export function DoeDialog({ design, onClose }: { design: DesignType; onClose: () => void }) {
  const [draft, setDraft] = useState<DesignDraft>(() => defaultDraft(design))
  const [centerTouched, setCenterTouched] = useState(false)
  const [result, setResult] = useState<DoeResult | null>(null)
  const [madeFrom, setMadeFrom] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resultRef = useRef<HTMLDivElement>(null)

  const errors = useMemo(() => validate(draft), [draft])
  const requestKey = JSON.stringify(toRequest(draft))
  const stale = result !== null && madeFrom !== requestKey
  const runs = previewRuns(draft)

  /** Apply a change; keep the default center point count in step until the user edits it. */
  const update = (change: Partial<DesignDraft>) =>
    setDraft((d) => {
      const next = { ...d, ...change }
      if (!centerTouched && change.centerPoints === undefined) next.centerPoints = defaultCenterPoints(next)
      return next
    })

  const switchDesign = (next: DesignType) => {
    setCenterTouched(false)
    setResult(null)
    setError(null)
    setDraft((d) => {
      const switched = { ...d, design: next }
      return { ...switched, centerPoints: defaultCenterPoints(switched) }
    })
  }

  const makeDesign = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await api.doe(toRequest(draft))
      setResult(made)
      setMadeFrom(requestKey)
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const makeTable = () => {
    if (!result) return
    const store = useStore.getState()
    store.addTable(result.table)
    store.notify(`Created ${result.table.name}: ${result.table.n_rows} runs. Enter the results in the response columns.`)
    onClose()
  }

  const ready = result !== null && !stale
  return (
    <Modal
      title={DESIGN_TITLES[draft.design]}
      description={DESIGN_DESCRIPTIONS[draft.design]}
      onClose={onClose}
      className="doe-dialog"
      footer={
        <>
          <span className="doe-footer-note">
            {runs !== null && errors.length === 0 && (
              <>
                <strong>{runs}</strong> runs
              </>
            )}
            {stale && <span className="doe-stale">Settings changed since the design was made.</span>}
          </span>
          <button onClick={onClose}>Cancel</button>
          <button className={ready ? '' : 'primary'} disabled={errors.length > 0 || busy} onClick={makeDesign}>
            {busy ? 'Making…' : result ? 'Remake Design' : 'Make Design'}
          </button>
          <button className={ready ? 'primary' : ''} disabled={!ready} onClick={makeTable}>
            Make Table
          </button>
        </>
      }
    >
      <div className="doe-switcher" role="tablist" aria-label="Design type">
        {DESIGNS.map((d) => (
          <button key={d} role="tab" aria-selected={d === draft.design} className={`toggle${d === draft.design ? ' on' : ''}`} onClick={() => switchDesign(d)}>
            {SHORT_NAMES[d]}
          </button>
        ))}
      </div>
      <div className={`doe-layout${result ? ' with-result' : ''}`}>
        <div className="doe-inputs">
          <ResponsesEditor responses={draft.responses} onChange={(responses) => update({ responses })} />
          <FactorsEditor draft={draft} onChange={(factors) => update({ factors })} />
          <DesignOptions
            draft={draft}
            onChange={(change) => {
              if (change.centerPoints !== undefined) setCenterTouched(true)
              update(change)
            }}
          />
          {errors.length > 0 && (
            <ul className="doe-errors" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {error && <p className="report-text tone-warning">{error}</p>}
        </div>
        {result && (
          <div className={`doe-result${stale ? ' is-stale' : ''}`} ref={resultRef}>
            <ReportNodes nodes={result.nodes} ctx={NO_PLOTS} level={0} />
            <DesignPreview result={result} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// ----------------------------------------------------------------- responses

function ResponsesEditor({ responses, onChange }: { responses: ResponseDraft[]; onChange: (r: ResponseDraft[]) => void }) {
  const set = (id: string, change: Partial<ResponseDraft>) => onChange(responses.map((r) => (r.id === id ? { ...r, ...change } : r)))
  return (
    <section className="doe-section">
      <div className="doe-section-head">
        <h3>Responses</h3>
        <button className="link-button" onClick={() => onChange([...responses, newResponse(responses.map((r) => r.name))])}>
          Add response
        </button>
      </div>
      <table className="doe-grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Goal</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {responses.map((r) => (
            <tr key={r.id}>
              <td>
                <input type="text" aria-label="Response name" value={r.name} onChange={(e) => set(r.id, { name: e.target.value })} />
              </td>
              <td>
                <select aria-label="Goal" value={r.goal} onChange={(e) => set(r.id, { goal: e.target.value as ResponseDraft['goal'] })}>
                  <option value="maximize">Maximize</option>
                  <option value="minimize">Minimize</option>
                  <option value="match_target">Match target</option>
                  <option value="none">None</option>
                </select>
              </td>
              <td>
                <button className="chip-remove" aria-label={`Remove ${r.name}`} disabled={responses.length === 1} onClick={() => onChange(responses.filter((x) => x.id !== r.id))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// -------------------------------------------------------------------- factors

function FactorsEditor({ draft, onChange }: { draft: DesignDraft; onChange: (f: FactorDraft[]) => void }) {
  const [addCount, setAddCount] = useState(1)
  const { factors } = draft
  const twoLevel = draft.design === 'fractional_factorial'
  const continuousOnly = draft.design === 'response_surface'
  const set = (id: string, change: Partial<FactorDraft>) => onChange(factors.map((f) => (f.id === id ? { ...f, ...change } : f)))
  const add = (kind: FactorDraft['kind'], count = 1) => {
    const next = [...factors]
    for (let i = 0; i < count; i++) next.push(newFactor(kind, next.map((f) => f.name), twoLevel ? 2 : 3))
    onChange(next)
  }
  return (
    <section className="doe-section">
      <div className="doe-section-head">
        <h3>
          Factors <span className="muted">({factors.length})</span>
        </h3>
        <div className="doe-add">
          <button onClick={() => add('continuous')}>Add Continuous</button>
          <button onClick={() => add('categorical')} disabled={continuousOnly} title={continuousOnly ? 'Response surface designs use continuous factors' : undefined}>
            Add Categorical
          </button>
          <span className="doe-add-n">
            <input type="number" aria-label="Number of factors to add" min={1} max={15} value={addCount} onChange={(e) => setAddCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} />
            <button onClick={() => add('continuous', addCount)}>Add {addCount === 1 ? 'factor' : `${addCount} factors`}</button>
          </span>
        </div>
      </div>
      <table className="doe-grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Values</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {factors.map((f) => (
            <tr key={f.id}>
              <td>
                <span className="doe-factor-name">
                  <ModelingIcon type={f.kind === 'continuous' ? 'continuous' : 'nominal'} />
                  <input type="text" aria-label="Factor name" value={f.name} onChange={(e) => set(f.id, { name: e.target.value })} />
                </span>
              </td>
              <td>
                <select aria-label="Factor type" value={f.kind} onChange={(e) => set(f.id, { kind: e.target.value as FactorDraft['kind'] })}>
                  <option value="continuous">Continuous</option>
                  <option value="categorical" disabled={continuousOnly}>
                    Categorical
                  </option>
                </select>
              </td>
              <td>
                {f.kind === 'continuous' ? (
                  <span className="doe-range">
                    <input type="text" inputMode="decimal" aria-label={`${f.name} low`} value={f.low} onChange={(e) => set(f.id, { low: e.target.value })} />
                    <span className="muted">to</span>
                    <input type="text" inputMode="decimal" aria-label={`${f.name} high`} value={f.high} onChange={(e) => set(f.id, { high: e.target.value })} />
                  </span>
                ) : (
                  <input
                    type="text"
                    className="doe-levels"
                    aria-label={`${f.name} levels`}
                    placeholder="Levels, separated by commas"
                    value={f.levels}
                    onChange={(e) => set(f.id, { levels: e.target.value })}
                  />
                )}
              </td>
              <td>
                <button className="chip-remove" aria-label={`Remove ${f.name}`} onClick={() => onChange(factors.filter((x) => x.id !== f.id))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// -------------------------------------------------------------------- options

function DesignOptions({ draft, onChange }: { draft: DesignDraft; onChange: (change: Partial<DesignDraft>) => void }) {
  const k = draft.factors.length
  const number = (value: string, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(Number(value) || 0)))
  return (
    <section className="doe-section">
      <h3>Design</h3>
      <div className="form-grid doe-options">
        {draft.design === 'fractional_factorial' && (
          <>
            <label htmlFor="doe-resolution">Resolution</label>
            <select
              id="doe-resolution"
              value={draft.resolution ?? ''}
              onChange={(e) => onChange({ resolution: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Automatic ({describeScreening(k, null)})</option>
              {[3, 4, 5].map((res) => (
                <option key={res} value={res} disabled={!screeningChoice(k, res)}>
                  {roman(res)} or higher ({describeScreening(k, res)})
                </option>
              ))}
            </select>
          </>
        )}
        {draft.design === 'response_surface' && (
          <>
            <label htmlFor="doe-rsm">Type</label>
            <select id="doe-rsm" value={draft.rsmType} onChange={(e) => onChange({ rsmType: e.target.value as DesignDraft['rsmType'] })}>
              <option value="ccd">Central composite</option>
              <option value="box_behnken">Box-Behnken</option>
            </select>
            {draft.rsmType === 'ccd' && (
              <>
                <label htmlFor="doe-alpha">Axial points</label>
                <select id="doe-alpha" value={draft.ccdAlpha} onChange={(e) => onChange({ ccdAlpha: e.target.value as DesignDraft['ccdAlpha'] })}>
                  <option value="rotatable">Rotatable</option>
                  <option value="orthogonal">Orthogonal</option>
                  <option value="face_centered">On face (alpha = 1)</option>
                </select>
              </>
            )}
          </>
        )}
        {draft.design === 'custom' && (
          <>
            <span className="form-label">Model</span>
            <ModelBuilder draft={draft} onChange={onChange} />
            <label htmlFor="doe-runs">Number of runs</label>
            <span className="doe-inline">
              <input id="doe-runs" type="number" min={1} placeholder={String(parameterCount(draft) + 4)} value={draft.nRuns} onChange={(e) => onChange({ nRuns: e.target.value })} />
              <span className="muted">
                minimum {parameterCount(draft)}, default {parameterCount(draft) + 4}
              </span>
            </span>
          </>
        )}
        <label htmlFor="doe-replicates">Replicates</label>
        <span className="doe-inline">
          <input id="doe-replicates" type="number" min={0} max={20} value={draft.replicates} onChange={(e) => onChange({ replicates: number(e.target.value, 0, 20) })} />
          <span className="muted">extra copies of the non-center runs</span>
        </span>
        <label htmlFor="doe-centers">Center points</label>
        <span className="doe-inline">
          <input id="doe-centers" type="number" min={0} max={100} value={draft.centerPoints} onChange={(e) => onChange({ centerPoints: number(e.target.value, 0, 100) })} />
          {draft.factors.some((f) => f.kind === 'categorical') && <span className="muted">categorical factors cycle through their levels</span>}
        </span>
        <span className="form-label">Run order</span>
        <span className="doe-inline">
          <label className="doe-check">
            <input type="checkbox" checked={draft.randomize} onChange={(e) => onChange({ randomize: e.target.checked })} /> Randomize
          </label>
          <label className="doe-check" htmlFor="doe-seed">
            Seed
          </label>
          <input id="doe-seed" type="text" inputMode="numeric" className="doe-seed" placeholder="random" value={draft.seed} onChange={(e) => onChange({ seed: e.target.value.replace(/[^0-9]/g, '') })} />
        </span>
      </div>
    </section>
  )
}

function describeScreening(k: number, resolution: number | null): string {
  const choice = screeningChoice(k, resolution)
  if (!choice) return 'not available'
  const [runs, res] = choice
  return res >= 99 ? `full factorial, ${runs} runs` : `resolution ${roman(res)}, ${runs} runs`
}

function ModelBuilder({ draft, onChange }: { draft: DesignDraft; onChange: (change: Partial<DesignDraft>) => void }) {
  const terms = candidateTerms(draft.factors)
  const chosen = new Set(draft.extraTerms)
  const groups = [
    { key: 'interaction' as const, label: 'Interactions (2nd order)' },
    { key: 'quadratic' as const, label: 'Quadratic (RSM)' },
  ]
  const setGroup = (group: 'interaction' | 'quadratic', on: boolean) => {
    const keys = terms.filter((t) => t.group === group).map((t) => t.key)
    const next = on ? [...new Set([...draft.extraTerms, ...keys])] : draft.extraTerms.filter((k) => !keys.includes(k))
    onChange({ extraTerms: next })
  }
  const toggle = (key: string) => onChange({ extraTerms: chosen.has(key) ? draft.extraTerms.filter((k) => k !== key) : [...draft.extraTerms, key] })
  return (
    <div className="doe-model">
      <div className="doe-model-main">
        Main effects: <strong>{draft.factors.map((f) => f.name).join(', ') || '—'}</strong>
      </div>
      {groups.map((g) => {
        const list = terms.filter((t) => t.group === g.key)
        if (!list.length) return null
        const all = list.every((t) => chosen.has(t.key))
        return (
          <div key={g.key} className="doe-model-group">
            <label className="doe-check">
              <input type="checkbox" checked={all} onChange={(e) => setGroup(g.key, e.target.checked)} /> {g.label}
            </label>
            <div className="doe-terms">
              {list.map((t) => (
                <label key={t.key} className={`doe-term${chosen.has(t.key) ? ' on' : ''}`}>
                  <input type="checkbox" checked={chosen.has(t.key)} onChange={() => toggle(t.key)} />
                  {t.label}
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --------------------------------------------------------------------- result

function DesignPreview({ result }: { result: DoeResult }) {
  const shown = result.table.columns.filter((c) => c.values.some((v) => v !== null))
  return (
    <section className="doe-preview">
      <div className="section-title">
        Design <span className="muted">({result.table.n_rows} runs)</span>
      </div>
      <div className="doe-preview-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="num-cell">Run</th>
              {shown.map((c) => (
                <th key={c.name} className={c.data_type === 'numeric' ? 'num-cell' : 'text-cell'}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: result.table.n_rows }, (_, i) => (
              <tr key={i}>
                <td className="num-cell muted">{i + 1}</td>
                {shown.map((c) => (
                  <td key={c.name} className={c.data_type === 'numeric' ? 'num-cell' : 'text-cell doe-mono'}>
                    {formatValue(c.values[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
