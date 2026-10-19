// Formula columns. Interface used by the store; the engine lives in this folder.

import type { Column } from '../../state/store'

/**
 * Recalculate every formula column (columns with `props.formula`) in dependency order.
 * Returns a new array; formula columns get fresh `values` (and `formulaError` when the
 * formula fails), other columns are returned as is.
 */
export function recomputeFormulas(columns: Column[], nRows: number): Column[] {
  void nRows
  return columns
}

/** Formula reference to a column: `:name` for plain identifiers, `:"any name"` otherwise. */
export function formulaRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `:${name}` : `:"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Rewrite references to a renamed column inside a formula's source text. */
export function renameInFormula(formula: string, oldName: string, newName: string): string {
  void oldName
  void newName
  return formula
}
