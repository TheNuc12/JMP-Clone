// Saving and restoring sessions (.sift files) and autosave.

import type { DataType, ModelingType, Value } from '../api/types'
import type { Column, ColumnProps, ReportConfig, ReportKind, TableDoc, TableModel, Workspace } from '../state/store'
import { activeTableOf, useStore } from '../state/store'
import { safeFileName, saveBlob } from './csv'
import { recomputeFormulas } from './formula'

export const SESSION_EXTENSION = '.sift'
export const SESSION_FORMAT = 'sift-session'
export const SESSION_VERSION = 1

interface SavedColumn {
  id: string
  name: string
  dataType: DataType
  modelingType: ModelingType
  values: Value[]
  props: ColumnProps
}

interface SavedTable {
  id: string
  name: string
  nRows: number
  columns: SavedColumn[]
  /** Row indices; masks are rebuilt on load. */
  selected: number[]
  excluded: number[]
  model?: TableModel
}

export interface SessionFile {
  format: typeof SESSION_FORMAT
  version: number
  savedAt: string
  tables: SavedTable[]
  reports: ReportConfig[]
  activeTableId: string | null
  activeReportId: string | null
}

export class SessionError extends Error {}

export function isSessionFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SESSION_EXTENSION)
}

// ---------------------------------------------------------------- serialize

function indicesOf(mask: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i)
  return out
}

/** A plain-JSON snapshot of the workspace. Formula errors are not saved; they are recomputed. */
export function serializeWorkspace(w: Workspace, savedAt: Date = new Date()): SessionFile {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: savedAt.toISOString(),
    tables: w.tables.map((t) => ({
      id: t.id,
      name: t.name,
      nRows: t.nRows,
      columns: t.columns.map((c) => ({
        id: c.id,
        name: c.name,
        dataType: c.dataType,
        modelingType: c.modelingType,
        values: c.values,
        props: c.props,
      })),
      selected: indicesOf(t.selected),
      excluded: indicesOf(t.excluded),
      ...(t.model ? { model: t.model } : {}),
    })),
    reports: w.reports,
    activeTableId: w.activeTableId,
    activeReportId: w.activeReportId,
  }
}

// -------------------------------------------------------------------- parse

const DATA_TYPES: DataType[] = ['numeric', 'character']
const MODELING_TYPES: ModelingType[] = ['continuous', 'ordinal', 'nominal']
const REPORT_KINDS: ReportKind[] = ['distribution', 'fit_y_by_x', 'fit_model', 'control_chart', 'capability', 'graph_builder']

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isNumberOrNull = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v))

function fail(where: string, problem: string): never {
  throw new SessionError(`This session file is damaged: ${where} ${problem}.`)
}

function parseProps(raw: unknown, where: string): ColumnProps {
  if (raw === undefined) return {}
  if (!isObj(raw)) fail(where, 'has invalid properties')
  const props: ColumnProps = {}
  if (raw.valueOrder !== undefined) {
    if (!isStringArray(raw.valueOrder)) fail(where, 'has an invalid value order')
    props.valueOrder = raw.valueOrder
  }
  if (raw.specLimits !== undefined) {
    const s = raw.specLimits
    if (!isObj(s) || !isNumberOrNull(s.lsl) || !isNumberOrNull(s.target) || !isNumberOrNull(s.usl)) fail(where, 'has invalid spec limits')
    props.specLimits = {
      ...(s.lsl != null ? { lsl: s.lsl as number } : {}),
      ...(s.target != null ? { target: s.target as number } : {}),
      ...(s.usl != null ? { usl: s.usl as number } : {}),
    }
  }
  if (raw.formula !== undefined) {
    if (typeof raw.formula !== 'string') fail(where, 'has an invalid formula')
    props.formula = raw.formula
  }
  return props
}

function parseColumn(raw: unknown, nRows: number, where: string): Column {
  if (!isObj(raw)) fail(where, 'is not a column')
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') fail(where, 'has no id or name')
  const label = `${where} ("${raw.name}")`
  if (!DATA_TYPES.includes(raw.dataType as DataType)) fail(label, 'has an unknown data type')
  if (!MODELING_TYPES.includes(raw.modelingType as ModelingType)) fail(label, 'has an unknown modeling type')
  if (!Array.isArray(raw.values) || raw.values.length !== nRows) fail(label, `should have ${nRows} values`)
  const numeric = raw.dataType === 'numeric'
  for (const v of raw.values) {
    const ok = v === null || (numeric ? typeof v === 'number' && Number.isFinite(v) : typeof v === 'string')
    if (!ok) fail(label, `has a value that doesn't match its data type`)
  }
  return {
    id: raw.id,
    name: raw.name,
    dataType: raw.dataType as DataType,
    modelingType: raw.modelingType as ModelingType,
    values: raw.values as Value[],
    props: parseProps(raw.props, label),
  }
}

