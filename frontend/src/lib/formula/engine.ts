// Compiles formula ASTs into per-row evaluators.

import type { Value } from '../../api/types'
import { FormulaError, functionKey, type Node } from './parse'

/** Evaluates a compiled expression for one row (0-based). */
export type Fn = (row: number) => Value

export interface CompileContext {
  nRows: number
  /** Current values of a column, or undefined if there is no such column. */
  column: (name: string) => Value[] | undefined
  /** Seed for Random functions, derived from the formula source. */
  seed: number
}

export type FunctionCategory = 'Math' | 'Across arguments' | 'Conditional' | 'Row' | 'Column statistics' | 'Character' | 'Random'

export interface FunctionInfo {
  name: string
  signature: string
  category: FunctionCategory
  description: string
  /** Text inserted by the editor; "|" marks where the cursor goes. */
  template: string
}

interface FunctionSpec extends FunctionInfo {
  min: number
  max: number
  build: (args: Fn[], ctx: CompileContext, site: number) => Fn
}

// ---------------------------------------------------------------- value helpers

const finite = (x: number): number | null => (Number.isFinite(x) ? x : null)

/** Truth value: non-zero numbers are true; missing (and strings) are unknown. */
function truth(v: Value): boolean | null {
  return typeof v === 'number' ? v !== 0 : null
}

/** Text form of a value, with floating point noise trimmed (0.1 + 0.2 -> "0.3"). */
export function toText(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  return String(Number(v.toPrecision(15)))
}

function sameValue(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b
  return typeof a === typeof b && a === b
}

/** Deterministic number in [0, 1) from three integers. */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x27d4eb2f, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad)
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

const numeric =
  (f: (x: number) => number) =>
  ([a]: Fn[]): Fn =>
  (row) => {
    const x = a(row)
    return typeof x === 'number' ? finite(f(x)) : null
  }

const text =
  (f: (s: string) => Value) =>
  ([a]: Fn[]): Fn =>
  (row) => {
    const v = a(row)
    return v === null ? null : f(toText(v))
  }

/** Optional argument: its value, or `fallback` when the argument is absent. */
const opt = (args: Fn[], i: number, row: number, fallback: Value): Value => (args[i] ? args[i](row) : fallback)

/** Numbers among the arguments' values for this row. */
function numbersOf(args: Fn[], row: number): number[] {
  const out: number[] = []
  for (const a of args) {
    const v = a(row)
    if (typeof v === 'number') out.push(v)
  }
  return out
}

function round(x: number, digits: number): number {
  const m = 10 ** digits
  return (Math.sign(x) * Math.round(Math.abs(x) * m * (1 + Number.EPSILON))) / m
}

// ---------------------------------------------------------------- column statistics

type StatKind = 'mean' | 'sd' | 'sum' | 'min' | 'max' | 'median' | 'n'

function stat(kind: StatKind, values: Value[]): number | null {
  if (kind === 'n') return values.length
  const nums = values.filter((v): v is number => typeof v === 'number')
  const n = nums.length
  if (n === 0) return null
  switch (kind) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'mean':
      return nums.reduce((a, b) => a + b, 0) / n
    case 'sd': {
      if (n < 2) return null
      const m = nums.reduce((a, b) => a + b, 0) / n
      return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1))
    }
    case 'min':
      return nums.reduce((a, b) => (b < a ? b : a))
    case 'max':
      return nums.reduce((a, b) => (b > a ? b : a))
    case 'median': {
      const s = [...nums].sort((a, b) => a - b)
      const mid = n >> 1
      return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
  }
}

const groupKey = (v: Value) => (v === null ? '\u0000' : typeof v === 'number' ? `n${v}` : `s${v}`)

/** Column statistic over all rows, optionally within groups of a by-expression. Computed once. */
const colStat =
  (kind: StatKind) =>
  ([x, by]: Fn[], ctx: CompileContext): Fn => {
    let overall: number | null | undefined
    let byGroup: Map<string, number | null> | undefined
    return (row) => {
      if (!by) {
        if (overall === undefined) {
          const values: Value[] = []
          for (let r = 0; r < ctx.nRows; r++) {
            const v = x(r)
            if (v !== null) values.push(v)
          }
          overall = stat(kind, values)
        }
        return overall
      }
      if (!byGroup) {
        const groups = new Map<string, Value[]>()
        for (let r = 0; r < ctx.nRows; r++) {
          const key = groupKey(by(r))
          let list = groups.get(key)
          if (!list) groups.set(key, (list = []))
          const v = x(r)
          if (v !== null) list.push(v)
        }
        byGroup = new Map([...groups].map(([k, vs]) => [k, stat(kind, vs)]))
      }
      return byGroup.get(groupKey(by(row))) ?? null
    }
  }

