import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { findColumn, useActiveTable, useStore } from '../state/store'
import { ContextMenu, type MenuItem } from './Menu'

interface Target {
  x: number
  y: number
  columnId: string
}

/**
 * Right-click menu for a column (insert left / right, Column Info, delete). Returns a
 * handler for `onContextMenu` and the menu element to render.
 */
export function useColumnContextMenu(): [(e: MouseEvent, columnId: string) => void, ReactNode] {
  const table = useActiveTable()
  const [target, setTarget] = useState<Target | null>(null)
  const close = useCallback(() => setTarget(null), [])

  const open = (e: MouseEvent, columnId: string) => {
    e.preventDefault()
    useStore.getState().setActiveColumn(columnId)
    setTarget({ x: e.clientX, y: e.clientY, columnId })
  }

  const column = target ? findColumn(table, target.columnId) : undefined
  if (!target || !column) return [open, null]
  const store = useStore.getState
  const items: MenuItem[] = [
    { label: 'Insert Column Left', onSelect: () => store().insertColumn(column.id, 'left') },
    { label: 'Insert Column Right', onSelect: () => store().insertColumn(column.id, 'right') },
    { label: '', separator: true },
    { label: 'Column Info…', onSelect: () => store().openDialog({ kind: 'column_info', columnId: column.id }) },
    { label: `Delete Column: ${column.name}`, onSelect: () => store().deleteColumns([column.id]) },
  ]
  return [open, <ContextMenu x={target.x} y={target.y} items={items} onClose={close} />]
}
