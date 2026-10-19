import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatValue } from '../lib/format'
import { checkFormula, formulaRef, FUNCTIONS, type FormulaCheck, type FunctionCategory, type FunctionInfo } from '../lib/formula'
import type { Column } from '../state/store'
import { ModelingIcon } from './ModelingIcon'
import './FormulaEditor.css'

const CATEGORIES: FunctionCategory[] = ['Math', 'Across arguments', 'Conditional', 'Row', 'Column statistics', 'Character', 'Random']

/** The error's line of source with a caret under the error position. */
function caretLines(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const lineEnd = source.indexOf('\n', position)
  const line = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
  return `${line}\n${' '.repeat(position - lineStart)}^`
}

/**
 * Formula editor: edits formula source for a column. `columns` are the table's columns
 * (for inserting references and previewing); `selfId` is the column being edited, if any.
 */
export function FormulaEditor({
  value,
  onChange,
  columns,
  nRows,
  selfId,
}: {
  value: string
  onChange: (formula: string) => void
  columns: Column[]
  nRows: number
  selfId?: string
}) {
  const textRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const statusId = useId()
  const [check, setCheck] = useState<FormulaCheck>(() => checkFormula(value, columns, nRows, selfId))
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<FunctionCategory | 'All'>('All')
  const [focused, setFocused] = useState<FunctionInfo | null>(null)

  // Validate shortly after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setCheck(checkFormula(value, columns, nRows, selfId)), 200)
    return () => clearTimeout(timer)
  }, [value, columns, nRows, selfId])

  // Put the cursor where an insertion asked for it once the new text is rendered.
  useLayoutEffect(() => {
    const ta = textRef.current
    if (ta && pendingCaret.current !== null) {
      ta.focus()
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value])

  /** Insert text at the cursor. A "|" in a template marks the cursor and wraps the selection. */
  const insert = (template: string) => {
    const ta = textRef.current
    const start = ta?.selectionStart ?? value.length
    const end = ta?.selectionEnd ?? value.length
    const selected = value.slice(start, end)
    const marker = template.indexOf('|')
    const text = marker < 0 ? template : template.slice(0, marker) + selected + template.slice(marker + 1)
    const caret = marker < 0 ? text.length : marker + selected.length
    pendingCaret.current = start + caret
    onChange(value.slice(0, start) + text + value.slice(end))
  }

  const insertable = columns.filter((c) => c.id !== selfId)
  const functions = useMemo(() => {
    const q = search.trim().toLowerCase()
    return FUNCTIONS.filter(
      (f) =>
        (category === 'All' || f.category === category) &&
        (!q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)),
    )
  }, [search, category])

  const error = check.error
  return (
    <div className="formula-editor">
      <textarea
        ref={textRef}
        className={`formula-input${error ? ' invalid' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        aria-label="Formula"
        aria-invalid={!!error}
        aria-describedby={statusId}
        placeholder="e.g. :weight / (:height ^ 2) * 703"
      />
      <div id={statusId} className={`formula-status${error ? ' error' : ''}`} role="status">
        {error ? (
          <>
            <span>{error.message}</span>
            {error.position !== undefined && <pre className="formula-caret">{caretLines(value, error.position)}</pre>}
          </>
        ) : check.empty ? (
          <span className="muted">Type a formula, or click columns and functions below to insert them.</span>
        ) : (
          <>
            <span className="formula-type">
              {check.dataType === 'numeric' ? 'Numeric' : 'Character'} · {nRows - check.nMissing} of {nRows} rows have values
            </span>
            <span className="formula-preview" aria-label="Preview">
              {check.preview.map((v, i) => (
                <span key={i} className={v === null ? 'missing' : ''}>
                  <em>{i + 1}</em>
                  {v === null ? '•' : formatValue(v)}
                </span>
              ))}
            </span>
          </>
        )}
      </div>
      <div className="formula-palettes">
        <section className="formula-palette">
          <div className="formula-palette-title">Columns</div>
          <ul>
            {insertable.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => insert(formulaRef(c.name))} title={`Insert ${formulaRef(c.name)}`}>
                  <ModelingIcon type={c.modelingType} /> {c.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="formula-palette">
          <div className="formula-palette-title">
            Functions
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search functions" />
            <select value={category} onChange={(e) => setCategory(e.target.value as FunctionCategory | 'All')} aria-label="Function category">
              <option value="All">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <ul>
            {functions.map((f) => (
              <li key={f.name}>
                <button
                  type="button"
                  onClick={() => insert(f.template)}
                  onMouseEnter={() => setFocused(f)}
                  onFocus={() => setFocused(f)}
                  title={`${f.signature}: ${f.description}`}
                >
                  {f.name}
                  {category === 'All' && <span className="formula-category">{f.category}</span>}
                </button>
              </li>
            ))}
            {functions.length === 0 && <li className="muted">No matching functions</li>}
          </ul>
          <div className="formula-help">
            {focused ? (
              <>
                <code>{focused.signature}</code> {focused.description}
              </>
            ) : (
              <span className="muted">Operators: + - * / ^ · == != &lt; &lt;= &gt; &gt;= · &amp; | ! · || joins text · . is missing</span>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