// ---------------------------------------------------------------- random

function uniform(ctx: CompileContext, site: number, row: number, k: number): number {
  return hash01(ctx.seed, site * 4 + k, row)
}

// ---------------------------------------------------------------- function table

const FUNCTION_LIST: FunctionSpec[] = [
  // Math
  { name: 'Abs', signature: 'Abs(x)', category: 'Math', description: 'Absolute value', template: 'Abs(|)', min: 1, max: 1, build: numeric(Math.abs) },
  { name: 'Sqrt', signature: 'Sqrt(x)', category: 'Math', description: 'Square root', template: 'Sqrt(|)', min: 1, max: 1, build: numeric(Math.sqrt) },
  { name: 'Exp', signature: 'Exp(x)', category: 'Math', description: 'e raised to x', template: 'Exp(|)', min: 1, max: 1, build: numeric(Math.exp) },
  {
    name: 'Log',
    signature: 'Log(x, base = e)',
    category: 'Math',
    description: 'Natural logarithm, or logarithm to a base',
    template: 'Log(|)',
    min: 1,
    max: 2,
    build: (args) => (row) => {
      const x = args[0](row)
      const base = opt(args, 1, row, Math.E)
      if (typeof x !== 'number' || typeof base !== 'number') return null
      return finite(Math.log(x) / Math.log(base))
    },
  },
  { name: 'Log10', signature: 'Log10(x)', category: 'Math', description: 'Base-10 logarithm', template: 'Log10(|)', min: 1, max: 1, build: numeric(Math.log10) },
  {
    name: 'Power',
    signature: 'Power(x, y)',
    category: 'Math',
    description: 'x raised to the power y (same as x ^ y)',
    template: 'Power(|, 2)',
    min: 2,
    max: 2,
    build:
      ([a, b]) =>
      (row) => {
        const x = a(row)
        const y = b(row)
        return typeof x === 'number' && typeof y === 'number' ? finite(x ** y) : null
      },
  },
  {
    name: 'Round',
    signature: 'Round(x, digits = 0)',
    category: 'Math',
    description: 'Round half away from zero to a number of decimal places',
    template: 'Round(|, 0)',
    min: 1,
    max: 2,
    build: (args) => (row) => {
      const x = args[0](row)
      const d = opt(args, 1, row, 0)
      return typeof x === 'number' && typeof d === 'number' ? finite(round(x, Math.trunc(d))) : null
    },
  },
  { name: 'Floor', signature: 'Floor(x)', category: 'Math', description: 'Largest integer not above x', template: 'Floor(|)', min: 1, max: 1, build: numeric(Math.floor) },
  { name: 'Ceiling', signature: 'Ceiling(x)', category: 'Math', description: 'Smallest integer not below x', template: 'Ceiling(|)', min: 1, max: 1, build: numeric(Math.ceil) },
  {
    name: 'Modulo',
    signature: 'Modulo(a, b)',
    category: 'Math',
    description: 'Remainder of a / b, with the sign of a',
    template: 'Modulo(|, 2)',
    min: 2,
    max: 2,
    build:
      ([a, b]) =>
      (row) => {
        const x = a(row)
        const y = b(row)
        return typeof x === 'number' && typeof y === 'number' ? finite(x % y) : null
      },
  },
  { name: 'Pi', signature: 'Pi()', category: 'Math', description: 'The constant π', template: 'Pi()|', min: 0, max: 0, build: () => () => Math.PI },

  // Across arguments
  ...(
    [
      ['Min', 'Smallest of the arguments', (xs: number[]) => Math.min(...xs)],
      ['Max', 'Largest of the arguments', (xs: number[]) => Math.max(...xs)],
      ['Sum', 'Sum of the arguments', (xs: number[]) => xs.reduce((a, b) => a + b, 0)],
      ['Mean', 'Mean of the arguments', (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length],
    ] as const
  ).map(
    ([name, description, f]): FunctionSpec => ({
      name,
      signature: `${name}(x1, x2, ...)`,
      category: 'Across arguments',
      description: `${description}, ignoring missing values`,
      template: `${name}(|)`,
      min: 1,
      max: Infinity,
      build: (args) => (row) => {
        const xs = numbersOf(args, row)
        return xs.length ? finite(f(xs)) : null
      },
    }),
  ),

  // Conditional
  {
    name: 'If',
    signature: 'If(cond1, value1, cond2, value2, ..., else)',
    category: 'Conditional',
    description: 'Value for the first true condition; missing conditions count as false',
    template: 'If(|, , )',
    min: 2,
    max: Infinity,
    build: (args) => {
      const pairs = args.length >> 1
      const otherwise = args.length % 2 ? args[args.length - 1] : null
      return (row) => {
        for (let k = 0; k < pairs; k++) if (truth(args[2 * k](row)) === true) return args[2 * k + 1](row)
        return otherwise ? otherwise(row) : null
      }
    },
  },
  {
    name: 'Match',
    signature: 'Match(x, v1, r1, v2, r2, ..., else)',
    category: 'Conditional',
    description: 'Result paired with the first v equal to x',
    template: 'Match(|, , , )',
    min: 3,
    max: Infinity,
    build: ([x, ...rest]) => {
      const pairs = rest.length >> 1
      const otherwise = rest.length % 2 ? rest[rest.length - 1] : null
      return (row) => {
        const v = x(row)
        for (let k = 0; k < pairs; k++) if (sameValue(v, rest[2 * k](row))) return rest[2 * k + 1](row)
        return otherwise ? otherwise(row) : null
      }
    },
  },
  {
    name: 'Is Missing',
    signature: 'Is Missing(x)',
    category: 'Conditional',
    description: '1 if x is missing, else 0',
    template: 'Is Missing(|)',
    min: 1,
    max: 1,
    build:
      ([a]) =>
      (row) => {
        const v = a(row)
        return v === null || v === '' ? 1 : 0
      },
  },

  // Row
  { name: 'Row', signature: 'Row()', category: 'Row', description: 'Current row number (1-based)', template: 'Row()|', min: 0, max: 0, build: () => (row) => row + 1 },
  { name: 'N Rows', signature: 'N Rows()', category: 'Row', description: 'Number of rows in the table', template: 'N Rows()|', min: 0, max: 0, build: (_, ctx) => () => ctx.nRows },
  {
    name: 'Lag',
    signature: 'Lag(x, n = 1)',
    category: 'Row',
    description: 'x evaluated n rows earlier (missing before the first row)',
    template: 'Lag(|, 1)',
    min: 1,
    max: 2,
    build: (args, ctx) => (row) => {
      const n = opt(args, 1, row, 1)
      if (typeof n !== 'number') return null
      const r = row - Math.trunc(n)
      return r >= 0 && r < ctx.nRows ? args[0](r) : null
    },
  },

  // Column statistics
  ...(
    [
      ['Col Mean', 'mean', 'Mean of x over all rows'],
      ['Col Std Dev', 'sd', 'Standard deviation of x over all rows'],
      ['Col Sum', 'sum', 'Sum of x over all rows'],
      ['Col Min', 'min', 'Minimum of x over all rows'],
      ['Col Max', 'max', 'Maximum of x over all rows'],
      ['Col Median', 'median', 'Median of x over all rows'],
      ['Col N', 'n', 'Number of non-missing values of x'],
    ] as const
  ).map(
    ([name, kind, description]): FunctionSpec => ({
      name,
      signature: `${name}(x, by)`,
      category: 'Column statistics',
      description: `${description}; within groups when a by-column is given`,
      template: `${name}(|)`,
      min: 1,
      max: 2,
      build: colStat(kind),
    }),
  ),

  // Character
  {
    name: 'Concat',
    signature: 'Concat(a, b, ...)',
    category: 'Character',
    description: 'Join values as text (same as a || b)',
    template: 'Concat(|, )',
    min: 1,
    max: Infinity,
    build: (args) => (row) => {
      let out = ''
      let any = false
      for (const a of args) {
        const v = a(row)
        if (v !== null) any = true
        out += toText(v)
      }
      return any ? out : null
    },
  },
  { name: 'Uppercase', signature: 'Uppercase(s)', category: 'Character', description: 'Text in upper case', template: 'Uppercase(|)', min: 1, max: 1, build: text((s) => s.toUpperCase()) },
  { name: 'Lowercase', signature: 'Lowercase(s)', category: 'Character', description: 'Text in lower case', template: 'Lowercase(|)', min: 1, max: 1, build: text((s) => s.toLowerCase()) },
  { name: 'Trim', signature: 'Trim(s)', category: 'Character', description: 'Text without leading and trailing spaces', template: 'Trim(|)', min: 1, max: 1, build: text((s) => s.trim()) },
  { name: 'Length', signature: 'Length(s)', category: 'Character', description: 'Number of characters', template: 'Length(|)', min: 1, max: 1, build: text((s) => s.length) },
  {
    name: 'Substr',
    signature: 'Substr(s, start, length)',
    category: 'Character',
    description: 'Part of the text from a 1-based start position (to the end if no length)',
    template: 'Substr(|, 1, 3)',
    min: 2,
    max: 3,
    build: (args) => (row) => {
      const v = args[0](row)
      const start = args[1](row)
      const length = opt(args, 2, row, Infinity)
      if (v === null || typeof start !== 'number' || typeof length !== 'number') return null
      const from = Math.max(0, Math.trunc(start) - 1)
      return toText(v).slice(from, length === Infinity ? undefined : from + Math.max(0, Math.trunc(length)))
    },
  },
  {
    name: 'Contains',
    signature: 'Contains(s, part)',
    category: 'Character',
    description: '1-based position of part in s, or 0',
    template: 'Contains(|, "")',
    min: 2,
    max: 2,
    build:
      ([a, b]) =>
      (row) => {
        const s = a(row)
        const part = b(row)
        if (s === null || part === null) return null
        return toText(s).indexOf(toText(part)) + 1
      },
  },
  {
    name: 'Word',
    signature: 'Word(n, s, separators = " ")',
    category: 'Character',
    description: 'The nth word of s (negative n counts from the end)',
    template: 'Word(1, |)',
    min: 2,
    max: 3,
    build: (args) => (row) => {
      const n = args[0](row)
      const s = args[1](row)
      const seps = opt(args, 2, row, ' ')
      if (typeof n !== 'number' || s === null || seps === null) return null
      const sepSet = new Set(toText(seps))
      const words: string[] = []
      let current = ''
      for (const ch of toText(s)) {
        if (sepSet.has(ch)) {
          if (current) words.push(current)
          current = ''
        } else current += ch
      }
      if (current) words.push(current)
      const k = Math.trunc(n)
      const word = k > 0 ? words[k - 1] : k < 0 ? words[words.length + k] : undefined
      return word ?? null
    },
  },
  {
    name: 'Char',
    signature: 'Char(x)',
    category: 'Character',
    description: 'Number as text',
    template: 'Char(|)',
    min: 1,
    max: 1,
    build:
      ([a]) =>
      (row) => {
        const v = a(row)
        return v === null ? null : toText(v)
      },
  },
  {
    name: 'Num',
    signature: 'Num(s)',
    category: 'Character',
    description: 'Text as a number (missing if it does not parse)',
    template: 'Num(|)',
    min: 1,
    max: 1,
    build:
      ([a]) =>
      (row) => {
        const v = a(row)
        if (typeof v === 'number' || v === null) return v
        const t = v.trim()
        if (!t) return null
        const n = Number(t)
        return Number.isFinite(n) ? n : null
      },
  },

  // Random
  {
    name: 'Random Uniform',
    signature: 'Random Uniform(min = 0, max = 1)',
    category: 'Random',
    description: 'Uniform random number; stable across recalculations',
    template: 'Random Uniform()|',
    min: 0,
    max: 2,
    build: (args, ctx, site) => (row) => {
      const lo = opt(args, 0, row, 0)
      const hi = opt(args, 1, row, 1)
      if (typeof lo !== 'number' || typeof hi !== 'number') return null
      return lo + uniform(ctx, site, row, 0) * (hi - lo)
    },
  },
  {
    name: 'Random Normal',
    signature: 'Random Normal(mean = 0, sd = 1)',
    category: 'Random',
    description: 'Normal random number; stable across recalculations',
    template: 'Random Normal()|',
    min: 0,
    max: 2,
    build: (args, ctx, site) => (row) => {
      const mean = opt(args, 0, row, 0)
      const sd = opt(args, 1, row, 1)
      if (typeof mean !== 'number' || typeof sd !== 'number') return null
      const u1 = Math.max(uniform(ctx, site, row, 0), 1e-300)
      const u2 = uniform(ctx, site, row, 1)
      return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    },
  },
  {
    name: 'Random Integer',
    signature: 'Random Integer(min, max)',
    category: 'Random',
    description: 'Random whole number from min to max inclusive',
    template: 'Random Integer(1, |)',
    min: 2,
    max: 2,
    build:
      ([a, b], ctx, site) =>
      (row) => {
        const x = a(row)
        const y = b(row)
        if (typeof x !== 'number' || typeof y !== 'number') return null
        const lo = Math.ceil(Math.min(x, y))
        const hi = Math.floor(Math.max(x, y))
        if (hi < lo) return null
        return lo + Math.floor(uniform(ctx, site, row, 0) * (hi - lo + 1))
      },
  },
]

const FUNCTION_TABLE = new Map(FUNCTION_LIST.map((f) => [functionKey(f.name), f]))

/** Every function, for the editor's palette. */
export const FUNCTIONS: FunctionInfo[] = FUNCTION_LIST.map(({ name, signature, category, description, template }) => ({
  name,
  signature,
  category,
  description,
  template,
}))

function arityMessage(f: FunctionSpec): string {
  if (f.min === f.max) return f.min === 0 ? `${f.name} takes no arguments` : `${f.name} takes ${f.min} argument${f.min === 1 ? '' : 's'}`
  if (f.max === Infinity) return `${f.name} takes at least ${f.min} argument${f.min === 1 ? '' : 's'}`
  return `${f.name} takes ${f.min} to ${f.max} arguments`
}

// ---------------------------------------------------------------- operators

function arithmetic(op: string, l: Fn, r: Fn): Fn {
  const f =
    op === '+'
      ? (a: number, b: number) => a + b
      : op === '-'
        ? (a: number, b: number) => a - b
        : op === '*'
          ? (a: number, b: number) => a * b
          : op === '/'
            ? (a: number, b: number) => a / b
            : (a: number, b: number) => a ** b
  return (row) => {
    const a = l(row)
    if (typeof a !== 'number') return null
    const b = r(row)
    if (typeof b !== 'number') return null
    return finite(f(a, b))
  }
}

function comparison(op: string, l: Fn, r: Fn): Fn {
  return (row) => {
    const a = l(row)
    const b = r(row)
    if (a === null || b === null) return null
    if (typeof a !== typeof b) {
      // A number never equals a string; ordering between them is undefined.
      if (op === '==') return 0
      if (op === '!=') return 1
      return null
    }
    switch (op) {
      case '==':
        return a === b ? 1 : 0
      case '!=':
        return a !== b ? 1 : 0
      case '<':
        return a < b ? 1 : 0
      case '<=':
        return a <= b ? 1 : 0
      case '>':
        return a > b ? 1 : 0
      default:
        return a >= b ? 1 : 0
    }
  }
}

/** Compile an AST. Throws FormulaError for unknown columns / functions and wrong argument counts. */
export function compile(ast: Node, ctx: CompileContext): Fn {
  let site = 0
  const build = (node: Node): Fn => {
    switch (node.kind) {
      case 'num': {
        const v = node.value
        return () => v
      }
      case 'str': {
        const v = node.value
        return () => v
      }
      case 'missing':
        return () => null
      case 'ref': {
        const values = ctx.column(node.name)
        if (!values) throw new FormulaError(`Unknown column "${node.name}"`, node.pos)
        return (row) => values[row] ?? null
      }
      case 'unary': {
        const arg = build(node.arg)
        if (node.op === '-')
          return (row) => {
            const v = arg(row)
            return typeof v === 'number' ? -v : null
          }
        return (row) => {
          const t = truth(arg(row))
          return t === null ? null : t ? 0 : 1
        }
      }
      case 'binary': {
        const l = build(node.left)
        const r = build(node.right)
        switch (node.op) {
          case '+':
          case '-':
          case '*':
          case '/':
          case '^':
            return arithmetic(node.op, l, r)
          case '||':
            return (row) => {
              const a = l(row)
              const b = r(row)
              return a === null && b === null ? null : toText(a) + toText(b)
            }
          case '&':
            return (row) => {
              const a = truth(l(row))
              if (a === false) return 0
              const b = truth(r(row))
              if (b === false) return 0
              return a === null || b === null ? null : 1
            }
          case '|':
            return (row) => {
              const a = truth(l(row))
              if (a === true) return 1
              const b = truth(r(row))
              if (b === true) return 1
              return a === null || b === null ? null : 0
            }
          default:
            return comparison(node.op, l, r)
        }
      }
      case 'call': {
        const spec = FUNCTION_TABLE.get(node.name)
        if (!spec) throw new FormulaError(`Unknown function "${node.display}"`, node.pos)
        if (node.args.length < spec.min || node.args.length > spec.max) throw new FormulaError(arityMessage(spec), node.pos)
        const args = node.args.map(build)
        return spec.build(args, ctx, site++)
      }
    }
  }
  return build(ast)
}
