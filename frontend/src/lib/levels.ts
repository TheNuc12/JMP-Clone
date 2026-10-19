import type { Value } from '../api/types'

/** Label used for a categorical value. Both the analysis requests and the plots use it. */
export function labelOf(value: Value): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  return value
}

/**
 * Distinct labels in display order. Labels named in `order` (the Value Order column
 * property) come first, in that order; the rest follow in numeric order when every one
 * is a number, otherwise in plain string order. Matches `levels_of` in the backend.
 */
export function levelsOf(labels: Iterable<string | null>, order?: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const label of labels) if (label !== null) unique.add(label)
  const ordered = [...new Set(order ?? [])].filter((l) => unique.has(l))
  for (const l of ordered) unique.delete(l)
  const rest = [...unique]
  const allNumeric = rest.length > 0 && rest.every((l) => l.trim() !== '' && Number.isFinite(Number(l)))
  if (allNumeric) rest.sort((a, b) => Number(a) - Number(b))
  else rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return [...ordered, ...rest]
}
