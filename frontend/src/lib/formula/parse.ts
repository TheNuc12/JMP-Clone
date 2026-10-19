// Tokenizer and parser for the formula language (docs/formula-language.md).

export class FormulaError extends Error {
  /** 0-based character offset in the formula source, when known. */
  position?: number

  constructor(message: string, position?: number) {
    super(message)
    this.position = position
  }
}

export type Token =
  | { type: 'num'; value: number; start: number; end: number }
  | { type: 'str'; value: string; start: number; end: number }
  | { type: 'missing'; start: number; end: number }
  | { type: 'ref'; name: string; start: number; end: number }
  | { type: 'func'; name: string; display: string; start: number; end: number }
  | { type: 'op'; op: string; start: number; end: number }
  | { type: 'error'; message: string; start: number; end: number }

export type Node =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'missing'; pos: number }
  | { kind: 'ref'; name: string; pos: number }
  | { kind: 'unary'; op: '-' | '!'; arg: Node; pos: number }
  | { kind: 'binary'; op: string; left: Node; right: Node; pos: number }
  | { kind: 'call'; name: string; display: string; args: Node[]; pos: number }

/** Function names ignore case and spaces: "Col Mean", "colmean" and "ColMean" are the same. */
export function functionKey(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase()
}

const OPERATORS = ['||', '==', '!=', '<=', '>=', '(', ')', ',', '^', '-', '!', '*', '/', '+', '<', '>', '&', '|']

const isDigit = (c: string) => c >= '0' && c <= '9'
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c)
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c)

/** Read a double-quoted string starting at `start` (the opening quote). */
function readString(src: string, start: number): { value: string; end: number } | null {
  let value = ''
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '"') return { value, end: i + 1 }
    if (c === '\\' && i + 1 < src.length) {
      const next = src[i + 1]
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i += 2
      continue
    }
    value += c
    i++
  }
  return null
}

