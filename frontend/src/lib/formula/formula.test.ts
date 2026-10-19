import { describe, expect, it } from 'vitest'
import type { Value } from '../../api/types'
import type { Column } from '../../state/store'
import { checkFormula, evaluateFormula, FormulaError, FUNCTIONS, recomputeFormulas, renameInFormula } from '.'
import { parse, tokenize } from './parse'

function col(name: string, values: Value[], formula?: string, extra: Partial<Column> = {}): Column {
  const numeric = values.every((v) => v === null || typeof v === 'number')
  return {
    id: `id_${name}`,
    name,
    dataType: numeric ? 'numeric' : 'character',
    modelingType: numeric ? 'continuous' : 'nominal',
    values,
    props: formula === undefined ? {} : { formula },
    ...extra,
  }
}

const table: Column[] = [
  col('x', [1, 2, null, 4, 5]),
  col('g', ['a', 'b', 'a', null, 'b']),
  col('s', [' Hello World ', 'foo bar', null, 'x', 'Café']),
  col('Body mass', [10, 20, 30, 40, 50]),
]
const N = 5
const ev = (src: string, columns = table, n = N) => evaluateFormula(src, columns, n)
const first = (src: string) => ev(src)[0]

function errorOf(src: string, columns = table): FormulaError {
  try {
    ev(src, columns)
  } catch (e) {
    return e as FormulaError
  }
  throw new Error(`expected "${src}" to fail`)
}

describe('tokenizer', () => {
  it('reads numbers, strings, missing, refs and function names', () => {
    const kinds = tokenize('1.5 .5 5. 2e-3 . "a\\"b" :x :"Body mass" Col Mean(').map((t) => t.type)
    expect(kinds).toEqual(['num', 'num', 'num', 'num', 'missing', 'str', 'ref', 'ref', 'func', 'op'])
    const t = tokenize('"a\\"b\\\\c"')[0]
    expect(t.type === 'str' && t.value).toBe('a"b\\c')
    const f = tokenize('Col  Mean (')[0]
    expect(f.type === 'func' && f.name).toBe('colmean')
  })

  it('reports bad characters without throwing', () => {
    const tokens = tokenize(':x = 1')
    expect(tokens.some((t) => t.type === 'error' && t.message.includes('=='))).toBe(true)
  })
})

describe('parser', () => {
  it('follows the documented precedence', () => {
    expect(first('1 + 2 * 3')).toBe(7)
    expect(first('(1 + 2) * 3')).toBe(9)
    expect(first('2 ^ 3 ^ 2')).toBe(512) // right associative
    expect(first('-2 ^ 2')).toBe(-4) // power binds tighter than negation
    expect(first('2 ^ -1')).toBe(0.5)
    expect(first('10 - 4 - 3')).toBe(3)
    expect(first('1 + 1 == 2 & 3 > 2')).toBe(1)
    expect(first('0 & 1 | 1')).toBe(1)
    expect(first('"a" || 1 + 1')).toBe('a2') // || binds looser than +
    expect(first('!0 + 1')).toBe(2) // ! is a prefix operator like unary minus
  })

  it('reports errors with positions', () => {
    const e = errorOf('1 + * 2')
    expect(e.message).toBe('Expected a value but found "*"')
    expect(e.position).toBe(4)
    expect(errorOf('Abs(1').message).toBe('Expected "," or ")" but found end of formula')
    expect(errorOf('height * 2').message).toContain(':height')
    expect(errorOf(':x :x').position).toBe(3)
    expect(errorOf('"open').message).toBe('Unterminated string')
    expect(() => parse('   ')).toThrow('The formula is empty')
  })

  it('rejects unknown columns, functions and wrong argument counts', () => {
    expect(errorOf(':nope + 1').message).toBe('Unknown column "nope"')
    expect(errorOf('Foo(1)').message).toBe('Unknown function "Foo"')
    expect(errorOf('Pi(1)').message).toBe('Pi takes no arguments')
    expect(errorOf('Round()').message).toBe('Round takes 1 to 2 arguments')
    expect(errorOf('Min()').message).toBe('Min takes at least 1 argument')
    expect(errorOf('Abs(1, 2)').message).toBe('Abs takes 1 argument')
  })
})

