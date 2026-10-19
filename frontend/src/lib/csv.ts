import type { TableDoc } from '../state/store'

/** Download a table as CSV. */
export function downloadTableCsv(table: TableDoc): void {
  void table
  throw new Error('CSV export is not implemented yet.')
}
