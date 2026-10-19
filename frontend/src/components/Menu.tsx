import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  onSelect?: () => void
  checked?: boolean
  disabled?: boolean
  shortcut?: string
  separator?: boolean
  hint?: string
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

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button className={`${triggerClassName}${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
      </button>
      {open && (
        <ul className={`menu-list align-${align}`} role="menu">
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
                    setOpen(false)
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
      )}
    </div>
  )
}
