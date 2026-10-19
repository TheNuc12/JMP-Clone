import { useEffect, type ReactNode } from 'react'

/** Standard dialog frame: backdrop, header, scrollable body, footer. Escape or a backdrop click closes it. */
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  className = '',
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

/** Placeholder body for dialogs that are not built yet. */
export function NotBuilt({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <p className="report-text">Not implemented yet.</p>
    </Modal>
  )
}
