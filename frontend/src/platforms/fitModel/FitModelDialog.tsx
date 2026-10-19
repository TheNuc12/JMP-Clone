import { useState, type MouseEvent } from 'react'
import { Menu } from '../../components/Menu'
import { Modal } from '../../components/Modal'
import { ModelingIcon } from '../../components/ModelingIcon'
import { isCategorical, useActiveTable, useStore } from '../../state/store'
import { addEffects, crossEffects, effectName, isValidEffect, MACRO_LABELS, macroEffects, type Effect, type Macro } from './effects'
import './fitModel.css'

type Personality = 'standard_least_squares' | 'stepwise'
type Direction = 'forward' | 'backward' | 'mixed'

/** Click / shift-click / ctrl-click selection over a list of keys. */
function useMultiSelect<T>(items: T[]) {
  const [picked, setPicked] = useState<T[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)
  const pick = (index: number, e: MouseEvent) => {
    const item = items[index]
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
      setPicked(items.slice(a, b + 1))
    } else if (e.ctrlKey || e.metaKey) {
      setPicked(picked.includes(item) ? picked.filter((p) => p !== item) : [...picked, item])
      setAnchor(index)
    } else {
      setPicked([item])
      setAnchor(index)
    }
  }
  return { picked, setPicked, pick }
}