describe('values and operators', () => {
  it('reads columns, including quoted names', () => {
    expect(ev(':x * 2')).toEqual([2, 4, null, 8, 10])
    expect(ev(':"Body mass" / 10')).toEqual([1, 2, 3, 4, 5])
    expect(ev(':g')).toEqual(['a', 'b', 'a', null, 'b'])
  })

  it('propagates missing values', () => {
    expect(ev(':x + 1')[2]).toBeNull()
    expect(first('. + 1')).toBeNull()
    expect(first('1 / 0')).toBeNull()
    expect(first('Sqrt(-1)')).toBeNull()
    expect(first('. == 1')).toBeNull()
    expect(first('"a" + 1')).toBeNull()
  })

  it('compares numbers and strings', () => {
    expect(ev(':g == "a"')).toEqual([1, 0, 1, null, 0])
    expect(first('"abc" < "abd"')).toBe(1)
    expect(first('1 == "1"')).toBe(0)
    expect(first('1 != "1"')).toBe(1)
    expect(first('1 < "1"')).toBeNull()
    expect(first('2 >= 2')).toBe(1)
    expect(first('2 <= 1')).toBe(0)
  })

  it('uses three-valued logic', () => {
    expect(first('. & 0')).toBe(0)
    expect(first('. & 1')).toBeNull()
    expect(first('. | 1')).toBe(1)
    expect(first('. | 0')).toBeNull()
    expect(first('!5')).toBe(0)
    expect(first('!.')).toBeNull()
  })

  it('concatenates text', () => {
    expect(ev(':g || "-" || :x')).toEqual(['a-1', 'b-2', 'a-', '-4', 'b-5'])
    expect(first('. || .')).toBeNull()
    expect(first('0.1 + 0.2 || ""')).toBe('0.3')
  })
})

