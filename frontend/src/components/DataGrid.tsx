import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { Value } from '../api/types'
import { parseCellInput, parseDelimited, plainText, rowsToTsv } from '../lib/csv'
import { formatValue } from '../lib/format'
import type { Column } from '../state/store'
import { useActiveTable, useStore } from '../state/store'
import { ModelingIcon } from './ModelingIcon'
import './data.css'

const ROW_H = 24
const HEADER_H = 30
const ROWNUM_W = 64
const COL_W = 116
const ADD_COL_W = 36
const OVERSCAN = 8

interface CellRef {
  row: number
  columnId: string
}

interface EditState extends CellRef {
  text: string
  error: string | null
}

/**
 * Virtualized, editable data table.
 *
 * Rows: click a row number to select the row, shift-click for a range, ctrl/cmd-click to
 * toggle, or drag down the row numbers. Clicking a cell makes it the active cell and also
 * selects its row (so the row lights up in every plot); keyboard navigation moves only the
 * active cell and leaves the row selection alone.
 *
 * Cells: arrows / Tab / Enter move; typing, Enter, F2 or a double-click edits; Enter commits
 * and moves down, Tab commits and moves right, Escape cancels; Delete clears. Ctrl/Cmd+C
 * copies the active cell (or the selected rows when several are selected) and Ctrl/Cmd+V
 * pastes a tab-separated block at the active cell, adding rows as needed.
 */
