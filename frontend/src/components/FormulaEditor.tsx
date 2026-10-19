import type { Column } from '../state/store'

/**
 * Formula editor: edits formula source for a column. `columns` are the table's columns
 * (for inserting references and previewing); `selfId` is the column being edited, if any.
 */
export function FormulaEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (formula: string) => void
  columns: Column[]
  nRows: number
  selfId?: string
}) {
  return <textarea className="formula-input" value={value} onChange={(e) => onChange(e.target.value)} rows={4} spellCheck={false} />
}
