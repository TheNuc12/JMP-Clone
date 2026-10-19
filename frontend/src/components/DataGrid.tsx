import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { formatValue } from '../lib/format'
import { useStore } from '../state/store'
import { ModelingIcon } from './ModelingIcon'

const ROW_H = 24
const HEADER_H = 30
const ROWNUM_W = 64
const COL_W = 116
const OVERSCAN = 8

/**
 * Virtualized data table. Click a row to select it, shift-click for a range,
 * ctrl/cmd-click to toggle, or drag down the row numbers.
 */
export function DataGrid() {
  const table = useStore((s) => s.table)
  const selected = useStore((s) => s.selected)
  const excluded = useStore((s) => s.excluded)
  const selectRows = useStore((s) => s.selectRows)
  const selectRange = useStore((s) => s.selectRange)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(600)
  const anchor = useRef<number | null>(null)
  const dragging = useRef(false)

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

  if (!table) return null

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(table.nRows, Math.ceil((scrollTop + viewHeight) / ROW_H) + OVERSCAN)
  const width = ROWNUM_W + table.columns.length * COL_W

  const onRowMouseDown = (row: number, e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
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

  const onRowMouseEnter = (row: number) => {
    if (dragging.current && anchor.current !== null) selectRange(anchor.current, row, false)
  }

  const rows = []
  for (let r = first; r < last; r++) {
    const isSelected = selected[r] === 1
    const isExcluded = excluded[r] === 1
    rows.push(
      <div
        key={r}
        className={`grid-row${isSelected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}${r % 2 ? ' odd' : ''}`}
        style={{ top: HEADER_H + r * ROW_H, width }}
        onMouseDown={(e) => onRowMouseDown(r, e)}
        onMouseEnter={() => onRowMouseEnter(r)}
      >
        <div className="grid-rownum" style={{ width: ROWNUM_W }}>
          {isExcluded && (
            <span className="excluded-mark" title="Excluded">
              ⊘
            </span>
          )}
          {r + 1}
        </div>
        {table.columns.map((c) => {
          const v = c.values[r]
          return (
            <div key={c.name} className={`grid-cell${typeof v === 'number' ? ' num' : ''}${v === null ? ' missing' : ''}`} style={{ width: COL_W }}>
              {v === null ? (c.dataType === 'numeric' ? '•' : '') : formatValue(v)}
            </div>
          )
        })}
      </div>,
    )
  }

  return (
    <div className="grid-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="grid-inner" style={{ height: HEADER_H + table.nRows * ROW_H, width }}>
        <div className="grid-header" style={{ height: HEADER_H, width }}>
          <div className="grid-corner" style={{ width: ROWNUM_W }} />
          {table.columns.map((c) => (
            <div key={c.name} className="grid-colhead" style={{ width: COL_W }} title={`${c.name} (${c.modelingType})`}>
              <ModelingIcon type={c.modelingType} />
              <span>{c.name}</span>
            </div>
          ))}
        </div>
        {rows}
      </div>
    </div>
  )
}
