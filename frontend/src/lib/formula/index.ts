// Formula columns: the interface used by the store and the formula editor.
// Syntax: docs/formula-language.md.

import type { DataType, Value } from '../../api/types'
import type { Column } from '../../state/store'
import { compile, hashString, toText } from './engine'
import { FormulaError, parse, referencedColumns, tokenize, type Node } from './parse'

export { FUNCTIONS, type FunctionCategory, type FunctionInfo } from './engine'
export { FormulaError } from './parse'

const hasFormula = (c: Column) => !!c.props.formula?.trim()

/** Formula reference to a column: `:name` for plain identifiers, `:"any name"` otherwise. */
export function formulaRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `:${name}` : `:"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Rewrite references to a renamed column inside a formula's source text. */
export function renameInFormula(formula: string, oldName: string, newName: string): string {
  let out = ''
  let last = 0
  for (const t of tokenize(formula)) {
    if (t.type === 'ref' && t.name === oldName) {
      out += formula.slice(last, t.start) + formulaRef(newName)
      last = t.end
    }
  }
  return last === 0 ? formula : out + formula.slice(last)
}

/** Evaluate an AST for every row, normalizing empty strings to missing. */
function evaluateAll(ast: Node, source: string, nRows: number, column: (name: string) => Value[] | undefined): Value[] {
  const fn = compile(ast, { nRows, column, seed: hashString(source) })
  const out: Value[] = new Array(nRows)
  for (let r = 0; r < nRows; r++) {
    const v = fn(r)
    out[r] = v === '' ? null : v
  }
  return out
}

/** Numeric when every non-missing result is a number, character otherwise (numbers become text). */
function typed(values: Value[]): { values: Value[]; dataType: DataType } {
  if (values.some((v) => typeof v === 'string')) return { values: values.map((v) => (typeof v === 'number' ? toText(v) : v)), dataType: 'character' }
  return { values, dataType: 'numeric' }
}

function sameValues(a: Value[], b: Value[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Evaluate a formula against a table's columns (for tests and previews). Throws FormulaError. */
export function evaluateFormula(source: string, columns: Column[], nRows: number): Value[] {
  const byName = new Map(columns.map((c) => [c.name, c.values]))
  return typed(evaluateAll(parse(source), source, nRows, (name) => byName.get(name))).values
}

/**
 * Recalculate every formula column (columns with `props.formula`) in dependency order.
 * Returns a new array; formula columns get fresh `values` (and `formulaError` when the
 * formula fails), other columns are returned as is. Columns whose output did not change
 * keep their identity.
 */
export function recomputeFormulas(columns: Column[], nRows: number): Column[] {
  const formulas = columns.filter(hasFormula)
  if (formulas.length === 0) return columns
  const byName = new Map(columns.map((c) => [c.name, c]))

  // Parse every formula and find which formula columns it depends on.
  const parsed = new Map<string, { ast?: Node; error?: string; deps: string[] }>()
  for (const c of formulas) {
    try {
      const ast = parse(c.props.formula!)
      const deps = [...referencedColumns(ast)].filter((n) => byName.has(n) && hasFormula(byName.get(n)!))
      parsed.set(c.name, { ast, deps })
    } catch (e) {
      parsed.set(c.name, { error: errorText(e, c.props.formula!), deps: [] })
    }
  }

  // Depth-first search gives an evaluation order and finds cycles.
  const errors = new Map<string, string>()
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (name: string) => {
    state.set(name, 'visiting')
    stack.push(name)
    for (const dep of parsed.get(name)!.deps) {
      const s = state.get(dep)
      if (s === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep]
        const message = `Circular reference: ${cycle.join(' → ')}`
        for (const n of cycle) if (!errors.has(n)) errors.set(n, message)
      } else if (!s) visit(dep)
    }
    stack.pop()
    state.set(name, 'done')
    order.push(name)
  }
  for (const c of formulas) if (!state.has(c.name)) visit(c.name)

  // Evaluate in order; later formulas see earlier results.
  const current = new Map(columns.map((c) => [c.name, c.values]))
  const results = new Map<string, Column>()
  for (const name of order) {
    const column = byName.get(name)!
    const p = parsed.get(name)!
    let error = errors.get(name) ?? p.error
    let values: Value[] = new Array(nRows).fill(null)
    let dataType = column.dataType
    if (!error) {
      try {
        const out = typed(evaluateAll(p.ast!, column.props.formula!, nRows, (n) => current.get(n)))
        values = out.values
        dataType = out.dataType
      } catch (e) {
        error = errorText(e, column.props.formula!)
      }
    }
    const modelingType = dataType === 'character' && column.modelingType === 'continuous' ? 'nominal' : column.modelingType
    const unchanged =
      column.dataType === dataType && column.modelingType === modelingType && column.formulaError === error && sameValues(column.values, values)
    const next = unchanged ? column : { ...column, values, dataType, modelingType, formulaError: error }
    current.set(name, next.values)
    results.set(column.id, next)
  }

  let changed = false
  const out = columns.map((c) => {
    const r = results.get(c.id) ?? c
    if (r !== c) changed = true
    return r
  })
  return changed ? out : columns
}

/** Message for a formula error, with the position as "line:column" when it helps. */
function errorText(e: unknown, source: string): string {
  if (!(e instanceof FormulaError)) return (e as Error).message
  if (e.position === undefined) return e.message
  return `${e.message} (at ${positionLabel(source, e.position)})`
}

/** "character 5" for one-line formulas, "line 2, column 5" otherwise. */
export function positionLabel(source: string, position: number): string {
  const before = source.slice(0, position)
  const line = before.split('\n').length
  const column = position - before.lastIndexOf('\n')
  return source.includes('\n') ? `line ${line}, column ${column}` : `character ${column}`
}

export interface FormulaCheck {
  /** True when the source is blank. */
  empty?: boolean
  error?: { message: string; position?: number }
  /** Values for the first rows. */
  preview: Value[]
  dataType: DataType
  nMissing: number
}

const PREVIEW_ROWS = 8

/**
 * Validate a formula for the editor: parse, check references (including circular ones
 * through other formula columns), and compute a preview. `selfId` is the column whose
 * formula this is, if it already exists.
 */
export function checkFormula(source: string, columns: Column[], nRows: number, selfId?: string): FormulaCheck {
  const none: FormulaCheck = { preview: [], dataType: 'numeric', nMissing: 0 }
  if (!source.trim()) return { ...none, empty: true }
  let ast: Node
  try {
    ast = parse(source)
  } catch (e) {
    const err = e as FormulaError
    return { ...none, error: { message: err.message, position: err.position } }
  }

  const self = columns.find((c) => c.id === selfId)
  const others = columns.filter((c) => c.id !== selfId)
  if (self) {
    const selfRef = findRef(ast, self.name)
    if (selfRef) return { ...none, error: { message: `A formula can't refer to its own column (${formulaRef(self.name)})`, position: selfRef.pos } }
    const cycle = cyclePath(ast, self.name, others)
    if (cycle) return { ...none, error: { message: `Circular reference: ${cycle.join(' → ')}` } }
  }

  const byName = new Map(others.map((c) => [c.name, c.values]))
  try {
    const { values, dataType } = typed(evaluateAll(ast, source, nRows, (n) => byName.get(n)))
    return { preview: values.slice(0, PREVIEW_ROWS), dataType, nMissing: values.filter((v) => v === null).length }
  } catch (e) {
    const err = e as FormulaError
    return { ...none, error: { message: err.message, position: err.position } }
  }
}

