import { useState } from 'react'
import type { DataType, ModelingType, Value } from '../api/types'
import { parseCellInput } from '../lib/csv'
import { findColumn, uniqueName, useActiveTable, useStore } from '../state/store'
import { FormulaEditor } from './FormulaEditor'
import { Modal } from './Modal'
import './data.css'

type Init = 'missing' | 'constant' | 'sequence' | 'random' | 'formula'

/** Normal deviate by the Box-Muller transform. */
function randomNormal(): number {
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Cols › New Column: name, types, and how to fill the new column. */
export function NewColumnDialog({ onClose }: { onClose: () => void }) {
  const table = useActiveTable()
  const activeColumnId = useStore((s) => s.activeColumnId)
  const addColumn = useStore((s) => s.addColumn)
  const setActiveColumn = useStore((s) => s.setActiveColumn)

  const [name, setName] = useState(() => uniqueName(`Column ${(table?.columns.length ?? 0) + 1}`, table?.columns.map((c) => c.name) ?? []))
  const [dataType, setDataType] = useState<DataType>('numeric')
  const [modelingType, setModelingType] = useState<ModelingType>('continuous')
  const [init, setInit] = useState<Init>('missing')
  const [constant, setConstant] = useState('')
  const [seqStart, setSeqStart] = useState('1')
  const [seqStep, setSeqStep] = useState('1')
  const [randomKind, setRandomKind] = useState<'uniform' | 'normal'>('uniform')
  const [randA, setRandA] = useState('0')
  const [randB, setRandB] = useState('1')
  const [formula, setFormula] = useState('')
  const activeColumn = findColumn(table, activeColumnId ?? '')
  const [position, setPosition] = useState<'end' | 'after'>('end')
  const [error, setError] = useState<string | null>(null)

  if (!table) return null
  const numericOnly = dataType === 'character'

  const changeDataType = (next: DataType) => {
    setDataType(next)
    if (next === 'character') {
      if (modelingType === 'continuous') setModelingType('nominal')
      if (init === 'sequence' || init === 'random') setInit('missing')
    }
  }

  const numberField = (text: string, label: string): number | string => {
    const n = Number(text.trim())
    return text.trim() !== '' && Number.isFinite(n) ? n : `${label} must be a number.`
  }

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) return setError('The column needs a name.')
    if (table.columns.some((c) => c.name === trimmed)) return setError(`There is already a column named "${trimmed}".`)
    const n = table.nRows
    let values: Value[] = []
    switch (init) {
      case 'constant': {
        const parsed = parseCellInput(constant, dataType)
        if (!parsed.ok) return setError(`The constant: ${parsed.error}.`)
        values = Array<Value>(n).fill(parsed.value)
        break
      }
      case 'sequence': {
        const start = numberField(seqStart, 'Start')
        const step = numberField(seqStep, 'Step')
        if (typeof start === 'string') return setError(start)
        if (typeof step === 'string') return setError(step)
        values = Array.from({ length: n }, (_, i) => Number((start + i * step).toPrecision(15)))
        break
      }
      case 'random': {
        const a = numberField(randA, randomKind === 'uniform' ? 'Minimum' : 'Mean')
        const b = numberField(randB, randomKind === 'uniform' ? 'Maximum' : 'Std Dev')
        if (typeof a === 'string') return setError(a)
        if (typeof b === 'string') return setError(b)
        if (randomKind === 'uniform' && b <= a) return setError('Maximum must be greater than minimum.')
        if (randomKind === 'normal' && b <= 0) return setError('Std Dev must be positive.')
        values = Array.from({ length: n }, () => (randomKind === 'uniform' ? a + (b - a) * Math.random() : a + b * randomNormal()))
        break
      }
      case 'formula':
        if (!formula.trim()) return setError('Enter a formula.')
        break
    }
    const index = position === 'after' && activeColumn ? table.columns.findIndex((c) => c.id === activeColumn.id) + 1 : undefined
    const id = addColumn(
      { name: trimmed, dataType, modelingType, values, props: init === 'formula' ? { formula: formula.trim() } : {} },
      index,
    )
    setActiveColumn(id)
    onClose()
  }

  const radio = (value: Init, label: string, disabled = false) => (
    <input
      type="radio"
      name="nc-init"
      value={value}
      checked={init === value}
      disabled={disabled}
      onChange={() => setInit(value)}
      aria-label={label}
    />
  )

  return (
    <Modal
      title="New Column"
      onClose={onClose}
      className="data-dialog"
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create}>
            OK
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="nc-name">Column name</label>
        <input id="nc-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label htmlFor="nc-type">Data type</label>
        <select id="nc-type" value={dataType} onChange={(e) => changeDataType(e.target.value as DataType)}>
          <option value="numeric">Numeric</option>
          <option value="character">Character</option>
        </select>
        <label htmlFor="nc-modeling">Modeling type</label>
        <select id="nc-modeling" value={modelingType} onChange={(e) => setModelingType(e.target.value as ModelingType)}>
          <option value="continuous" disabled={dataType === 'character'}>
            Continuous
          </option>
          <option value="ordinal">Ordinal</option>
          <option value="nominal">Nominal</option>
        </select>
        <label htmlFor="nc-position">Insert</label>
        <select id="nc-position" value={position} onChange={(e) => setPosition(e.target.value as 'end' | 'after')}>
          <option value="end">At the end</option>
          <option value="after" disabled={!activeColumn}>
            {activeColumn ? `After ${activeColumn.name}` : 'After the active column'}
          </option>
        </select>
      </div>

      <section className="dialog-section">
        <h3>Initial values</h3>
        <div className="radio-list">
          <label>{radio('missing', 'Missing')} Missing</label>
          <label>
            {radio('constant', 'Constant')} Constant
            {init === 'constant' && (
              <span className="inline-fields">
                <input type="text" value={constant} onChange={(e) => setConstant(e.target.value)} aria-label="Constant value" autoFocus />
              </span>
            )}
          </label>
          <label>
            {radio('sequence', 'Sequence', numericOnly)} Sequence
            {init === 'sequence' && (
              <span className="inline-fields">
                <span>
                  start{' '}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={seqStart}
                    onChange={(e) => setSeqStart(e.target.value)}
                    aria-label="Sequence start"
                  />
                </span>
                <span>
                  step{' '}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={seqStep}
                    onChange={(e) => setSeqStep(e.target.value)}
                    aria-label="Sequence step"
                  />
                </span>
              </span>
            )}
          </label>
          <label>
            {radio('random', 'Random', numericOnly)} Random
            {init === 'random' && (
              <span className="inline-fields">
                <select
                  value={randomKind}
                  onChange={(e) => setRandomKind(e.target.value as 'uniform' | 'normal')}
                  aria-label="Distribution"
                >
                  <option value="uniform">Uniform</option>
                  <option value="normal">Normal</option>
                </select>
                <span>
                  {randomKind === 'uniform' ? 'min' : 'mean'}{' '}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={randA}
                    onChange={(e) => setRandA(e.target.value)}
                    aria-label={randomKind === 'uniform' ? 'Minimum' : 'Mean'}
                  />
                </span>
                <span>
                  {randomKind === 'uniform' ? 'max' : 'std dev'}{' '}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={randB}
                    onChange={(e) => setRandB(e.target.value)}
                    aria-label={randomKind === 'uniform' ? 'Maximum' : 'Std Dev'}
                  />
                </span>
              </span>
            )}
          </label>
          <label>{radio('formula', 'Formula')} Formula</label>
        </div>
        {init === 'formula' && <FormulaEditor value={formula} onChange={setFormula} columns={table.columns} nRows={table.nRows} />}
        {numericOnly && <p className="hint">Sequences and random values need a numeric column.</p>}
      </section>

      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
