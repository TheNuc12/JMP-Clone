// Golden tests: the reference engine's results (backend/golden/export.py) that the
// TypeScript engine must reproduce.

import type { AnalysisColumn, AnalyzeRequest, Value } from '../api/types'
import { pyStr } from './pyformat'

export interface Tolerance {
  rtol?: number
  atol?: number
}

export interface GoldenCase {
  name: string
  kind: 'analyze' | 'doe' | 'upload'
  request: Record<string, unknown>
  rows?: number[]
  tol?: Tolerance
  /** DOE only: 'exact', 'rows' (same runs in any order) or 'properties'. */
  compare?: 'exact' | 'rows' | 'properties'
  expected: unknown
}

export interface GoldenFile {
  area: string
  datasets: Record<string, Record<string, Value[]>>
  cases: GoldenCase[]
}

interface ColumnRef {
  $col: string
  modeling_type: AnalysisColumn['modeling_type']
  levels?: string[] | null
  name?: string
}

/** Like the export's _label: numbers print as JavaScript's String(number) would. */
function label(v: Value): string | null {
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : pyStr(v)) : null
  return v
}

function resolveColumn(file: GoldenFile, ref: ColumnRef, rows?: number[]): AnalysisColumn {
  const [dataset, column] = [ref.$col.slice(0, ref.$col.indexOf('.')), ref.$col.slice(ref.$col.indexOf('.') + 1)]
  let values = file.datasets[dataset][column]
  if (rows) values = rows.map((i) => values[i])
  const categorical = ref.modeling_type !== 'continuous'
  return {
    name: ref.name ?? column,
    modeling_type: ref.modeling_type,
    values: values.map((v) => (categorical ? label(v) : typeof v === 'number' && Number.isFinite(v) ? v : null)),
    levels: ref.levels ?? null,
  }
}

/** The AnalyzeRequest a golden case stands for (column references resolved). */
export function resolveRequest(file: GoldenFile, c: GoldenCase): AnalyzeRequest {
  const r = c.request as unknown as Omit<AnalyzeRequest, 'y' | 'x' | 'roles'> & { y: ColumnRef; x?: ColumnRef; roles?: Record<string, ColumnRef[]> }
  return {
    platform: r.platform,
    y: resolveColumn(file, r.y, c.rows),
    x: r.x ? resolveColumn(file, r.x, c.rows) : null,
    roles: Object.fromEntries(Object.entries(r.roles ?? {}).map(([k, v]) => [k, v.map((ref) => resolveColumn(file, ref, c.rows))])),
    params: r.params ?? {},
    options: r.options ?? {},
  }
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi

/** Strings must match, except that embedded numbers may differ by a relative 1e-4 (printed digits). */
function sameText(a: string, b: string): boolean {
  if (a === b) return true
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false
  const na = a.match(NUMBER) ?? []
  const nb = b.match(NUMBER) ?? []
  return na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) <= 1e-4 * Math.max(1, Math.abs(Number(nb[i]))))
}

/**
 * Differences between `actual` and `expected`, as "path: detail" strings. Numbers compare
 * within atol + rtol * |expected|; a missing key equals null; extra non-null keys differ.
 */
export function diff(actual: unknown, expected: unknown, tol: Tolerance = {}, path = '$', out: string[] = []): string[] {
  const rtol = tol.rtol ?? 1e-6
  const atol = tol.atol ?? 1e-9
  if (out.length > 30) return out
  const a = actual === undefined ? null : actual
  const e = expected === undefined ? null : expected
  if (typeof e === 'number' && typeof a === 'number') {
    if (!(Math.abs(a - e) <= atol + rtol * Math.abs(e))) out.push(`${path}: ${a} != ${e}`)
  } else if (typeof e === 'string' && typeof a === 'string') {
    if (!sameText(a, e)) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(e)}`)
  } else if (Array.isArray(e)) {
    if (!Array.isArray(a)) out.push(`${path}: expected an array, got ${JSON.stringify(a)?.slice(0, 80)}`)
    else if (a.length !== e.length) out.push(`${path}: length ${a.length} != ${e.length}`)
    else e.forEach((item, i) => diff(a[i], item, tol, `${path}[${i}]`, out))
  } else if (e && typeof e === 'object') {
    if (!a || typeof a !== 'object' || Array.isArray(a)) out.push(`${path}: expected an object, got ${JSON.stringify(a)?.slice(0, 80)}`)
    else {
      const ao = a as Record<string, unknown>
      const eo = e as Record<string, unknown>
      for (const key of Object.keys(eo)) diff(ao[key], eo[key], tol, `${path}.${key}`, out)
      for (const key of Object.keys(ao)) if (!(key in eo) && ao[key] !== null && ao[key] !== undefined) out.push(`${path}.${key}: unexpected`)
    }
  } else if (a !== e) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(e)?.slice(0, 80)}`)
  return out
}
