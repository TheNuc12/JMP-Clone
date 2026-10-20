// File parsing (port of backend/app/io.py): CSV / TSV / TXT and Excel (.xlsx) into tables,
// with pandas' type inference.

import type { ColumnData, DataTablePayload, Value } from '../api/types'
import { pyStr } from './pyformat'

export class UploadError extends Error {}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt'])
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm'])

/** pandas' default missing-value strings plus JMP's ".". */
const NA_VALUES = new Set([
  '', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
  '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null', '.',
])
const TRUE_VALUES = new Set(['True', 'TRUE', 'true'])
const FALSE_VALUES = new Set(['False', 'FALSE', 'false'])

/** A cell as read from the file: text from CSV; typed values from Excel. */
type Raw = string | number | boolean | Date | null

export async function parseUpload(filename: string, content: Uint8Array): Promise<DataTablePayload> {
  const base = (filename || 'data').split(/[\\/]/).pop()!
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  const stem = dot > 0 ? base.slice(0, dot) : base
  if (content.length > MAX_UPLOAD_BYTES) throw new UploadError(`File is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`)
  if (content.length === 0) throw new UploadError('File is empty.')

  let rows: Raw[][]
  if (TEXT_EXTENSIONS.has(ext)) rows = readText(content, ext)
  else if (EXCEL_EXTENSIONS.has(ext)) {
    try {
      rows = await readXlsx(content)
    } catch (e) {
      throw new UploadError(`Could not read Excel file: ${(e as Error).message}`)
    }
  } else if (ext === '.xls') throw new UploadError('Legacy .xls files are not supported; save the sheet as .xlsx or CSV.')
  else throw new UploadError(`Unsupported file type '${ext || base}'. Use CSV, TSV, TXT or XLSX.`)

  if (rows.length === 0 || rows[0].length === 0) throw new UploadError('No columns found in file.')
  return toPayload(stem || 'data', rows)
}

// ------------------------------------------------------------------------- text

function decode(content: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    // Python's latin-1: every byte is the code point of the same value.
    let out = ''
    for (let i = 0; i < content.length; i += 8192) out += String.fromCharCode(...content.subarray(i, i + 8192))
    return out
  }
}

function readText(content: Uint8Array, ext: string): Raw[][] {
  const text = decode(content)
  const sep = ext === '.tsv' ? '\t' : ext === '.txt' ? sniffDelimiter(text) : ','
  const rows = tokenize(text, sep)
  if (rows.length === 0) throw new UploadError('Could not parse file: No columns to parse from file')
  const width = rows[0].length
  rows.forEach((r, i) => {
    if (r.length > width) {
      throw new UploadError(`Could not parse file: Error tokenizing data. C error: Expected ${width} fields in line ${i + 1}, saw ${r.length}`)
    }
  })
  return rows
}

/** The delimiter that splits the first lines most consistently (like csv.Sniffer). */
function sniffDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0).slice(0, 20)
  let best = ','
  let bestScore = -1
  for (const sep of [',', '\t', ';', '|', ':', ' ']) {
    const counts = lines.map((l) => l.split(sep).length - 1)
    if (!counts.length || counts[0] === 0) continue
    const consistent = counts.filter((c) => c === counts[0]).length
    if (consistent > bestScore) {
      best = sep
      bestScore = consistent
    }
  }
  return best
}

/** Split delimited text into rows of fields; quotes allow separators, quotes ("") and newlines. Blank lines are skipped. */
function tokenize(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let fieldStarted = false
  const endRow = () => {
    if (fieldStarted || row.length > 0 || field !== '') {
      row.push(field)
      rows.push(row)
    }
    row = []
    field = ''
    fieldStarted = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') {
      quoted = true
      fieldStarted = true
    } else if (ch === sep) {
      row.push(field)
      field = ''
      fieldStarted = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      field += ch
      fieldStarted = true
    }
  }
  endRow()
  return rows
}

// ----------------------------------------------------------------------- tables

