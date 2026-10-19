import { create } from 'zustand'
import type { DataTablePayload, DataType, ModelingType, Value } from '../api/types'

export interface Column {
  name: string
  dataType: DataType
  modelingType: ModelingType
  values: Value[]
}

export interface Table {
  name: string
  nRows: number
  columns: Column[]
}

export type SelectMode = 'replace' | 'add' | 'toggle'

export type GBRole = 'x' | 'y' | 'overlay'
export type GBElement = 'points' | 'smoother' | 'line_of_fit' | 'line' | 'bar' | 'box' | 'histogram'

/** Option toggles per analysis inside a report, keyed by analysis key ("y" or "y|x"). */
export type OptionsByAnalysis = Record<string, Record<string, boolean>>

export type ReportConfig =
  | { id: string; kind: 'distribution'; y: string[]; options: OptionsByAnalysis }
  | { id: string; kind: 'fit_y_by_x'; y: string[]; x: string[]; options: OptionsByAnalysis }
  | { id: string; kind: 'graph_builder'; roles: Partial<Record<GBRole, string>>; elements: GBElement[] }

export type NewReport = ReportConfig extends infer R ? (R extends ReportConfig ? Omit<R, 'id'> : never) : never

export interface Notice {
  text: string
  tone: 'info' | 'error'
}

interface State {
  table: Table | null
  selected: Uint8Array
  excluded: Uint8Array
  nSelected: number
  nExcluded: number
  reports: ReportConfig[]
  activeReportId: string | null
  notice: Notice | null

  loadTable: (payload: DataTablePayload) => void
  closeTable: () => void
  setModelingType: (column: string, modelingType: ModelingType) => void

  selectRows: (rows: Iterable<number>, mode?: SelectMode) => void
  selectRange: (from: number, to: number, additive: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  invertSelection: () => void
  toggleExcludeSelected: () => void
  clearRowStates: () => void

  openReport: (report: NewReport) => void
  updateReport: (id: string, update: (report: ReportConfig) => ReportConfig) => void
  closeReport: (id: string) => void
  setActiveReport: (id: string) => void

  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: () => void
}

let nextReportId = 1

function count(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

export const useStore = create<State>()((set, get) => ({
  table: null,
  selected: new Uint8Array(0),
  excluded: new Uint8Array(0),
  nSelected: 0,
  nExcluded: 0,
  reports: [],
  activeReportId: null,
  notice: null,

  loadTable: (payload) =>
    set({
      table: {
        name: payload.name,
        nRows: payload.n_rows,
        columns: payload.columns.map((c) => ({
          name: c.name,
          dataType: c.data_type,
          modelingType: c.modeling_type,
          values: c.values,
        })),
      },
      selected: new Uint8Array(payload.n_rows),
      excluded: new Uint8Array(payload.n_rows),
      nSelected: 0,
      nExcluded: 0,
      reports: [],
      activeReportId: null,
    }),

  closeTable: () =>
    set({
      table: null,
      selected: new Uint8Array(0),
      excluded: new Uint8Array(0),
      nSelected: 0,
      nExcluded: 0,
      reports: [],
      activeReportId: null,
    }),

  setModelingType: (column, modelingType) => {
    const table = get().table
    if (!table) return
    set({
      table: {
        ...table,
        columns: table.columns.map((c) => (c.name === column ? { ...c, modelingType } : c)),
      },
    })
  },

  selectRows: (rows, mode = 'replace') => {
    const { selected } = get()
    const next = mode === 'replace' ? new Uint8Array(selected.length) : selected.slice()
    for (const r of rows) {
      if (r < 0 || r >= next.length) continue
      next[r] = mode === 'toggle' ? (next[r] ? 0 : 1) : 1
    }
    set({ selected: next, nSelected: count(next) })
  },

  selectRange: (from, to, additive) => {
    const { selected } = get()
    const next = additive ? selected.slice() : new Uint8Array(selected.length)
    const [a, b] = from <= to ? [from, to] : [to, from]
    for (let r = Math.max(0, a); r <= Math.min(next.length - 1, b); r++) next[r] = 1
    set({ selected: next, nSelected: count(next) })
  },

  clearSelection: () => {
    if (get().nSelected === 0) return
    set({ selected: new Uint8Array(get().selected.length), nSelected: 0 })
  },

  selectAll: () => {
    const next = new Uint8Array(get().selected.length).fill(1)
    set({ selected: next, nSelected: next.length })
  },

  invertSelection: () => {
    const next = get().selected.map((v) => (v ? 0 : 1))
    set({ selected: next, nSelected: count(next) })
  },

  // Like JMP's Exclude/Unexclude: unexclude when every selected row is already excluded.
  toggleExcludeSelected: () => {
    const { selected, excluded, nSelected } = get()
    if (nSelected === 0) return
    let allExcluded = true
    for (let i = 0; i < selected.length; i++) {
      if (selected[i] && !excluded[i]) {
        allExcluded = false
        break
      }
    }
    const next = excluded.slice()
    for (let i = 0; i < selected.length; i++) if (selected[i]) next[i] = allExcluded ? 0 : 1
    set({ excluded: next, nExcluded: count(next) })
  },

  clearRowStates: () => {
    const n = get().selected.length
    set({ selected: new Uint8Array(n), excluded: new Uint8Array(n), nSelected: 0, nExcluded: 0 })
  },

  openReport: (report) => {
    const id = `r${nextReportId++}`
    set((s) => ({ reports: [...s.reports, { ...report, id } as ReportConfig], activeReportId: id }))
  },

  updateReport: (id, update) =>
    set((s) => ({ reports: s.reports.map((r) => (r.id === id ? update(r) : r)) })),

  closeReport: (id) =>
    set((s) => {
      const index = s.reports.findIndex((r) => r.id === id)
      const reports = s.reports.filter((r) => r.id !== id)
      let activeReportId = s.activeReportId
      if (activeReportId === id) {
        activeReportId = reports.length ? reports[Math.min(index, reports.length - 1)].id : null
      }
      return { reports, activeReportId }
    }),

  setActiveReport: (id) => set({ activeReportId: id }),

  notify: (text, tone = 'info') => set({ notice: { text, tone } }),
  dismissNotice: () => set({ notice: null }),
}))

export function findColumn(table: Table | null, name: string): Column | undefined {
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
