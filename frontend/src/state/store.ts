import { create } from 'zustand'
import type { DataTablePayload, DataType, DesignType, ModelingType, SpecLimits, Value } from '../api/types'
import { recomputeFormulas, renameInFormula } from '../lib/formula'
import { labelOf } from '../lib/levels'

// ------------------------------------------------------------------- data model

export interface ColumnProps {
  /** Value Order: display order of categorical levels. */
  valueOrder?: string[]
  specLimits?: SpecLimits
  /** Formula source; the column's values are computed from it. */
  formula?: string
}

export interface Column {
  /** Stable id; reports reference columns by id so renames don't break them. */
  id: string
  name: string
  dataType: DataType
  modelingType: ModelingType
  values: Value[]
  props: ColumnProps
  /** Set when the column's formula fails to parse or evaluate. */
  formulaError?: string
}

export interface TableModel {
  responses: string[] // column ids
  effects: string[][] // column ids; repeats are powers
}

export interface TableDoc {
  id: string
  name: string
  nRows: number
  columns: Column[]
  selected: Uint8Array
  excluded: Uint8Array
  nSelected: number
  nExcluded: number
  /** Model attached by DOE; Fit Model launches with it. */
  model?: TableModel
}

export type SelectMode = 'replace' | 'add' | 'toggle'

export type GBRole = 'x' | 'y' | 'overlay' | 'group_x' | 'group_y'
export type GBElement = 'points' | 'smoother' | 'line_of_fit' | 'line' | 'bar' | 'box' | 'histogram'

/** Option toggles per analysis inside a report, keyed by analysis key (e.g. "yId" or "yId|xId"). */
export type OptionsByAnalysis = Record<string, Record<string, boolean>>

export type ReportKind = 'distribution' | 'fit_y_by_x' | 'fit_model' | 'control_chart' | 'capability' | 'graph_builder'

/**
 * Every report has the same shape. `roles` maps a role ("y", "x", "factors", "subgroup",
 * "overlay", ...) to column ids; `params` holds platform settings (Fit Model effects as
 * column ids, chart type, spec limits, Graph Builder elements, ...).
 */
export interface ReportConfig {
  id: string
  tableId: string
  kind: ReportKind
  roles: Record<string, string[]>
  params: Record<string, unknown>
  options: OptionsByAnalysis
}

export type NewReport = Omit<ReportConfig, 'id' | 'tableId' | 'options' | 'params'> &
  Partial<Pick<ReportConfig, 'options' | 'params'>>

export interface NewColumn {
  name: string
  dataType: DataType
  modelingType: ModelingType
  values?: Value[]
  props?: ColumnProps
}

export interface ColumnPatch {
  name?: string
  dataType?: DataType
  modelingType?: ModelingType
  props?: ColumnProps
}

export interface Notice {
  text: string
  tone: 'info' | 'error'
}

/** The modal dialog currently open (at most one). */
export type Dialog =
  | { kind: 'distribution' }
  | { kind: 'fit_y_by_x' }
  | { kind: 'fit_model' }
  | { kind: 'control_chart' }
  | { kind: 'capability' }
  | { kind: 'doe'; design: DesignType }
  | { kind: 'new_column' }
  | { kind: 'column_info'; columnId: string }
  | { kind: 'add_rows' }
  | { kind: 'about' }

/** The parts of a table that undo / redo restore. */
type Snapshot = Pick<TableDoc, 'nRows' | 'columns' | 'selected' | 'excluded' | 'nSelected' | 'nExcluded'>

interface History {
  past: Snapshot[]
  future: Snapshot[]
}

const HISTORY_LIMIT = 100

interface State {
  tables: TableDoc[]
  activeTableId: string | null
  /** Column the Cols menu acts on (last clicked header or column name). */
  activeColumnId: string | null
  reports: ReportConfig[]
  activeReportId: string | null
  history: Record<string, History>
  notice: Notice | null
  dialog: Dialog | null

  // tables
  addTable: (payload: DataTablePayload) => string
  newTable: () => string
  closeTable: (id?: string) => void
  setActiveTable: (id: string) => void
  renameTable: (id: string, name: string) => void
  replaceWorkspace: (workspace: Workspace) => void

  // columns
  setActiveColumn: (id: string | null) => void
  setModelingType: (columnId: string, modelingType: ModelingType) => void
  updateColumn: (columnId: string, patch: ColumnPatch) => void
  addColumn: (column: NewColumn, index?: number) => string
  deleteColumns: (columnIds: string[]) => void

