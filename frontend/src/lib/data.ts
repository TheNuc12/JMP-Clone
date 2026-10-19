import type { AnalysisColumn } from '../api/types'
import type { Column } from '../state/store'
import { isCategorical } from '../state/store'
import { labelOf } from './levels'

export function numberAt(column: Column, row: number): number | null {
  const v = column.values[row]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function labelAt(column: Column, row: number): string | null {
  return labelOf(column.values[row])
}

/** Column values for the given rows in the shape the analysis API expects. */
export function toAnalysisColumn(column: Column, rows: number[]): AnalysisColumn {
  const categorical = isCategorical(column.modelingType)
  return {
    name: column.name,
    modeling_type: column.modelingType,
    values: rows.map((r) => (categorical ? labelAt(column, r) : numberAt(column, r))),
    levels: categorical ? (column.props.valueOrder ?? null) : null,
  }
}

/** Rows (from `rows`) where every given column has a usable value for its modeling type. */
export function completeRows(rows: number[], columns: Column[]): number[] {
  return rows.filter((r) =>
    columns.every((c) => (isCategorical(c.modelingType) ? labelAt(c, r) !== null : numberAt(c, r) !== null)),
  )
}

/** Group rows by the label of a categorical column. */
export function groupRows(rows: number[], column: Column): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (const r of rows) {
    const label = labelAt(column, r)
    if (label === null) continue
    let list = groups.get(label)
    if (!list) groups.set(label, (list = []))
    list.push(r)
  }
  return groups
}

/** Indices (within `rows`) of selected rows for Plotly's selectedpoints, or null when nothing is selected. */
export function selectedPoints(rows: number[], selected: Uint8Array, nSelected: number): number[] | null {
  if (nSelected === 0) return null
  const points: number[] = []
  for (let i = 0; i < rows.length; i++) if (selected[rows[i]]) points.push(i)
  return points
}