export function DataGrid() {
  const table = useActiveTable()
  const selectRows = useStore((s) => s.selectRows)
  const selectRange = useStore((s) => s.selectRange)
  const activeColumnId = useStore((s) => s.activeColumnId)
  const setActiveColumn = useStore((s) => s.setActiveColumn)
  const openDialog = useStore((s) => s.openDialog)

  const scrollRef = useRef<HTMLDivElement>(null)
  // Offscreen textarea that receives native copy / paste, which browsers don't send to a plain div.
  const clipboardRef = useRef<HTMLTextAreaElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(600)
  const anchor = useRef<number | null>(null)
  const dragging = useRef(false)
  const [active, setActive] = useState<CellRef | null>(null)
  const [edit, setEditState] = useState<EditState | null>(null)
  // The latest edit, readable from event handlers that run before a re-render (blur after commit).
  const editRef = useRef<EditState | null>(null)
  const setEdit = (next: EditState | null) => {
    editRef.current = next
    setEditState(next)
  }

  const tableId = table?.id
  useEffect(() => {
    setActive(null)
    editRef.current = null
    setEditState(null)
    anchor.current = null
  }, [tableId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const stop = () => {
      dragging.current = false
    }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  // The active cell, if it still exists (rows or columns may have been deleted).
  const activeRow = table && active && active.row < table.nRows ? active.row : -1
  const activeCol = table && active && activeRow >= 0 ? table.columns.findIndex((c) => c.id === active.columnId) : -1
  const hasActive = activeRow >= 0 && activeCol >= 0

  // Keep the active cell in view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || activeRow < 0 || activeCol < 0) return
    const top = HEADER_H + activeRow * ROW_H
    if (top < el.scrollTop + HEADER_H) el.scrollTop = top - HEADER_H
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    const left = ROWNUM_W + activeCol * COL_W
    if (left < el.scrollLeft + ROWNUM_W) el.scrollLeft = left - ROWNUM_W
    else if (left + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COL_W - el.clientWidth
  }, [activeRow, activeCol])

  if (!table) return null
  const { selected, excluded, columns, nRows } = table
  const store = useStore.getState

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(nRows, Math.ceil((scrollTop + viewHeight) / ROW_H) + OVERSCAN)
  const width = ROWNUM_W + columns.length * COL_W + ADD_COL_W

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true })

  const activate = (row: number, col: number) => {
    const column = columns[col]
    if (!column || row < 0 || row >= nRows) return
    setActive({ row, columnId: column.id })
    setActiveColumn(column.id)
  }

  const move = (dRow: number, dCol: number, wrap = false) => {
    if (!columns.length || !nRows) return
    if (!hasActive) return activate(0, 0)
    let row = activeRow + dRow
    let col = activeCol + dCol
    if (wrap && col >= columns.length) {
      col = 0
      row = Math.min(row + 1, nRows - 1)
    } else if (wrap && col < 0) {
      col = columns.length - 1
      row = Math.max(row - 1, 0)
    }
    activate(Math.max(0, Math.min(nRows - 1, row)), Math.max(0, Math.min(columns.length - 1, col)))
  }

  const refuseFormula = (column: Column) => {
    store().notify(`${column.name} is a formula column; edit its formula in Column Info.`, 'error')
  }

  const startEdit = (initial?: string) => {
    if (!hasActive) return
    const column = columns[activeCol]
    if (column.props.formula) return refuseFormula(column)
    setEdit({ row: activeRow, columnId: column.id, text: initial ?? plainText(column.values[activeRow]), error: null })
  }

  /** Store the edit. Returns false (and keeps editing) when the text isn't valid for the column. */
  const commitEdit = (): boolean => {
    const current = editRef.current
    if (!current) return true
    const column = store()
      .tables.find((t) => t.id === tableId)
      ?.columns.find((c) => c.id === current.columnId)
    if (!column) {
      setEdit(null)
      return true
    }
    const parsed = parseCellInput(current.text, column.dataType)
    if (!parsed.ok) {
      setEdit({ ...current, error: parsed.error })
      return false
    }
    setEdit(null)
    if (parsed.value !== column.values[current.row]) store().setCell(current.row, column.id, parsed.value)
    return true
  }

  const cancelEdit = () => setEdit(null)

  const clearActive = () => {
    if (!hasActive) return
    const column = columns[activeCol]
    if (column.props.formula) return refuseFormula(column)
    if (column.values[activeRow] !== null) store().setCell(activeRow, column.id, null)
  }

  const addRow = () => {
    if (!commitEdit()) return
    store().addRows(1)
    const col = hasActive ? activeCol : 0
    if (columns[col]) {
      setActive({ row: nRows, columnId: columns[col].id })
      setActiveColumn(columns[col].id)
    }
    focusGrid()
  }

  // ------------------------------------------------------------------- mouse

  const selectByClick = (row: number, e: MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      selectRange(anchor.current, row, e.ctrlKey || e.metaKey)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      selectRows([row], 'toggle')
    } else {
      selectRows([row], 'replace')
      dragging.current = true
    }
    anchor.current = row
  }

  const onRowNumberMouseDown = (row: number, e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (!commitEdit()) return
    selectByClick(row, e)
    focusGrid()
  }

  const onCellMouseDown = (row: number, col: number, e: MouseEvent) => {
    if (e.button !== 0) return
    const current = editRef.current
    if (current && current.row === row && current.columnId === columns[col].id) return // clicking inside the editor
    e.preventDefault()
    if (!commitEdit()) return
    activate(row, col)
    selectByClick(row, e)
    focusGrid()
  }

  const onRowMouseEnter = (row: number) => {
    if (dragging.current && anchor.current !== null) selectRange(anchor.current, row, false)
  }

  // ---------------------------------------------------------------- keyboard

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || store().dialog) return
    const mod = e.ctrlKey || e.metaKey
    const proxy = clipboardRef.current
    if (mod && !e.altKey && proxy && (e.key === 'c' || e.key === 'C')) {
      // Let the browser copy the proxy's selected text, then come back.
      const text = copyText()
      if (text === null) return
      proxy.value = text
      proxy.focus()
      proxy.select()
      setTimeout(focusGrid, 0)
      return
    }
    if (mod && !e.altKey && proxy && (e.key === 'v' || e.key === 'V')) {
      if (!hasActive) return
      // The paste lands in the proxy (onPaste below); come back even if nothing was pasted.
      proxy.value = ''
      proxy.focus()
      setTimeout(() => document.activeElement === proxy && focusGrid(), 300)
      return
    }
    const page = Math.max(1, Math.floor(viewHeight / ROW_H) - 1)
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(-1, 0),
      ArrowDown: () => move(1, 0),
      ArrowLeft: () => move(0, -1),
      ArrowRight: () => move(0, 1),
      Tab: () => move(0, e.shiftKey ? -1 : 1, true),
      PageUp: () => move(-page, 0),
      PageDown: () => move(page, 0),
      Home: () => (mod ? hasActive && activate(0, activeCol) : move(0, -columns.length)),
      End: () => (mod ? hasActive && activate(nRows - 1, activeCol) : move(0, columns.length)),
      Enter: () => (hasActive ? startEdit() : move(0, 0)),
      F2: () => startEdit(),
      Delete: clearActive,
      Backspace: clearActive,
    }
    const action = keys[e.key]
    if (action && !(mod && !['Home', 'End'].includes(e.key))) {
      e.preventDefault()
      action()
    } else if (e.key.length === 1 && !mod && !e.altKey && hasActive) {
      e.preventDefault()
      startEdit(e.key)
    }
  }

  const onEditorKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const after = (dRow: number, dCol: number, wrap = false) => {
      e.preventDefault()
      if (commitEdit()) {
        move(dRow, dCol, wrap)
        focusGrid()
      }
    }
    if (e.key === 'Enter') after(e.shiftKey ? -1 : 1, 0)
    else if (e.key === 'Tab') after(0, e.shiftKey ? -1 : 1, true)
    else if (e.key === 'ArrowUp') after(-1, 0)
    else if (e.key === 'ArrowDown') after(1, 0)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelEdit()
      focusGrid()
    }
  }

  const onEditorBlur = () => {
    const current = editRef.current
    if (!current) return
    if (!commitEdit()) {
      store().notify(`${current.error ?? 'Invalid value'}; the edit was discarded.`, 'error')
      setEdit(null)
    }
  }

  // --------------------------------------------------------------- clipboard

  /** What Ctrl/Cmd+C copies: the selected rows when several are selected, else the active cell. */
  const copyText = (): string | null => {
    if (table.nSelected > 1) {
      const rows: number[] = []
      for (let r = 0; r < nRows; r++) if (selected[r]) rows.push(r)
      store().notify(`Copied ${rows.length} rows`)
      return rowsToTsv(columns, rows)
    }
    return hasActive ? plainText(columns[activeCol].values[activeRow]) : null
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    focusGrid()
    if (!hasActive) return
    const block = parseDelimited(e.clipboardData.getData('text/plain'), '\t')
    if (!block.length) return
    const needed = activeRow + block.length - nRows
    if (needed > 0) store().addRows(needed)
    const edits: { row: number; columnId: string; value: Value }[] = []
    let invalid = 0
    let skippedFormula = 0
    let clipped = 0
    block.forEach((fields, i) => {
      fields.forEach((text, j) => {
        const column = columns[activeCol + j]
        if (!column) return void clipped++
        if (column.props.formula) return void skippedFormula++
        const parsed = parseCellInput(text, column.dataType)
        if (!parsed.ok) invalid++
        edits.push({ row: activeRow + i, columnId: column.id, value: parsed.ok ? parsed.value : null })
      })
    })
    store().setCells(edits)
    const notes = [`Pasted ${edits.length} cell${edits.length === 1 ? '' : 's'}`]
    if (needed > 0) notes.push(`added ${needed} row${needed === 1 ? '' : 's'}`)
    if (invalid) notes.push(`${invalid} non-numeric value${invalid === 1 ? '' : 's'} left missing`)
    if (skippedFormula) notes.push(`${skippedFormula} formula cell${skippedFormula === 1 ? '' : 's'} skipped`)
    if (clipped) notes.push(`${clipped} value${clipped === 1 ? '' : 's'} past the last column ignored`)
    store().notify(notes.join('; '), invalid || clipped ? 'error' : 'info')
  }

  // ------------------------------------------------------------------ render

  const rows = []
  for (let r = first; r < last; r++) {
    const isSelected = selected[r] === 1
    const isExcluded = excluded[r] === 1
    rows.push(
      <div
        key={r}
        className={`grid-row${isSelected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_H + r * ROW_H, width }}
        onMouseEnter={() => onRowMouseEnter(r)}
      >
        <div className="grid-rownum" style={{ width: ROWNUM_W }} onMouseDown={(e) => onRowNumberMouseDown(r, e)}>
          {isExcluded && (
            <span className="excluded-mark" title="Excluded">
              ⊘
            </span>
          )}
          {r + 1}
        </div>
        {columns.map((c, ci) => {
          const v = c.values[r]
          const isActive = r === activeRow && ci === activeCol
          const editing = edit !== null && edit.row === r && edit.columnId === c.id
          return (
            <div
              key={c.id}
              className={`grid-cell${typeof v === 'number' ? ' num' : ''}${v === null ? ' missing' : ''}${isActive ? ' active-cell' : ''}${editing ? ' editing' : ''}${c.props.formula ? ' formula' : ''}`}
              style={{ width: COL_W }}
              onMouseDown={(e) => onCellMouseDown(r, ci, e)}
              onDoubleClick={() => startEdit()}
            >
              {editing && edit ? (
                <input
                  className={`cell-editor${edit.error ? ' invalid' : ''}${c.dataType === 'numeric' ? ' num' : ''}`}
                  value={edit.text}
                  autoFocus
                  aria-label={`${c.name}, row ${r + 1}`}
                  aria-invalid={!!edit.error}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value, error: null })}
                  onKeyDown={onEditorKeyDown}
                  onBlur={onEditorBlur}
                />
              ) : v === null ? (
                c.dataType === 'numeric' ? (
                  '•'
                ) : (
                  ''
                )
              ) : (
                formatValue(v)
              )}
            </div>
          )
        })}
      </div>,
    )
  }

  const editCol = edit ? columns.findIndex((c) => c.id === edit.columnId) : -1

  return (
    <>
      <div
        className="grid-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={nRows}
        aria-colcount={columns.length}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onGridKeyDown}
      >
        <div className="grid-inner" style={{ height: HEADER_H + (nRows + 1) * ROW_H, width }}>
          <div className="grid-header" style={{ height: HEADER_H, width }}>
            <div className="grid-corner" style={{ width: ROWNUM_W }} />
            {columns.map((c) => (
              <div
                key={c.id}
                className={`grid-colhead${activeColumnId === c.id ? ' active' : ''}`}
                style={{ width: COL_W }}
                title={`${c.name} (${c.modelingType}${c.props.formula ? ', formula' : ''}). Double-click for Column Info.`}
                onClick={() => setActiveColumn(c.id)}
                onDoubleClick={() => openDialog({ kind: 'column_info', columnId: c.id })}
              >
                <ModelingIcon type={c.modelingType} />
                <span>{c.name}</span>
                {c.props.formula && <span className={`formula-badge${c.formulaError ? ' error' : ''}`}>ƒ</span>}
              </div>
            ))}
            <button
              className="grid-addcol"
              style={{ width: ADD_COL_W }}
              title="New Column…"
              aria-label="New column"
              onClick={() => openDialog({ kind: 'new_column' })}
            >
              +
            </button>
          </div>
          {rows}
          <div className="grid-addrow" style={{ top: HEADER_H + nRows * ROW_H, width }}>
            <button onClick={addRow} title="Add a row at the end">
              + Add row
            </button>
            {nRows === 0 && <span className="muted">This table has no rows yet. Add rows, then type or paste values.</span>}
          </div>
          {edit?.error && editCol >= 0 && (
            <div
              className="cell-error"
              role="alert"
              style={{ top: HEADER_H + (edit.row + 1) * ROW_H + 2, left: ROWNUM_W + editCol * COL_W }}
            >
              {edit.error}. Press Esc to cancel.
            </div>
          )}
        </div>
      </div>
      <textarea ref={clipboardRef} className="clipboard-proxy" aria-hidden="true" tabIndex={-1} onPaste={onPaste} readOnly={false} />
    </>
  )
}
