import { useState } from 'react'
import { useActiveTable, useStore } from '../state/store'
import { Modal } from './Modal'
import './data.css'

const MAX_ROWS = 1_000_000

/** Rows › Add Rows: how many, and where. */
export function AddRowsDialog({ onClose }: { onClose: () => void }) {
  const table = useActiveTable()
  const addRows = useStore((s) => s.addRows)
  const firstSelected = table ? table.selected.indexOf(1) : -1
  const [count, setCount] = useState('1')
  const [position, setPosition] = useState<'end' | 'start' | 'after'>(firstSelected >= 0 ? 'after' : 'end')
  const [afterRow, setAfterRow] = useState(String(firstSelected >= 0 ? firstSelected + 1 : (table?.nRows ?? 0)))
  const [error, setError] = useState<string | null>(null)

  if (!table) return null

  const add = () => {
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS)
      return setError(`Enter a whole number of rows between 1 and ${MAX_ROWS.toLocaleString()}.`)
    let at = table.nRows
    if (position === 'start') at = 0
    if (position === 'after') {
      const row = Number(afterRow)
      if (!Number.isInteger(row) || row < 0 || row > table.nRows) return setError(`The row must be between 0 and ${table.nRows}.`)
      at = row
    }
    addRows(n, at)
    onClose()
  }

  return (
    <Modal
      title="Add Rows"
      onClose={onClose}
      className="data-dialog"
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={add}>
            OK
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <div className="form-grid">
          <label htmlFor="ar-count">How many rows</label>
          <input id="ar-count" type="number" min={1} max={MAX_ROWS} value={count} onChange={(e) => setCount(e.target.value)} autoFocus />
        </div>
        <section className="dialog-section">
          <h3>Add them</h3>
          <div className="radio-list">
            <label>
              <input type="radio" name="ar-pos" checked={position === 'end'} onChange={() => setPosition('end')} /> At the end
            </label>
            <label>
              <input type="radio" name="ar-pos" checked={position === 'start'} onChange={() => setPosition('start')} /> At the start
            </label>
            <label>
              <input type="radio" name="ar-pos" checked={position === 'after'} onChange={() => setPosition('after')} /> After row
              <span className="inline-fields">
                <input
                  type="number"
                  min={0}
                  max={table.nRows}
                  value={afterRow}
                  onChange={(e) => {
                    setAfterRow(e.target.value)
                    setPosition('after')
                  }}
                  aria-label="After row number"
                />
              </span>
              {firstSelected >= 0 && <span className="muted">(first selected row is {firstSelected + 1})</span>}
            </label>
          </div>
        </section>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