function parseMask(raw: unknown, nRows: number, where: string): Uint8Array {
  if (raw === undefined) return new Uint8Array(nRows)
  if (!Array.isArray(raw)) fail(where, 'is not a list of rows')
  const mask = new Uint8Array(nRows)
  for (const r of raw) {
    if (!Number.isInteger(r) || r < 0 || r >= nRows) fail(where, 'refers to a row that does not exist')
    mask[r as number] = 1
  }
  return mask
}

function count(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

function parseTable(raw: unknown, index: number): TableDoc {
  const where = `table ${index + 1}`
  if (!isObj(raw)) fail(where, 'is not a table')
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') fail(where, 'has no id or name')
  const label = `table "${raw.name}"`
  const nRows = raw.nRows
  if (typeof nRows !== 'number' || !Number.isInteger(nRows) || nRows < 0) fail(label, 'has an invalid row count')
  if (!Array.isArray(raw.columns)) fail(label, 'has no columns')
  const columns = raw.columns.map((c, i) => parseColumn(c, nRows, `column ${i + 1} of ${label}`))
  const ids = new Set(columns.map((c) => c.id))
  if (ids.size !== columns.length) fail(label, 'has duplicate column ids')
  const selected = parseMask(raw.selected, nRows, `the selected rows of ${label}`)
  const excluded = parseMask(raw.excluded, nRows, `the excluded rows of ${label}`)
  let model: TableModel | undefined
  if (raw.model !== undefined) {
    const m = raw.model
    if (!isObj(m) || !isStringArray(m.responses) || !Array.isArray(m.effects) || !m.effects.every(isStringArray))
      fail(label, 'has an invalid model')
    const known = (id: string) => ids.has(id)
    model = {
      responses: m.responses.filter(known),
      effects: (m.effects as string[][]).map((e) => e.filter(known)).filter((e) => e.length > 0),
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    nRows,
    columns: recomputeFormulas(columns, nRows),
    selected,
    excluded,
    nSelected: count(selected),
    nExcluded: count(excluded),
    ...(model ? { model } : {}),
  }
}

function parseReport(raw: unknown, index: number, tableIds: Set<string>): ReportConfig {
  const where = `report ${index + 1}`
  if (!isObj(raw)) fail(where, 'is not a report')
  if (typeof raw.id !== 'string' || typeof raw.tableId !== 'string') fail(where, 'has no id or table')
  if (!tableIds.has(raw.tableId)) fail(where, 'belongs to a table that is not in the session')
  if (!REPORT_KINDS.includes(raw.kind as ReportKind)) fail(where, `has an unknown platform "${String(raw.kind)}"`)
  if (!isObj(raw.roles) || !Object.values(raw.roles).every(isStringArray)) fail(where, 'has invalid column roles')
  if (raw.params !== undefined && !isObj(raw.params)) fail(where, 'has invalid settings')
  if (raw.options !== undefined && !isObj(raw.options)) fail(where, 'has invalid options')
  return {
    id: raw.id,
    tableId: raw.tableId,
    kind: raw.kind as ReportKind,
    roles: raw.roles as Record<string, string[]>,
    params: (raw.params as Record<string, unknown>) ?? {},
    options: (raw.options as ReportConfig['options']) ?? {},
  }
}

/** Validate a parsed .sift document and turn it back into a workspace. */
export function parseSession(data: unknown): Workspace {
  if (!isObj(data) || data.format !== SESSION_FORMAT) throw new SessionError('This is not a Sift session file.')
  if (typeof data.version !== 'number') throw new SessionError('This session file has no version.')
  if (data.version > SESSION_VERSION) {
    throw new SessionError(
      `This session was saved by a newer version of Sift (format ${data.version}); this version reads format ${SESSION_VERSION}.`,
    )
  }
  if (!Array.isArray(data.tables)) fail('the file', 'has no tables')
  const tables = data.tables.map(parseTable)
  const tableIds = new Set(tables.map((t) => t.id))
  if (tableIds.size !== tables.length) fail('the file', 'has duplicate table ids')
  const reports = Array.isArray(data.reports) ? data.reports.map((r, i) => parseReport(r, i, tableIds)) : []
  const activeTableId =
    typeof data.activeTableId === 'string' && tableIds.has(data.activeTableId) ? data.activeTableId : (tables[0]?.id ?? null)
  const activeReportId =
    typeof data.activeReportId === 'string' && reports.some((r) => r.id === data.activeReportId) ? data.activeReportId : null
  return { tables, reports, activeTableId, activeReportId }
}

/** Parse .sift text, with friendly errors for files that aren't JSON. */
export function parseSessionText(text: string): Workspace {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new SessionError('This file is not a Sift session (it is not valid JSON).')
  }
  return parseSession(data)
}

// ----------------------------------------------------------------- files

function currentWorkspace(): Workspace {
  const { tables, reports, activeTableId, activeReportId } = useStore.getState()
  return { tables, reports, activeTableId, activeReportId }
}

export function sessionFileName(w: Workspace): string {
  const active = activeTableOf(w)
  return `${safeFileName(active?.name ?? 'session', 'session')}${SESSION_EXTENSION}`
}

/** Download the whole workspace (tables, row states, reports) as a .sift file. */
export function downloadSession(): void {
  const w = currentWorkspace()
  if (!w.tables.length) throw new Error('There is nothing to save yet.')
  const text = JSON.stringify(serializeWorkspace(w))
  saveBlob(new Blob([text], { type: 'application/json' }), sessionFileName(w))
}

/** Replace the workspace with a .sift file's contents. */
export async function openSessionFile(file: File): Promise<void> {
  const workspace = parseSessionText(await file.text())
  useStore.getState().replaceWorkspace(workspace)
}

// --------------------------------------------------------------- autosave

const DB_NAME = 'sift'
const STORE_NAME = 'autosave'
const KEY = 'workspace'
const AUTOSAVE_DELAY = 1500

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'))
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const request = run(tx.objectStore(STORE_NAME))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export interface AutosaveInfo {
  savedAt: Date
  tables: { name: string; nRows: number; nCols: number }[]
}

/** What the last autosave holds, without restoring it (null when there is none or it is unreadable). */
export async function readAutosave(): Promise<AutosaveInfo | null> {
  try {
    const data = await withStore<unknown>('readonly', (s) => s.get(KEY))
    if (!isObj(data) || data.format !== SESSION_FORMAT || !Array.isArray(data.tables) || !data.tables.length) return null
    return {
      savedAt: new Date(String(data.savedAt)),
      tables: (data.tables as SavedTable[]).map((t) => ({ name: t.name, nRows: t.nRows, nCols: t.columns.length })),
    }
  } catch {
    return null
  }
}

/** Restore the last autosave into the store. */
export async function restoreAutosave(): Promise<void> {
  const data = await withStore<unknown>('readonly', (s) => s.get(KEY))
  if (data === undefined) throw new SessionError('There is no saved session to resume.')
  useStore.getState().replaceWorkspace(parseSession(data))
}

export async function clearAutosave(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY))
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

async function writeAutosave(w: Workspace): Promise<void> {
  try {
    if (!w.tables.length) await withStore('readwrite', (s) => s.delete(KEY))
    else await withStore('readwrite', (s) => s.put(serializeWorkspace(w), KEY))
  } catch {
    // Storage may be unavailable, full or blocked (private windows); autosave is best effort.
  }
}

/** Start saving the workspace in the browser as it changes; returns a function that stops it. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    void writeAutosave(currentWorkspace())
  }
  const unsubscribe = useStore.subscribe((s, prev) => {
    const changed =
      s.tables !== prev.tables ||
      s.reports !== prev.reports ||
      s.activeTableId !== prev.activeTableId ||
      s.activeReportId !== prev.activeReportId
    if (!changed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void writeAutosave(currentWorkspace())
    }, AUTOSAVE_DELAY)
  })
  const onHide = () => flush()
  window.addEventListener('pagehide', onHide)
  const onVisibility = () => document.visibilityState === 'hidden' && flush()
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    unsubscribe()
    flush()
    window.removeEventListener('pagehide', onHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
