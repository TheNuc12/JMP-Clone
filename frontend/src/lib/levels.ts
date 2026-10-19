import type { Value } from '../api/types'

/** Label used for a categorical value. Both the analysis requests and the plots use it. */
export function labelOf(value: Value): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  return value
}

/**
 * Distinct labels in display order: numeric order when every label is a number,
 * otherwise plain string order. Matches `levels_of` in the backend.
 */
export function levelsOf(labels: Iterable<string | null>): string[] {
  const unique = new Set<string>()
  for (const label of labels) if (label !== null) unique.add(label)
  const levels = [...unique]
  const allNumeric = levels.length > 0 && levels.every((l) => l.trim() !== '' && Number.isFinite(Number(l)))
  if (allNumeric) return levels.sort((a, b) => Number(a) - Number(b))
  return levels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
