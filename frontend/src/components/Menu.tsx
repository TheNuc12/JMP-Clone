import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

export interface MenuItem {
  label: string
  onSelect?: () => void
  checked?: boolean
  disabled?: boolean
  shortcut?: string
  separator?: boolean
  hint?: string
}

/** Calls `onClose` on a mouse press outside `ref`, or on Escape, while `active`. */
function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, active, onClose])
}

function MenuList({ items, onPick, className, style, listRef }: { items: MenuItem[]; onPick: () => void; className: string; style?: CSSProperties; listRef?: RefObject<HTMLUListElement | null> }) {
  return (
    <ul className={className} style={style} role="menu" ref={listRef}>
      {items.map((item, i) =>
        item.separator ? (
          <li key={i} className="menu-separator" role="separator" />
        ) : (
          <li key={i} role="none">
            <button
              role="menuitem"
              className="menu-item"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                onPick()
                item.onSelect?.()
              }}
            >
              <span className="menu-check">{item.checked ? '✓' : ''}</span>
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            </button>
          </li>
        ),
      )}
    </ul>
  )
}

/** A button that opens a dropdown list of actions. Closes on outside click or Escape. */
export function Menu({
  trigger,
  items,
  triggerClassName = 'menu-trigger',
  align = 'left',
}: {
  trigger: ReactNode
  items: MenuItem[]
  triggerClassName?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(() => setOpen(false)).current
  useDismiss(ref, open, close)

  return (
    <div className="menu" ref={ref}>
      <button className={`${triggerClassName}${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
      </button>
      {open && <MenuList items={items} onPick={close} className={`menu-list align-${align}`} />}
    </div>
  )
}

/**
 * A right-click menu at viewport position (x, y), kept on screen. Closes on outside click,
 * Escape, scrolling or resizing the window.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useDismiss(ref, true, onClose)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) })
  }, [x, y])

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return <MenuList items={items} onPick={onClose} className="menu-list context-menu" style={pos} listRef={ref} />
}