/**
 * Split formula source into tokens. Never throws: problems become `error` tokens, so
 * callers like renameInFormula still work on formulas that don't parse.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const start = i
    // Numbers: 12, 1.5, .5, 5., 2e-3. A lone "." is the missing value.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i
      while (isDigit(src[j] ?? '')) j++
      if (src[j] === '.') {
        j++
        while (isDigit(src[j] ?? '')) j++
      }
      if ((src[j] === 'e' || src[j] === 'E') && (isDigit(src[j + 1] ?? '') || (/[+-]/.test(src[j + 1] ?? '') && isDigit(src[j + 2] ?? '')))) {
        j += 2
        while (isDigit(src[j] ?? '')) j++
      }
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), start, end: j })
      i = j
      continue
    }
    if (c === '.') {
      tokens.push({ type: 'missing', start, end: i + 1 })
      i++
      continue
    }
    if (c === '"') {
      const s = readString(src, i)
      if (!s) {
        tokens.push({ type: 'error', message: 'Unterminated string', start, end: src.length })
        break
      }
      tokens.push({ type: 'str', value: s.value, start, end: s.end })
      i = s.end
      continue
    }
    if (c === ':') {
      if (src[i + 1] === '"') {
        const s = readString(src, i + 1)
        if (!s) {
          tokens.push({ type: 'error', message: 'Unterminated column name', start, end: src.length })
          break
        }
        tokens.push({ type: 'ref', name: s.value, start, end: s.end })
        i = s.end
        continue
      }
      let j = i + 1
      if (!isIdentStart(src[j] ?? '')) {
        tokens.push({ type: 'error', message: 'Expected a column name after ":"', start, end: i + 1 })
        i++
        continue
      }
      while (isIdentPart(src[j] ?? '')) j++
      tokens.push({ type: 'ref', name: src.slice(i + 1, j), start, end: j })
      i = j
      continue
    }
    if (isIdentStart(c)) {
      // A function name, which may contain spaces ("Col Mean"), runs up to its "(".
      let j = i
      while (j < src.length && (isIdentPart(src[j]) || src[j] === ' ' || src[j] === '\t')) j++
      const word = src.slice(i, j).trim()
      if (src[j] === '(') {
        tokens.push({ type: 'func', name: functionKey(word), display: word, start, end: i + word.length })
      } else {
        const first = word.split(/\s+/)[0]
        tokens.push({
          type: 'error',
          message: `Unknown name "${first}". Refer to columns with a colon, like :${first}`,
          start,
          end: i + first.length,
        })
      }
      i = i + word.length
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op) {
      tokens.push({ type: 'op', op, start, end: i + op.length })
      i += op.length
      continue
    }
    const hint = c === '=' ? ' (use == to compare)' : ''
    tokens.push({ type: 'error', message: `Unexpected character "${c}"${hint}`, start, end: i + 1 })
    i++
  }
  return tokens
}

// Binding powers [left, right]; ^ is right associative.
const BINARY: Record<string, [number, number]> = {
  '|': [1, 2],
  '&': [3, 4],
  '==': [5, 6],
  '!=': [5, 6],
  '<': [5, 6],
  '<=': [5, 6],
  '>': [5, 6],
  '>=': [5, 6],
  '||': [7, 8],
  '+': [9, 10],
  '-': [9, 10],
  '*': [11, 12],
  '/': [11, 12],
  '^': [15, 14],
}
const PREFIX_POWER = 13

/** Parse formula source into an AST. Throws FormulaError with a position. */
export function parse(src: string): Node {
  const tokens = tokenize(src)
  const bad = tokens.find((t) => t.type === 'error')
  if (bad && bad.type === 'error') throw new FormulaError(bad.message, bad.start)
  let i = 0
  const peek = (): Token | undefined => tokens[i]
  const describe = (t: Token | undefined) => {
    if (!t) return 'end of formula'
    switch (t.type) {
      case 'op':
        return `"${t.op}"`
      case 'num':
        return `number ${src.slice(t.start, t.end)}`
      case 'str':
        return 'a string'
      case 'ref':
        return `column ${src.slice(t.start, t.end)}`
      case 'func':
        return `function ${t.display}`
      default:
        return `"${src.slice(t.start, t.end)}"`
    }
  }
  const fail = (expected: string): never => {
    const t = peek()
    throw new FormulaError(`Expected ${expected} but found ${describe(t)}`, t ? t.start : src.length)
  }
  const expectOp = (op: string) => {
    const t = peek()
    if (t?.type === 'op' && t.op === op) {
      i++
      return t
    }
    return fail(`"${op}"`)
  }

  const primary = (): Node => {
    const t = peek()
    if (!t) return fail('a value')
    switch (t.type) {
      case 'num':
        i++
        return { kind: 'num', value: t.value, pos: t.start }
      case 'str':
        i++
        return { kind: 'str', value: t.value, pos: t.start }
      case 'missing':
        i++
        return { kind: 'missing', pos: t.start }
      case 'ref':
        i++
        return { kind: 'ref', name: t.name, pos: t.start }
      case 'func': {
        i++
        expectOp('(')
        const args: Node[] = []
        const close = peek()
        if (close?.type === 'op' && close.op === ')') {
          i++
        } else {
          for (;;) {
            args.push(expression(0))
            const sep = peek()
            if (sep?.type === 'op' && sep.op === ',') {
              i++
              continue
            }
            if (sep?.type === 'op' && sep.op === ')') {
              i++
              break
            }
            fail('"," or ")"')
          }
        }
        return { kind: 'call', name: t.name, display: t.display, args, pos: t.start }
      }
      case 'op':
        if (t.op === '(') {
          i++
          const inner = expression(0)
          expectOp(')')
          return inner
        }
        if (t.op === '-' || t.op === '!') {
          i++
          return { kind: 'unary', op: t.op, arg: expression(PREFIX_POWER), pos: t.start }
        }
        return fail('a value')
      default:
        return fail('a value')
    }
  }

  const expression = (minPower: number): Node => {
    let left = primary()
    for (;;) {
      const t = peek()
      if (!t || t.type !== 'op' || !(t.op in BINARY)) break
      const [lbp, rbp] = BINARY[t.op]
      if (lbp < minPower) break
      i++
      const right = expression(rbp)
      left = { kind: 'binary', op: t.op, left, right, pos: t.start }
    }
    return left
  }

  if (tokens.length === 0) throw new FormulaError('The formula is empty', 0)
  const ast = expression(0)
  if (i < tokens.length) fail('an operator')
  return ast
}

/** Names of every column the formula refers to. */
export function referencedColumns(ast: Node, out = new Set<string>()): Set<string> {
  switch (ast.kind) {
    case 'ref':
      out.add(ast.name)
      break
    case 'unary':
      referencedColumns(ast.arg, out)
      break
    case 'binary':
      referencedColumns(ast.left, out)
      referencedColumns(ast.right, out)
      break
    case 'call':
      for (const a of ast.args) referencedColumns(a, out)
      break
  }
  return out
}