function findRef(ast: Node, name: string): Extract<Node, { kind: 'ref' }> | undefined {
  switch (ast.kind) {
    case 'ref':
      return ast.name === name ? ast : undefined
    case 'unary':
      return findRef(ast.arg, name)
    case 'binary':
      return findRef(ast.left, name) ?? findRef(ast.right, name)
    case 'call':
      for (const a of ast.args) {
        const found = findRef(a, name)
        if (found) return found
      }
      return undefined
    default:
      return undefined
  }
}

/** Path self → ... → self through other formula columns, if the new formula would close a loop. */
function cyclePath(ast: Node, selfName: string, others: Column[]): string[] | null {
  const byName = new Map(others.map((c) => [c.name, c]))
  const seen = new Set<string>()
  const walk = (names: Iterable<string>, path: string[]): string[] | null => {
    for (const name of names) {
      if (name === selfName) return [...path, name]
      const col = byName.get(name)
      if (!col || !hasFormula(col) || seen.has(name)) continue
      seen.add(name)
      let deps: Set<string>
      try {
        deps = referencedColumns(parse(col.props.formula!))
      } catch {
        continue
      }
      const found = walk(deps, [...path, name])
      if (found) return found
    }
    return null
  }
  return walk(referencedColumns(ast), [selfName])
}