  // cells and rows
  setCell: (row: number, columnId: string, value: Value) => void
  setCells: (edits: { row: number; columnId: string; value: Value }[]) => void
  addRows: (count: number, at?: number) => void
  deleteRows: (rows?: number[]) => void
  undo: () => void
  redo: () => void

  // row states
  selectRows: (rows: Iterable<number>, mode?: SelectMode) => void
  selectRange: (from: number, to: number, additive: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  invertSelection: () => void
  toggleExcludeSelected: () => void
  clearRowStates: () => void

  // reports
  openReport: (report: NewReport) => void
  updateReport: (id: string, update: (report: ReportConfig) => ReportConfig) => void
  closeReport: (id: string) => void
  setActiveReport: (id: string) => void

  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: () => void
  openDialog: (dialog: Dialog) => void
  closeDialog: () => void
}

/** Everything a saved session restores. */
export interface Workspace {
  tables: TableDoc[]
  reports: ReportConfig[]
  activeTableId: string | null
  activeReportId: string | null
}

// ---------------------------------------------------------------------- helpers

export function uid(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`
}

function count(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

/** `name`, or `name 2`, `name 3`, ... if it is taken. */
export function uniqueName(name: string, taken: Iterable<string>, ignore?: string): string {
  const used = new Set([...taken].filter((n) => n !== ignore))
  const base = name.trim() || 'Column'
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}

/** Convert values when a column's data type changes. */
export function convertValues(values: Value[], to: DataType): Value[] {
  if (to === 'character') return values.map((v) => labelOf(v))
  return values.map((v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  })
}

function withFormulas(columns: Column[], nRows: number): Column[] {
  return columns.some((c) => c.props.formula) ? recomputeFormulas(columns, nRows) : columns
}

function fromPayload(payload: DataTablePayload): TableDoc {
  const columns: Column[] = payload.columns.map((c) => ({
    id: uid('c'),
    name: c.name,
    dataType: c.data_type,
    modelingType: c.modeling_type,
    values: c.values,
    props: {
      ...(c.value_order ? { valueOrder: c.value_order } : {}),
      ...(c.spec_limits ? { specLimits: c.spec_limits } : {}),
    },
  }))
  const idOf = new Map(columns.map((c) => [c.name, c.id]))
  const ids = (names: string[]) => names.map((n) => idOf.get(n)).filter((id): id is string => !!id)
  const model = payload.model
    ? { responses: ids(payload.model.responses), effects: payload.model.effects.map(ids).filter((e) => e.length > 0) }
    : undefined
  return {
    id: uid('t'),
    name: payload.name,
    nRows: payload.n_rows,
    columns,
    selected: new Uint8Array(payload.n_rows),
    excluded: new Uint8Array(payload.n_rows),
    nSelected: 0,
    nExcluded: 0,
    model,
  }
}

function snapshot(t: TableDoc): Snapshot {
  return { nRows: t.nRows, columns: t.columns, selected: t.selected, excluded: t.excluded, nSelected: t.nSelected, nExcluded: t.nExcluded }
}

export function activeTableOf(s: Pick<State, 'tables' | 'activeTableId'>): TableDoc | null {
  return s.tables.find((t) => t.id === s.activeTableId) ?? null
}

// ------------------------------------------------------------------------ store

export const useStore = create<State>()((set, get) => {
  /** Replace the active table with `update(table)`; optionally record undo history. */
  const patchActive = (update: (t: TableDoc) => TableDoc | null, record = false) => {
    const s = get()
    const table = activeTableOf(s)
    if (!table) return
    const next = update(table)
    if (!next || next === table) return
    const changes: Partial<State> = { tables: s.tables.map((t) => (t.id === table.id ? next : t)) }
    if (record) {
      const h = s.history[table.id] ?? { past: [], future: [] }
      changes.history = { ...s.history, [table.id]: { past: [...h.past, snapshot(table)].slice(-HISTORY_LIMIT), future: [] } }
    }
    set(changes)
  }

  /** Data edit: new columns / rows, formulas recomputed, undo history recorded. */
  const editActive = (update: (t: TableDoc) => Partial<TableDoc> | null) =>
    patchActive((t) => {
      const changes = update(t)
      if (!changes) return null
      const next = { ...t, ...changes }
      return { ...next, columns: withFormulas(next.columns, next.nRows) }
    }, true)

  const setMasks = (t: TableDoc, selected: Uint8Array, excluded = t.excluded): TableDoc => ({
    ...t,
    selected,
    excluded,
    nSelected: count(selected),
    nExcluded: excluded === t.excluded ? t.nExcluded : count(excluded),
  })

  const addTableDoc = (table: TableDoc) => {
    set((s) => ({ tables: [...s.tables, table], activeTableId: table.id, activeColumnId: null, activeReportId: null }))
    return table.id
  }

  return {
    tables: [],
    activeTableId: null,
    activeColumnId: null,
    reports: [],
    activeReportId: null,
    history: {},
    notice: null,
    dialog: null,

    // ------------------------------------------------------------------ tables

    addTable: (payload) => {
      const table = fromPayload(payload)
      return addTableDoc({ ...table, columns: withFormulas(table.columns, table.nRows) })
    },

    newTable: () => {
      const taken = get().tables.map((t) => t.name)
      return addTableDoc({
        id: uid('t'),
        name: uniqueName('Untitled', taken),
        nRows: 0,
        columns: [{ id: uid('c'), name: 'Column 1', dataType: 'numeric', modelingType: 'continuous', values: [], props: {} }],
        selected: new Uint8Array(0),
        excluded: new Uint8Array(0),
        nSelected: 0,
        nExcluded: 0,
      })
    },

    closeTable: (id) =>
      set((s) => {
        const target = id ?? s.activeTableId
        const index = s.tables.findIndex((t) => t.id === target)
        if (index < 0) return {}
        const tables = s.tables.filter((t) => t.id !== target)
        const reports = s.reports.filter((r) => r.tableId !== target)
        const history = { ...s.history }
        delete history[target!]
        const activeTableId = s.activeTableId === target ? (tables[Math.min(index, tables.length - 1)]?.id ?? null) : s.activeTableId
        const activeReportId = reports.some((r) => r.id === s.activeReportId)
          ? s.activeReportId
          : (reports.find((r) => r.tableId === activeTableId)?.id ?? null)
        return { tables, reports, history, activeTableId, activeReportId, activeColumnId: null }
      }),

    setActiveTable: (id) =>
      set((s) => ({
        activeTableId: id,
        activeColumnId: null,
        activeReportId: s.reports.find((r) => r.tableId === id && r.id === s.activeReportId)?.id ?? s.reports.find((r) => r.tableId === id)?.id ?? null,
      })),

    renameTable: (id, name) =>
      set((s) => ({
        tables: s.tables.map((t) => (t.id === id ? { ...t, name: uniqueName(name, s.tables.map((o) => o.name), t.name) } : t)),
      })),

    replaceWorkspace: (w) =>
      set({ tables: w.tables, reports: w.reports, activeTableId: w.activeTableId, activeReportId: w.activeReportId, activeColumnId: null, history: {} }),

    // ----------------------------------------------------------------- columns

    setActiveColumn: (id) => set({ activeColumnId: id }),

    setModelingType: (columnId, modelingType) => get().updateColumn(columnId, { modelingType }),

    updateColumn: (columnId, patch) =>
      editActive((t) => {
        const column = t.columns.find((c) => c.id === columnId)
        if (!column) return null
        const name = patch.name !== undefined ? uniqueName(patch.name, t.columns.map((c) => c.name), column.name) : column.name
        const dataType = patch.dataType ?? column.dataType
        let modelingType = patch.modelingType ?? column.modelingType
        if (dataType === 'character' && modelingType === 'continuous') modelingType = 'nominal'
        const values = dataType !== column.dataType ? convertValues(column.values, dataType) : column.values
        const props = patch.props ?? column.props
        const renamed = name !== column.name
        const columns = t.columns.map((c) => {
          if (c.id === columnId) return { ...c, name, dataType, modelingType, values, props, formulaError: undefined }
          // Keep other formulas pointing at the renamed column.
          if (renamed && c.props.formula) return { ...c, props: { ...c.props, formula: renameInFormula(c.props.formula, column.name, name) } }
          return c
        })
        return { columns }
      }),

    addColumn: (spec, index) => {
      const id = uid('c')
      editActive((t) => {
        const values = spec.values ? spec.values.slice(0, t.nRows) : []
        while (values.length < t.nRows) values.push(null)
        const column: Column = {
          id,
          name: uniqueName(spec.name, t.columns.map((c) => c.name)),
          dataType: spec.dataType,
          modelingType: spec.dataType === 'character' && spec.modelingType === 'continuous' ? 'nominal' : spec.modelingType,
          values: convertValues(values, spec.dataType),
          props: spec.props ?? {},
        }
        const columns = [...t.columns]
        columns.splice(index ?? columns.length, 0, column)
        return { columns }
      })
      return id
    },

    deleteColumns: (columnIds) => {
      const drop = new Set(columnIds)
      editActive((t) => (t.columns.some((c) => drop.has(c.id)) ? { columns: t.columns.filter((c) => !drop.has(c.id)) } : null))
      if (drop.has(get().activeColumnId ?? '')) set({ activeColumnId: null })
    },

    // ------------------------------------------------------------ cells and rows

    setCell: (row, columnId, value) => get().setCells([{ row, columnId, value }]),

    setCells: (edits) =>
      editActive((t) => {
        const byColumn = new Map<string, { row: number; value: Value }[]>()
        for (const e of edits) {
          if (e.row < 0 || e.row >= t.nRows) continue
          const list = byColumn.get(e.columnId) ?? []
          list.push(e)
          byColumn.set(e.columnId, list)
        }
        if (byColumn.size === 0) return null
        const columns = t.columns.map((c) => {
          const list = byColumn.get(c.id)
          if (!list || c.props.formula) return c
          const values = c.values.slice()
          for (const { row, value } of list) values[row] = convertValues([value], c.dataType)[0]
          return { ...c, values }
        })
        return { columns }
      }),

    addRows: (n, at) =>
      editActive((t) => {
        if (n <= 0) return null
        const pos = Math.max(0, Math.min(at ?? t.nRows, t.nRows))
        const insert = <T,>(arr: ArrayLike<T>, filler: T): T[] => {
          const out = Array.from(arr)
          out.splice(pos, 0, ...Array<T>(n).fill(filler))
          return out
        }
        const selected = Uint8Array.from(insert(t.selected, 0))
        const excluded = Uint8Array.from(insert(t.excluded, 0))
        return {
          nRows: t.nRows + n,
          columns: t.columns.map((c) => ({ ...c, values: insert<Value>(c.values, null) })),
          selected,
          excluded,
          nSelected: count(selected),
          nExcluded: count(excluded),
        }
      }),

    deleteRows: (rows) =>
      editActive((t) => {
        const drop = new Uint8Array(t.nRows)
        if (rows) for (const r of rows) drop[r] = 1
        else drop.set(t.selected)
        if (!drop.some((d) => d)) return null
        const keep = (_: unknown, i: number) => !drop[i]
        const selected = t.selected.filter(keep)
        const excluded = t.excluded.filter(keep)
        return {
          nRows: selected.length,
          columns: t.columns.map((c) => ({ ...c, values: c.values.filter(keep) })),
          selected,
          excluded,
          nSelected: count(selected),
          nExcluded: count(excluded),
        }
      }),

    undo: () => {
      const s = get()
      const table = activeTableOf(s)
      const h = table && s.history[table.id]
      if (!table || !h || h.past.length === 0) return
      const previous = h.past[h.past.length - 1]
      set({
        tables: s.tables.map((t) => (t.id === table.id ? { ...t, ...previous } : t)),
        history: { ...s.history, [table.id]: { past: h.past.slice(0, -1), future: [snapshot(table), ...h.future] } },
      })
    },

    redo: () => {
      const s = get()
      const table = activeTableOf(s)
      const h = table && s.history[table.id]
      if (!table || !h || h.future.length === 0) return
      const [next, ...future] = h.future
      set({
        tables: s.tables.map((t) => (t.id === table.id ? { ...t, ...next } : t)),
        history: { ...s.history, [table.id]: { past: [...h.past, snapshot(table)], future } },
      })
    },

    // -------------------------------------------------------------- row states

    selectRows: (rows, mode = 'replace') =>
      patchActive((t) => {
        const next = mode === 'replace' ? new Uint8Array(t.nRows) : t.selected.slice()
        for (const r of rows) {
          if (r < 0 || r >= next.length) continue
          next[r] = mode === 'toggle' ? (next[r] ? 0 : 1) : 1
        }
        return setMasks(t, next)
      }),

    selectRange: (from, to, additive) =>
      patchActive((t) => {
        const next = additive ? t.selected.slice() : new Uint8Array(t.nRows)
        const [a, b] = from <= to ? [from, to] : [to, from]
        for (let r = Math.max(0, a); r <= Math.min(next.length - 1, b); r++) next[r] = 1
        return setMasks(t, next)
      }),

    clearSelection: () => patchActive((t) => (t.nSelected === 0 ? null : setMasks(t, new Uint8Array(t.nRows)))),

    selectAll: () => patchActive((t) => setMasks(t, new Uint8Array(t.nRows).fill(1))),

    invertSelection: () => patchActive((t) => setMasks(t, t.selected.map((v) => (v ? 0 : 1)))),

    // Like JMP's Exclude/Unexclude: unexclude when every selected row is already excluded.
    toggleExcludeSelected: () =>
      patchActive((t) => {
        if (t.nSelected === 0) return null
        let allExcluded = true
        for (let i = 0; i < t.nRows; i++) {
          if (t.selected[i] && !t.excluded[i]) {
            allExcluded = false
            break
          }
        }
        const next = t.excluded.slice()
        for (let i = 0; i < t.nRows; i++) if (t.selected[i]) next[i] = allExcluded ? 0 : 1
        return setMasks(t, t.selected, next)
      }),

    clearRowStates: () => patchActive((t) => setMasks(t, new Uint8Array(t.nRows), new Uint8Array(t.nRows))),

    // ----------------------------------------------------------------- reports

    openReport: (report) => {
      const tableId = get().activeTableId
      if (!tableId) return
      const id = uid('r')
      const full: ReportConfig = { params: {}, options: {}, ...report, id, tableId }
      set((s) => ({ reports: [...s.reports, full], activeReportId: id }))
    },

    updateReport: (id, update) => set((s) => ({ reports: s.reports.map((r) => (r.id === id ? update(r) : r)) })),

    closeReport: (id) =>
      set((s) => {
        const closing = s.reports.find((r) => r.id === id)
        const reports = s.reports.filter((r) => r.id !== id)
        let activeReportId = s.activeReportId
        if (activeReportId === id) {
          const siblings = reports.filter((r) => r.tableId === closing?.tableId)
          activeReportId = siblings[siblings.length - 1]?.id ?? null
        }
        return { reports, activeReportId }
      }),

    setActiveReport: (id) => set({ activeReportId: id }),

    notify: (text, tone = 'info') => set({ notice: { text, tone } }),
    dismissNotice: () => set({ notice: null }),
    openDialog: (dialog) => set({ dialog }),
    closeDialog: () => set({ dialog: null }),
  }
})

// ------------------------------------------------------------------------ hooks

const EMPTY_MASK = new Uint8Array(0)

export const useActiveTable = () => useStore(activeTableOf)
export const useSelected = () => useStore((s) => activeTableOf(s)?.selected ?? EMPTY_MASK)
export const useNSelected = () => useStore((s) => activeTableOf(s)?.nSelected ?? 0)
export const useExcluded = () => useStore((s) => activeTableOf(s)?.excluded ?? EMPTY_MASK)

/** Reports belonging to the active table. */
export function useTableReports(): ReportConfig[] {
  const reports = useStore((s) => s.reports)
  const tableId = useStore((s) => s.activeTableId)
  return reports.filter((r) => r.tableId === tableId)
}

export function canUndo(s: State): boolean {
  return !!s.activeTableId && (s.history[s.activeTableId]?.past.length ?? 0) > 0
}

export function canRedo(s: State): boolean {
  return !!s.activeTableId && (s.history[s.activeTableId]?.future.length ?? 0) > 0
}

export function findColumn(table: TableDoc | null | undefined, id: string): Column | undefined {
  return table?.columns.find((c) => c.id === id)
}

export function findColumnByName(table: TableDoc | null | undefined, name: string): Column | undefined {
  return table?.columns.find((c) => c.name === name)
}

export function isCategorical(modelingType: ModelingType): boolean {
  return modelingType !== 'continuous'
}

/** Indices of rows that are not excluded. */
export function includedRows(excluded: Uint8Array): number[] {
  const rows: number[] = []
  for (let i = 0; i < excluded.length; i++) if (!excluded[i]) rows.push(i)
  return rows
}
