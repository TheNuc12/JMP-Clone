// Model-effect construction for the Fit Model dialog. Effects are lists of column ids;
// a repeated continuous column is a power (["x", "x"] is x squared).

import type { Column } from '../../state/store'
import { isCategorical } from '../../state/store'

export type Effect = string[]

/** Order-insensitive identity, so x*g and g*x are the same effect. */
export function effectKey(effect: Effect): string {
  return [...effect].sort().join('\u0000')
}

/** Append effects that are not already present. */
export function addEffects(current: Effect[], added: Effect[]): Effect[] {
  const seen = new Set(current.map(effectKey))
  const out = [...current]
  for (const e of added) {
    const key = effectKey(e)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/** A categorical column may appear only once in an effect (only continuous columns have powers). */
export function isValidEffect(effect: Effect, byId: Map<string, Column>): boolean {
  const seen = new Set<string>()
  for (const id of effect) {
    const c = byId.get(id)
    if (!c) return false
    if (seen.has(id) && isCategorical(c.modelingType)) return false
    seen.add(id)
  }
  return true
}

/**
 * JMP's Cross button: selected effects crossed with selected columns; otherwise the
 * selected columns crossed together, or the selected effects crossed together.
 */
export function crossEffects(columns: string[], effects: Effect[]): Effect[] {
  if (effects.length && columns.length) return effects.flatMap((e) => columns.map((c) => [...e, c]))
  if (columns.length >= 2) return [columns]
  if (effects.length >= 2) return [effects.flat()]
  return []
}

function subsets(ids: string[], maxSize: number): Effect[] {
  const out: Effect[] = []
  const rec = (start: number, acc: string[]) => {
    for (let i = start; i < ids.length; i++) {
      const next = [...acc, ids[i]]
      out.push(next)
      if (next.length < maxSize) rec(i + 1, next)
    }
  }
  rec(0, [])
  return out.sort((a, b) => a.length - b.length)
}

export type Macro = 'full_factorial' | 'factorial_2' | 'response_surface' | 'polynomial_2'

export const MACRO_LABELS: Record<Macro, string> = {
  full_factorial: 'Full Factorial',
  factorial_2: 'Factorial to Degree 2',
  response_surface: 'Response Surface',
  polynomial_2: 'Polynomial to Degree 2',
}

/** Effects a macro generates from the selected columns. */
export function macroEffects(macro: Macro, ids: string[], byId: Map<string, Column>): Effect[] {
  const continuous = ids.filter((id) => byId.get(id) && !isCategorical(byId.get(id)!.modelingType))
  const squares = continuous.map((id) => [id, id])
  switch (macro) {
    case 'full_factorial':
      return subsets(ids, ids.length)
    case 'factorial_2':
      return subsets(ids, 2)
    case 'response_surface':
      return [...subsets(ids, 2), ...squares]
    case 'polynomial_2':
      return [...ids.map((id) => [id]), ...squares]
  }
}

/** Display name: column names joined with "*". */
export function effectName(effect: Effect, byId: Map<string, Column>): string {
  return effect.map((id) => byId.get(id)?.name ?? '?').join('*')
}