/** Header names as pandas makes them: "Unnamed: i" for blanks, "x.1", "x.2" for duplicates. */
function headerNames(header: Raw[], width: number): string[] {
  const counts = new Map<string, number>()
  return Array.from({ length: width }, (_, i) => {
    const cell = header[i]
    let name = cell === null || cell === undefined || cell === '' ? `Unnamed: ${i}` : cellText(cell)
    let count = counts.get(name) ?? 0
    while (count > 0) {
      counts.set(name, count + 1)
      name = `${name}.${count}`
      count = counts.get(name) ?? 0
    }
    counts.set(name, count + 1)
    return name
  })
}

/** Python's str() of a cell value. */
function cellText(cell: Raw): string {
  if (typeof cell === 'boolean') return cell ? 'True' : 'False'
  if (typeof cell === 'number') return pyStr(cell)
  if (cell instanceof Date) return isoDateTime(cell)
  return String(cell)
}

function isNA(cell: Raw | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && NA_VALUES.has(cell)) || (typeof cell === 'number' && Number.isNaN(cell))
}

/** pandas' C parser numbers: surrounding whitespace allowed, inf/infinity accepted. */
function parseNumber(cell: Raw): number | null {
  if (typeof cell === 'number') return cell
  if (typeof cell !== 'string') return null
  const s = cell.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity
  return null
}

function toPayload(name: string, rows: Raw[][]): DataTablePayload {
  const width = Math.max(...rows.map((r) => r.length))
  const names = headerNames(rows[0], width)
  const body = rows.slice(1)
  const columns = names.map((colName, j) => inferColumn(colName, body.map((r) => r[j] ?? null)))
  return { name, n_rows: body.length, columns }
}

function inferColumn(name: string, cells: Raw[]): ColumnData {
  if (cells.length === 0) return character(name, cells)
  const present = cells.filter((c) => !isNA(c))
  if (present.every((c) => typeof c === 'boolean' || (typeof c === 'string' && (TRUE_VALUES.has(c) || FALSE_VALUES.has(c))))) {
    if (present.length) return character(name, cells.map((c) => (isNA(c) ? null : c === true || (typeof c === 'string' && TRUE_VALUES.has(c)))))
  }
  if (present.every((c) => c instanceof Date) && present.length) return dates(name, cells as (Date | null)[])
  const numbers = cells.map((c) => (isNA(c) ? NaN : parseNumber(c)))
  if (numbers.every((n) => n !== null)) return numeric(name, numbers as number[])
  return character(name, cells)
}

function numeric(name: string, values: number[]): ColumnData {
  return {
    name,
    data_type: 'numeric',
    modeling_type: 'continuous',
    // Integers stay integers only below 2^53, as in the reference; JSON numbers can't tell the difference.
    values: values.map((v) => (Number.isFinite(v) ? v : null)),
  }
}

function character(name: string, cells: Raw[]): ColumnData {
  const values: Value[] = cells.map((c) => {
    if (isNA(c)) return null
    const label = typeof c === 'string' ? c.trim() : cellText(c!)
    return label === '' ? null : label
  })
  return { name, data_type: 'character', modeling_type: 'nominal', values }
}