/** Fit Model launch window: pick responses, construct model effects, choose a personality. */
export function FitModelDialog({ onClose }: { onClose: () => void }) {
  const table = useActiveTable()
  const openReport = useStore((s) => s.openReport)
  const notify = useStore((s) => s.notify)
  const columnIds = table?.columns.map((c) => c.id) ?? []
  const columns = useMultiSelect(columnIds)
  const [y, setY] = useState<string[]>(() => table?.model?.responses ?? [])
  const [effects, setEffects] = useState<Effect[]>(() => table?.model?.effects ?? [])
  const effectIndexes = effects.map((_, i) => i)
  const chosen = useMultiSelect(effectIndexes)
  const [personality, setPersonality] = useState<Personality>('standard_least_squares')
  const [direction, setDirection] = useState<Direction>('mixed')
  const [pEnter, setPEnter] = useState(0.25)
  const [pLeave, setPLeave] = useState(0.1)
  const [center, setCenter] = useState(true)

  if (!table) return null
  const byId = new Map(table.columns.map((c) => [c.id, c]))
  const yColumns = y.map((id) => byId.get(id)).filter((c) => !!c)
  const categoricalY = yColumns.some((c) => isCategorical(c.modelingType))

  const add = (added: Effect[]) => {
    const valid = added.filter((e) => isValidEffect(e, byId))
    if (valid.length < added.length) notify('A categorical column can appear only once in an effect.', 'error')
    setEffects((current) => addEffects(current, valid))
    columns.setPicked([])
    chosen.setPicked([])
  }

  const cross = () => {
    const crossed = crossEffects(
      columns.picked,
      chosen.picked.map((i) => effects[i]),
    )
    if (!crossed.length) notify('Select two or more columns, or columns and effects, to cross.', 'error')
    else add(crossed)
  }

  const removeEffects = () => {
    const drop = new Set(chosen.picked)
    setEffects(effects.filter((_, i) => !drop.has(i)))
    chosen.setPicked([])
  }

  const launch = () => {
    const factors = [...new Set(effects.flat())]
    openReport({
      kind: 'fit_model',
      roles: { y, factors },
      params: { effects, personality, direction, p_enter: pEnter, p_leave: pLeave, center_polynomials: center },
    })
    onClose()
  }

  const ready = y.length > 0 && effects.length > 0
  return (
    <Modal
      title="Fit Model"
      description="Model one or more responses with several effects: main effects, crosses and polynomial terms."
      onClose={onClose}
      className="fit-model-dialog"
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={launch}>
            Run
          </button>
        </>
      }
    >
      <div className="fm-body">
        <div className="fm-columns">
          <div className="launch-section-title">Select Columns</div>
          <ul className="launch-list" role="listbox" aria-multiselectable="true">
            {table.columns.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={columns.picked.includes(c.id)}
                className={columns.picked.includes(c.id) ? 'picked' : ''}
                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                onClick={(e) => columns.pick(i, e)}
                onDoubleClick={() => add([[c.id]])}
              >
                <ModelingIcon type={c.modelingType} /> {c.name}
              </li>
            ))}
          </ul>
        </div>

        <div className="fm-middle">
          <div className="launch-section-title">Pick Role Variables</div>
          <div className="role-row">
            <button
              className="role-button"
              disabled={!columns.picked.length}
              onClick={() => {
                setY([...y, ...columns.picked.filter((id) => !y.includes(id))])
                columns.setPicked([])
              }}
            >
              Y
            </button>
            <ul className="role-list">
              {y.length === 0 && <li className="role-placeholder">Response column(s)</li>}
              {yColumns.map((c) => (
                <li key={c.id}>
                  <ModelingIcon type={c.modelingType} /> {c.name}
                  <button className="chip-remove" aria-label={`Remove ${c.name}`} onClick={() => setY(y.filter((id) => id !== c.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="launch-section-title">Construct Model Effects</div>
          <div className="fm-effects">
            <div className="fm-effect-buttons">
              <button className="role-button" disabled={!columns.picked.length} onClick={() => add(columns.picked.map((id) => [id]))}>
                Add
              </button>
              <button className="role-button" onClick={cross}>
                Cross
              </button>
              <Menu
                trigger="Macros ▾"
                triggerClassName="role-button fm-macros"
                items={(Object.keys(MACRO_LABELS) as Macro[]).map((m) => ({
                  label: MACRO_LABELS[m],
                  disabled: !columns.picked.length,
                  hint: 'Uses the selected columns',
                  onSelect: () => add(macroEffects(m, columns.picked, byId)),
                }))}
              />
              <button className="role-button" disabled={!chosen.picked.length} onClick={removeEffects}>
                Remove
              </button>
            </div>
            <ul className="launch-list fm-effect-list" role="listbox" aria-label="Model effects" aria-multiselectable="true">
              {effects.length === 0 && <li className="role-placeholder">Select columns, then Add, Cross or a macro</li>}
              {effects.map((e, i) => (
                <li
                  key={i}
                  role="option"
                  aria-selected={chosen.picked.includes(i)}
                  className={chosen.picked.includes(i) ? 'picked' : ''}
                  onMouseDown={(ev) => ev.shiftKey && ev.preventDefault()}
                  onClick={(ev) => chosen.pick(i, ev)}
                >
                  {effectName(e, byId)}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="fm-settings">
          <div className="launch-section-title">Personality</div>
          {categoricalY ? (
            <p className="report-text">Categorical responses are fit with nominal or ordinal logistic regression.</p>
          ) : (
            <>
              <select
                className="fm-personality"
                aria-label="Personality"
                value={personality}
                onChange={(e) => setPersonality(e.target.value as Personality)}
              >
                <option value="standard_least_squares">Standard Least Squares</option>
                <option value="stepwise">Stepwise</option>
              </select>
              {personality === 'stepwise' && (
                <div className="form-grid fm-stepwise">
                  <label htmlFor="fm-direction">Direction</label>
                  <select id="fm-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                    <option value="mixed">Mixed</option>
                    <option value="forward">Forward</option>
                    <option value="backward">Backward</option>
                  </select>
                  <label htmlFor="fm-enter">Prob to Enter</label>
                  <input id="fm-enter" type="number" min={0} max={1} step={0.01} value={pEnter} onChange={(e) => setPEnter(Number(e.target.value))} />
                  <label htmlFor="fm-leave">Prob to Leave</label>
                  <input id="fm-leave" type="number" min={0} max={1} step={0.01} value={pLeave} onChange={(e) => setPLeave(Number(e.target.value))} />
                </div>
              )}
            </>
          )}
          <label className="fm-check">
            <input type="checkbox" checked={center} onChange={(e) => setCenter(e.target.checked)} /> Center Polynomials
          </label>
          {table.model && <p className="report-text">Started from the model saved with this table.</p>}
        </div>
      </div>
    </Modal>
  )
}
