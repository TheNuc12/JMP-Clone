// Delimited text: CSV export, clipboard TSV, and parsing what users type into cells.

import type { DataType, Value } from '../api/types'
import type { Column, TableDoc } from '../state/store'

/** A value as plain text: numbers keep full precision without float noise, missing is empty. */
export function plainText(value: Value): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(15))) : ''
  return value
}

/** One delimited field, quoted (RFC 4180) when it contains the delimiter, a quote or a line break. */
export function quoteField(text: string, delimiter = ','): string {
  const needsQuotes = text.includes(delimiter) || /["\r\n]/.test(text) || text !== text.trim()
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text
}

/** The table as CSV: a header row of column names, then one line per row (CRLF line ends). */
export function tableToCsv(table: TableDoc): string {
  const lines = [table.columns.map((c) => quoteField(c.name)).join(',')]
  for (let r = 0; r < table.nRows; r++) lines.push(table.columns.map((c) => quoteField(plainText(c.values[r]))).join(','))
  return lines.join('\r\n') + '\r\n'
}

/** A file name without characters that file systems reject. */
export function safeFileName(name: string, fallback = 'data'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim()
  return cleaned || fallback
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Download a table as CSV. */
export function downloadTableCsv(table: TableDoc): void {
  saveBlob(new Blob([tableToCsv(table)], { type: 'text/csv;charset=utf-8' }), `${safeFileName(table.name)}.csv`)
}

/**
 * Split delimited text into rows of fields. Quoted fields may contain delimiters, quotes
 * ("") and line breaks, as spreadsheets produce when copying. A final line break is ignored.
 */
export function parseDelimited(text: string, delimiter = '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      if (ch === '"') quoted = false
      else field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else {
      field += ch
    }
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Rows of a table as tab-separated text (no header), for the clipboard. */
export function rowsToTsv(columns: Column[], rows: number[]): string {
  return rows.map((r) => columns.map((c) => quoteField(plainText(c.values[r]), '\t')).join('\t')).join('\n')
}

export type ParsedCell = { ok: true; value: Value } | { ok: false; error: string }

/**
 * Interpret text typed (or pasted) into a cell. Empty text and a lone "." are missing.
 * Numeric columns reject text that isn't a number instead of storing missing.
 */
export function parseCellInput(text: string, dataType: DataType): ParsedCell {
  const trimmed = text.trim()
  if (trimmed === '' || (dataType === 'numeric' && trimmed === '.')) return { ok: true, value: null }
  if (dataType === 'character') return { ok: true, value: text }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return { ok: false, error: `"${trimmed}" is not a number` }
  return { ok: true, value: n }
}
