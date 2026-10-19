import { describe, expect, it } from 'vitest'
import type { Column, TableDoc } from '../state/store'
import { parseCellInput, parseDelimited, plainText, quoteField, rowsToTsv, safeFileName, tableToCsv } from './csv'

const col = (name: string, values: Column['values'], dataType: Column['dataType'] = 'numeric'): Column => ({
  id: name,
  name,
  dataType,
  modelingType: dataType === 'numeric' ? 'continuous' : 'nominal',
  values,
  props: {},
})

const table = (columns: Column[]): TableDoc => ({
  id: 't',
  name: 'demo',
  nRows: columns[0].values.length,
  columns,
  selected: new Uint8Array(columns[0].values.length),
  excluded: new Uint8Array(columns[0].values.length),
  nSelected: 0,
  nExcluded: 0,
})

describe('plainText', () => {
  it('drops float noise but keeps precision', () => {
    expect(plainText(0.1 + 0.2)).toBe('0.3')
    expect(plainText(12)).toBe('12')
    expect(plainText(-3.25)).toBe('-3.25')
    expect(plainText(123456.789012345)).toBe('123456.789012345')
    expect(plainText(1.23456789e-8)).toBe('1.23456789e-8')
    expect(plainText(null)).toBe('')
    expect(plainText('a,b')).toBe('a,b')
  })
})

describe('CSV export', () => {
  it('quotes fields per RFC 4180', () => {
    expect(quoteField('plain')).toBe('plain')
    expect(quoteField('a,b')).toBe('"a,b"')
    expect(quoteField('say "hi"')).toBe('"say ""hi"""')
    expect(quoteField('two\nlines')).toBe('"two\nlines"')
    expect(quoteField(' padded ')).toBe('" padded "')
  })

  it('writes a header and one line per row', () => {
    const csv = tableToCsv(table([col('x', [1, null, 0.1 + 0.2]), col('label, note', ['a', 'b "c"', null], 'character')]))
    expect(csv).toBe('x,"label, note"\r\n1,a\r\n,"b ""c"""\r\n0.3,\r\n')
  })

  it('round-trips through the delimited parser', () => {
    const csv = tableToCsv(table([col('x', [1, 2]), col('s', ['multi\nline', 'q"uote'], 'character')]))
    expect(parseDelimited(csv, ',')).toEqual([
      ['x', 's'],
      ['1', 'multi\nline'],
      ['2', 'q"uote'],
    ])
  })

  it('makes safe file names', () => {
    expect(safeFileName('a/b:c')).toBe('a b c')
    expect(safeFileName('  ')).toBe('data')
  })
})

describe('clipboard text', () => {
  it('parses tab-separated blocks from spreadsheets', () => {
    expect(parseDelimited('1\t2\n3\t4\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(parseDelimited('a\t"multi\nline"\r\nb\t')).toEqual([
      ['a', 'multi\nline'],
      ['b', ''],
    ])
    expect(parseDelimited('')).toEqual([])
  })

  it('copies rows as TSV', () => {
    const columns = [col('x', [1, 2.5]), col('s', ['a\tb', null], 'character')]
    expect(rowsToTsv(columns, [0, 1])).toBe('1\t"a\tb"\n2.5\t')
  })
})

describe('parseCellInput', () => {
  it('accepts numbers and missing for numeric columns', () => {
    expect(parseCellInput(' 42 ', 'numeric')).toEqual({ ok: true, value: 42 })
    expect(parseCellInput('1e3', 'numeric')).toEqual({ ok: true, value: 1000 })
    expect(parseCellInput('', 'numeric')).toEqual({ ok: true, value: null })
    expect(parseCellInput('.', 'numeric')).toEqual({ ok: true, value: null })
  })

  it('rejects text in numeric columns', () => {
    const parsed = parseCellInput('abc', 'numeric')
    expect(parsed.ok).toBe(false)
  })

  it('keeps text for character columns', () => {
    expect(parseCellInput('Low dose', 'character')).toEqual({ ok: true, value: 'Low dose' })
    expect(parseCellInput('   ', 'character')).toEqual({ ok: true, value: null })
    expect(parseCellInput('.', 'character')).toEqual({ ok: true, value: '.' })
  })
})