function dates(name: string, cells: (Date | null)[]): ColumnData {
  const present = cells.filter((c): c is Date => c instanceof Date)
  const dateOnly = present.every((d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0)
  const values = cells.map((c) => (c instanceof Date ? (dateOnly ? isoDateTime(c).slice(0, 10) : isoDateTime(c).slice(0, 19)) : null))
  return { name, data_type: 'character', modeling_type: 'nominal', values }
}

function isoDateTime(d: Date): string {
  return d.toISOString().replace('Z', '').replace(/\.000$/, '')
}

// ------------------------------------------------------------------------ Excel

/** Rows of the first worksheet, with Excel's typed values (header row first). */
async function readXlsx(content: Uint8Array): Promise<Raw[][]> {
  const zip = await unzip(content)
  const text = (path: string) => {
    const bytes = zip.get(path)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
  const workbook = text('xl/workbook.xml')
  if (!workbook) throw new Error('File is not an Excel workbook')
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  const rels = text('xl/_rels/workbook.xml.rels') ?? ''
  const relTarget = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => m[0])
    .find((tag) => attr(tag, 'Id') === firstSheet)
  const target = relTarget ? attr(relTarget, 'Target')! : 'worksheets/sheet1.xml'
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  const sheet = text(sheetPath)
  if (!sheet) throw new Error(`Worksheet ${sheetPath} is missing`)
  const date1904 = /date1904="(1|true)"/.test(workbook)
  const shared = sharedStrings(text('xl/sharedStrings.xml'))
  const dateStyles = dateStyleIndexes(text('xl/styles.xml'))

  const rows: Raw[][] = []
  for (const rowMatch of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rowIndex = Number(attr(rowMatch[1], 'r') ?? rows.length + 1) - 1
    const cells: Raw[] = []
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cellMatch[1]
      const ref = attr(attrs, 'r')
      const col = ref ? columnIndex(ref) : cells.length
      cells[col] = cellValue(attrs, cellMatch[2] ?? '', shared, dateStyles, date1904)
    }
    rows[rowIndex] = Array.from(cells, (c) => (c === undefined ? null : c))
  }
  // Like pandas: skip leading empty rows, drop trailing empty cells and rows.
  const dense = Array.from(rows, (r) => r ?? [])
  while (dense.length && dense[0].every((c) => c === null || c === '')) dense.shift()
  for (const r of dense) while (r.length && (r[r.length - 1] === null || r[r.length - 1] === '')) r.pop()
  while (dense.length && dense[dense.length - 1].length === 0) dense.pop()
  return dense
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]!
  })
}

/** Concatenated text runs of an <si> / <is> element. */
function runsText(xml: string): string {
  let out = ''
  for (const m of xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) {
    out += unescapeXml(m[1] ?? '')
  }
  return out
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return []
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => runsText(m[1]))
}

/** Built-in date/time number formats (openpyxl's BUILTIN_FORMATS that are dates). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** openpyxl's is_date_format: date/time tokens outside quoted text, escapes and [brackets]. */
function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
  return !/general/i.test(stripped) && /[dmyhs]/i.test(stripped)
}

function dateStyleIndexes(xml: string | null): Set<number> {
  const out = new Set<number>()
  if (!xml) return out
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '')
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? ''
  ;[...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].forEach((m, index) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0)
    const code = custom.get(id)
    if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) out.add(index)
  })
  return out
}

function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64)
  return n - 1
}

function cellValue(attrs: string, inner: string, shared: string[], dateStyles: Set<number>, date1904: boolean): Raw {
  const type = attr(attrs, 't') ?? 'n'
  const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1]
  if (type === 'inlineStr') return runsText(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner)?.[1] ?? '')
  if (v === undefined) return null
  const raw = unescapeXml(v)
  if (type === 's') return shared[Number(raw)] ?? null
  if (type === 'str' || type === 'e') return raw
  if (type === 'b') return raw === '1' || raw === 'true'
  const value = Number(raw)
  if (Number.isNaN(value)) return raw
  if (dateStyles.has(Number(attr(attrs, 's') ?? -1))) return excelDate(value, date1904)
  return value
}

/** Excel serial date to a UTC Date (1900 system with its phantom leap day, or 1904). */
function excelDate(serial: number, date1904: boolean): Date {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const days = !date1904 && serial < 60 ? serial + 1 : serial
  const ms = Math.round(days * 86400000)
  return new Date(epoch + ms)
}

/** Files of a ZIP archive (stored or deflated entries). */
async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('File is not a zip file')
  const entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const files = new Map<string, Uint8Array>()
  for (let e = 0; e < entries; e++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Corrupt zip directory')
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength))
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = data.subarray(start, start + size)
    if (method === 0) files.set(name, raw)
    else if (method === 8) files.set(name, await inflateRaw(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