describe('functions', () => {
  it('has a catalog entry for every function', () => {
    const names = FUNCTIONS.map((f) => f.name)
    expect(names).toContain('Col Std Dev')
    expect(new Set(FUNCTIONS.map((f) => f.category)).size).toBe(7)
    for (const f of FUNCTIONS) expect(f.template).toContain('|')
  })

  it('math', () => {
    expect(first('Abs(-3)')).toBe(3)
    expect(first('Sqrt(16)')).toBe(4)
    expect(first('Exp(0)')).toBe(1)
    expect(first('Log(Exp(2))')).toBeCloseTo(2)
    expect(first('Log(8, 2)')).toBeCloseTo(3)
    expect(first('Log10(1000)')).toBeCloseTo(3)
    expect(first('Power(2, 10)')).toBe(1024)
    expect(first('Round(2.5)')).toBe(3)
    expect(first('Round(-2.5)')).toBe(-3)
    expect(first('Round(1.005, 2)')).toBe(1.01)
    expect(first('Round(1234, -2)')).toBe(1200)
    expect(first('Floor(-1.5)')).toBe(-2)
    expect(first('Ceiling(1.2)')).toBe(2)
    expect(first('Modulo(7, 3)')).toBe(1)
    expect(first('Modulo(-7, 3)')).toBe(-1)
    expect(first('Modulo(1, 0)')).toBeNull()
    expect(first('Pi()')).toBeCloseTo(Math.PI)
  })

  it('across arguments ignore missing', () => {
    expect(first('Min(3, ., 1)')).toBe(1)
    expect(first('Max(3, ., 1)')).toBe(3)
    expect(first('Sum(1, 2, .)')).toBe(3)
    expect(first('Mean(1, 2, ., 6)')).toBe(3)
    expect(first('Sum(., .)')).toBeNull()
  })

  it('If and Match', () => {
    expect(ev('If(:x > 3, "big", :x > 1, "medium", "small")')).toEqual(['small', 'medium', 'small', 'big', 'big'])
    expect(ev('If(:x > 3, 1)')).toEqual([null, null, null, 1, 1])
    expect(first('If(., 1, 2)')).toBe(2) // missing condition counts as false
    expect(ev('Match(:g, "a", 1, "b", 2, 0)')).toEqual([1, 2, 1, 0, 2])
    expect(ev('Match(:g, "a", 1, "b", 2)')).toEqual([1, 2, 1, null, 2])
    expect(ev('Match(:g, ., "none", "some")')).toEqual(['some', 'some', 'some', 'none', 'some'])
    expect(ev('Is Missing(:x)')).toEqual([0, 0, 1, 0, 0])
    expect(ev('IsMissing(:g)')).toEqual([0, 0, 0, 1, 0])
  })

  it('only evaluates the chosen If branch', () => {
    // Lag outside the table would be missing; the branch guard keeps it from mattering.
    expect(ev('If(Row() == 1, 0, Lag(:x))')).toEqual([0, 1, 2, null, 4])
  })

  it('row functions', () => {
    expect(ev('Row()')).toEqual([1, 2, 3, 4, 5])
    expect(first('N Rows()')).toBe(5)
    expect(ev('Lag(:x)')).toEqual([null, 1, 2, null, 4])
    expect(ev('Lag(:x, 2)')).toEqual([null, null, 1, 2, null])
    expect(ev('Lag(:x, -1)')).toEqual([2, null, 4, 5, null])
    expect(ev('Lag(Row() * 10)')).toEqual([null, 10, 20, 30, 40])
  })

  it('column statistics, with and without groups', () => {
    expect(first('Col Mean(:x)')).toBe(3)
    expect(first('Col Sum(:x)')).toBe(12)
    expect(first('Col Min(:x)')).toBe(1)
    expect(first('Col Max(:x)')).toBe(5)
    expect(first('Col Median(:x)')).toBe(3)
    expect(first('Col N(:x)')).toBe(4)
    expect(first('Col N(:g)')).toBe(4)
    expect(first('Col Std Dev(:x)')).toBeCloseTo(Math.sqrt(10 / 3))
    expect(ev('Col Mean(:x, :g)')).toEqual([1, 3.5, 1, 4, 3.5])
    expect(ev('Col N(:x, :g)')).toEqual([1, 2, 1, 1, 2])
    expect(ev(':x - Col Mean(:x)')).toEqual([-2, -1, null, 1, 2])
    expect(ev('colstddev(:x, :g)')[1]).toBeCloseTo(Math.SQRT2 * 1.5)
  })

  it('character functions', () => {
    expect(first('Concat("a", 1, ., "b")')).toBe('a1b')
    expect(ev('Uppercase(:g)')).toEqual(['A', 'B', 'A', null, 'B'])
    expect(first('Lowercase("AbC")')).toBe('abc')
    expect(first('Trim(:s)')).toBe('Hello World')
    expect(ev('Length(:s)')).toEqual([13, 7, null, 1, 4])
    expect(first('Substr("abcdef", 2, 3)')).toBe('bcd')
    expect(first('Substr("abcdef", 4)')).toBe('def')
    expect(first('Substr("abc", 5)')).toBeNull() // empty text is missing
    expect(first('Contains("banana", "nan")')).toBe(3)
    expect(first('Contains("banana", "x")')).toBe(0)
    expect(first('Word(2, :s)')).toBe('World')
    expect(first('Word(-1, "a,b,c", ",")')).toBe('c')
    expect(first('Word(5, "a b")')).toBeNull()
    expect(first('Char(1.5)')).toBe('1.5')
    expect(first('Num(" 42 ")')).toBe(42)
    expect(first('Num("abc")')).toBeNull()
  })

  it('random values are stable per row and formula', () => {
    const a = ev('Random Uniform()', table, 1000)
    expect(ev('Random Uniform()', table, 1000)).toEqual(a)
    expect(new Set(a).size).toBe(1000)
    expect(a.every((v) => typeof v === 'number' && v >= 0 && v < 1)).toBe(true)
    // A different formula (or call site) gives different numbers.
    expect(ev('Random Uniform() + 0', table, 1000)).not.toEqual(a)
    const twice = ev('Random Uniform() - Random Uniform()', table, 10)
    expect(twice.some((v) => v !== 0)).toBe(true)
    const ints = ev('Random Integer(1, 6)', table, 600) as number[]
    expect(new Set(ints)).toEqual(new Set([1, 2, 3, 4, 5, 6]))
    const normal = ev('Random Normal(10, 2)', table, 4000) as number[]
    const mean = normal.reduce((s, v) => s + v, 0) / normal.length
    const sd = Math.sqrt(normal.reduce((s, v) => s + (v - mean) ** 2, 0) / (normal.length - 1))
    expect(mean).toBeCloseTo(10, 0)
    expect(sd).toBeCloseTo(2, 0)
  })

  it('evaluates the Fit Model prediction formula', () => {
    const cols = [col('height', [60, 65]), col('sex', ['F', 'M'])]
    const out = evaluateFormula('120.3 + 3.71 * (:height - 62.55) + -4.2 * Match(:sex, "F", 1, "M", -1, 0)', cols, 2) as number[]
    expect(out[0]).toBeCloseTo(120.3 + 3.71 * (60 - 62.55) - 4.2)
    expect(out[1]).toBeCloseTo(120.3 + 3.71 * (65 - 62.55) + 4.2)
  })
})

describe('result type', () => {
  it('is character when any result is text', () => {
    // Row 3's missing condition counts as false, so it takes the else value.
    expect(ev('If(:x > 3, "big", 1)')).toEqual(['1', '1', '1', 'big', 'big'])
    expect(ev('If(:x > 3, "big", :x)')).toEqual(['1', '2', null, 'big', 'big'])
  })
})

