import { useMemo, useState } from 'react'
import type { DataType, ModelingType, SpecLimits } from '../api/types'
import { labelOf, levelsOf } from '../lib/levels'
import type { Column, ColumnProps } from '../state/store'
import { convertValues, findColumn, useActiveTable, useStore } from '../state/store'
import { FormulaEditor } from './FormulaEditor'
import { Modal } from './Modal'
import './data.css'

const MODELING_LABELS: Record<ModelingType, string> = { continuous: 'Continuous', ordinal: 'Ordinal', nominal: 'Nominal' }

function levelsFor(column: Column, dataType: DataType, order?: string[]): string[] {
  const values = dataType === column.dataType ? column.values : convertValues(column.values, dataType)
  return levelsOf(values.map(labelOf), order)
}

function limitText(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v)
}

/** Parse an optional number field: '' → undefined, invalid → NaN. */
function parseLimit(text: string): number | undefined {
  const t = text.trim()
  return t === '' ? undefined : Number(t)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Column Info: name, types, formula, value order and spec limits. Saving is one undo step. */
export function ColumnInfoDialog({ columnId, onClose }: { columnId: string; onClose: () => void }) {
  const table = useActiveTable()
  const updateColumn = useStore((s) => s.updateColumn)
  const column = findColumn(table, columnId)

  const [name, setName] = useState(column?.name ?? '')
  const [dataType, setDataType] = useState<DataType>(column?.dataType ?? 'numeric')
  const [modelingType, setModelingType] = useState<ModelingType>(column?.modelingType ?? 'continuous')
  const [isFormula, setIsFormula] = useState(!!column?.props.formula)
  const [formula, setFormula] = useState(column?.props.formula ?? '')
  const initialOrder = useMemo(() => (column ? levelsFor(column, column.dataType, column.props.valueOrder) : []), [column])
  const [order, setOrder] = useState<string[]>(initialOrder)
  const [picked, setPicked] = useState<string | null>(null)
  const [lsl, setLsl] = useState(limitText(column?.props.specLimits?.lsl))
  const [target, setTarget] = useState(limitText(column?.props.specLimits?.target))
  const [usl, setUsl] = useState(limitText(column?.props.specLimits?.usl))
  const [error, setError] = useState<string | null>(null)

  if (!table || !column) {
    return (
      <Modal title="Column Info" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
        <p className="report-text">This column no longer exists.</p>
      </Modal>
    )
  }

  const categorical = modelingType !== 'continuous'
  const defaultOrder = levelsFor(column, dataType)

  // How many values a data type change would turn into missing.
  const lost =
    dataType !== column.dataType && dataType === 'numeric'
      ? convertValues(column.values, 'numeric').filter((v, i) => v === null && column.values[i] !== null).length
      : 0

  const changeDataType = (next: DataType) => {
    setDataType(next)
    if (next === 'character' && modelingType === 'continuous') setModelingType('nominal')
    setOrder(levelsFor(column, next, column.props.valueOrder))
    setPicked(null)
  }

  const moveLevel = (delta: number) => {
    if (picked === null) return
    const i = order.indexOf(picked)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    const next = order.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrder(next)
  }

  /** Validate and store the dialog's settings. Returns true when saved (or nothing changed). */
  const save = (): boolean => {
    const trimmed = name.trim()
    if (!trimmed) return fail('The column needs a name.')
    if (table.columns.some((c) => c.id !== column.id && c.name === trimmed)) return fail(`There is already a column named "${trimmed}".`)
    if (isFormula && !formula.trim()) return fail('Enter a formula, or turn off "Formula column".')

    let specLimits: SpecLimits | undefined
    if (dataType === 'numeric') {
      const [l, t, u] = [parseLimit(lsl), parseLimit(target), parseLimit(usl)]
      if ([l, t, u].some((v) => v !== undefined && !Number.isFinite(v))) return fail('Spec limits must be numbers.')
      if (l !== undefined && u !== undefined && l >= u) return fail('The lower spec limit must be below the upper spec limit.')
      if (t !== undefined && ((l !== undefined && t < l) || (u !== undefined && t > u)))
        return fail('The target must lie between the spec limits.')
      if (l !== undefined || t !== undefined || u !== undefined) {
        specLimits = {
          ...(l !== undefined ? { lsl: l } : {}),
          ...(t !== undefined ? { target: t } : {}),
          ...(u !== undefined ? { usl: u } : {}),
        }
      }
    }

    // A categorical column keeps a value order only when it differs from the default;
    // a continuous one keeps whatever order it had, in case it is made categorical again.
    const valueOrder = categorical ? (same(order, defaultOrder) ? undefined : order) : column.props.valueOrder
    const props: ColumnProps = {
      ...(valueOrder ? { valueOrder } : {}),
      ...(specLimits ? { specLimits } : {}),
      ...(isFormula ? { formula: formula.trim() } : {}),
    }
    const unchanged =
      trimmed === column.name && dataType === column.dataType && modelingType === column.modelingType && same(props, column.props)
    if (!unchanged) updateColumn(column.id, { name: trimmed, dataType, modelingType, props })
    setError(null)
    return true
  }

  const fail = (message: string) => {
    setError(message)
    return false
  }

  return (
    <Modal
      title="Column Info"
      description={`Properties of ${column.name}`}
      onClose={onClose}
      className="data-dialog"
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => save()}>Apply</button>
          <button className="primary" onClick={() => save() && onClose()}>
            OK
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="ci-name">Column name</label>
        <input id="ci-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label htmlFor="ci-type">Data type</label>
        <select id="ci-type" value={dataType} onChange={(e) => changeDataType(e.target.value as DataType)} disabled={isFormula}>
          <option value="numeric">Numeric</option>
          <option value="character">Character</option>
        </select>
        <label htmlFor="ci-modeling">Modeling type</label>
        <select id="ci-modeling" value={modelingType} onChange={(e) => setModelingType(e.target.value as ModelingType)}>
          {(['continuous', 'ordinal', 'nominal'] as ModelingType[]).map((t) => (
            <option key={t} value={t} disabled={t === 'continuous' && dataType === 'character'}>
              {MODELING_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {isFormula && <p className="field-hint">A formula column's data type follows its results.</p>}
      {lost > 0 && (
        <p className="dialog-warning">
          {lost} value{lost === 1 ? " isn't a number and" : "s aren't numbers and"} will become missing.
        </p>
      )}
      {dataType !== column.dataType && dataType === 'character' && <p className="dialog-warning">Numbers will be stored as text.</p>}

      <section className="dialog-section">
        <h3>Formula</h3>
        <label className="checkbox-row">
          <input type="checkbox" checked={isFormula} onChange={(e) => setIsFormula(e.target.checked)} />
          Formula column
        </label>
        {isFormula ? (
          <FormulaEditor value={formula} onChange={setFormula} columns={table.columns} nRows={table.nRows} selfId={column.id} />
        ) : (
          column.props.formula && <p className="hint">Turning the formula off keeps the current values.</p>
        )}
      </section>

      {categorical && (
        <section className="dialog-section">
          <h3>Value Order</h3>
          {order.length === 0 ? (
            <p className="hint">This column has no values yet.</p>
          ) : (
            <div className="value-order">
              <ul role="listbox" aria-label="Value order">
                {order.map((level) => (
                  <li
                    key={level}
                    role="option"
                    aria-selected={picked === level}
                    className={picked === level ? 'picked' : ''}
                    onClick={() => setPicked(level)}
                  >
                    {level}
                  </li>
                ))}
              </ul>
              <div className="value-order-buttons">
                <button onClick={() => moveLevel(-1)} disabled={picked === null || order[0] === picked}>
                  Move Up
                </button>
                <button onClick={() => moveLevel(1)} disabled={picked === null || order[order.length - 1] === picked}>
                  Move Down
                </button>
                <button onClick={() => setOrder(order.slice().reverse())}>Reverse</button>
                <button onClick={() => setOrder(defaultOrder)} title="Numeric or alphabetical order">
                  Sort
                </button>
                <button
                  onClick={() => setOrder(dataType === column.dataType ? initialOrder : defaultOrder)}
                  title="Back to the order when this dialog opened"
                >
                  Reset
                </button>
              </div>
            </div>
          )}
          <p className="hint">Analyses and graphs list levels in this order.</p>
        </section>
      )}

      {dataType === 'numeric' && (
        <section className="dialog-section">
          <h3>Spec Limits</h3>
          <div className="inline-fields">
            <label>
              LSL
              <input type="text" inputMode="decimal" value={lsl} onChange={(e) => setLsl(e.target.value)} aria-label="Lower spec limit" />
            </label>
            <label>
              Target
              <input type="text" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target" />
            </label>
            <label>
              USL
              <input type="text" inputMode="decimal" value={usl} onChange={(e) => setUsl(e.target.value)} aria-label="Upper spec limit" />
            </label>
          </div>
          <p className="hint">Used by Process Capability and control charts. Leave blank for none.</p>
        </section>
      )}

      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