describe('recomputeFormulas', () => {
  it('evaluates formula columns in dependency order', () => {
    const cols = [col('c', [], ':b * 2'), col('a', [1, 2, 3]), col('b', [], ':a + 1')]
    const out = recomputeFormulas(cols, 3)
    expect(out.find((c) => c.name === 'b')!.values).toEqual([2, 3, 4])
    expect(out.find((c) => c.name === 'c')!.values).toEqual([4, 6, 8])
    expect(out[1]).toBe(cols[1])
  })

  it('infers the data type and keeps modeling types valid', () => {
    const cols = [col('a', [1, 2]), col('label', [], 'If(:a > 1, "high", "low")')]
    const label = recomputeFormulas(cols, 2)[1]
    expect(label.dataType).toBe('character')
    expect(label.modelingType).toBe('nominal')
    expect(label.values).toEqual(['low', 'high'])
  })

  it('keeps column identity when nothing changed', () => {
    const cols = recomputeFormulas([col('a', [1, 2]), col('b', [], ':a * 2')], 2)
    const again = recomputeFormulas(cols, 2)
    expect(again).toBe(cols)
    const edited = [{ ...cols[0], values: [5, 2] }, cols[1]]
    const after = recomputeFormulas(edited, 2)
    expect(after[1]).not.toBe(cols[1])
    expect(after[1].values).toEqual([10, 4])
  })

  it('flags circular references', () => {
    const cols = [col('a', [], ':b + 1'), col('b', [], ':a + 1'), col('c', [], '1'), col('d', [], ':d')]
    const out = recomputeFormulas(cols, 2)
    expect(out[0].formulaError).toBe('Circular reference: a → b → a')
    expect(out[1].formulaError).toBe('Circular reference: a → b → a')
    expect(out[0].values).toEqual([null, null])
    expect(out[2].formulaError).toBeUndefined()
    expect(out[2].values).toEqual([1, 1])
    expect(out[3].formulaError).toBe('Circular reference: d → d')
  })

  it('reports parse and reference errors on the column', () => {
    const out = recomputeFormulas([col('a', [1]), col('b', [], ':a +'), col('c', [], ':zz')], 1)
    expect(out[1].formulaError).toBe('Expected a value but found end of formula (at character 5)')
    expect(out[1].values).toEqual([null])
    expect(out[2].formulaError).toBe('Unknown column "zz" (at character 1)')
  })

  it('clears an error once the formula works again', () => {
    const broken = recomputeFormulas([col('a', [1]), col('b', [], ':zz')], 1)
    const fixed = recomputeFormulas([broken[0], { ...broken[1], props: { formula: ':a' } }], 1)
    expect(fixed[1].formulaError).toBeUndefined()
    expect(fixed[1].values).toEqual([1])
  })

  it('handles 100k rows quickly', () => {
    const n = 100_000
    const x = Array.from({ length: n }, (_, i) => i % 97)
    const g = Array.from({ length: n }, (_, i) => `g${i % 5}`)
    const cols = [
      col('x', x),
      col('g', g),
      col('z', [], '(:x - Col Mean(:x, :g)) / Col Std Dev(:x, :g)'),
      col('flag', [], 'If(:z > 1, "high", :z < -1, "low", "mid")'),
    ]
    const start = performance.now()
    const out = recomputeFormulas(cols, n)
    const elapsed = performance.now() - start
    expect(out[3].values[0]).toBe('low')
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('renameInFormula', () => {
  it('rewrites both reference forms and leaves strings alone', () => {
    expect(renameInFormula(':height * 2 + :"height"', 'height', 'Height (in)')).toBe(':"Height (in)" * 2 + :"Height (in)"')
    expect(renameInFormula('Concat(":height", :height)', 'height', 'h')).toBe('Concat(":height", :h)')
    expect(renameInFormula(':heights + 1', 'height', 'h')).toBe(':heights + 1')
    expect(renameInFormula(':"a b" + 1', 'a b', 'ab')).toBe(':ab + 1')
  })

  it('works on formulas that do not parse', () => {
    expect(renameInFormula(':x + * (', 'x', 'y')).toBe(':y + * (')
  })
})

describe('checkFormula', () => {
  it('previews values and the result type', () => {
    const check = checkFormula(':x * 10', table, N)
    expect(check.error).toBeUndefined()
    expect(check.preview).toEqual([10, 20, null, 40, 50])
    expect(check.dataType).toBe('numeric')
    expect(check.nMissing).toBe(1)
    expect(checkFormula(':g || "!"', table, N).dataType).toBe('character')
    expect(checkFormula('  ', table, N).empty).toBe(true)
  })

  it('returns errors with positions', () => {
    expect(checkFormula(':x +', table, N).error).toEqual({ message: 'Expected a value but found end of formula', position: 4 })
    expect(checkFormula('Abs(:nope)', table, N).error).toEqual({ message: 'Unknown column "nope"', position: 4 })
  })

  it('refuses references to the column itself, directly or through other formulas', () => {
    const cols = [...table, col('f', [], ':x + 1'), col('g2', [], ':f * 2')]
    expect(checkFormula(':f + 1', cols, N, 'id_f').error?.message).toBe("A formula can't refer to its own column (:f)")
    expect(checkFormula(':g2 + 1', cols, N, 'id_f').error?.message).toBe('Circular reference: f → g2 → f')
    expect(checkFormula(':x + 1', cols, N, 'id_f').error).toBeUndefined()
  })
})
