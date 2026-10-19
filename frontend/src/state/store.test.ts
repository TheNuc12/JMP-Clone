import { beforeEach, describe, expect, it } from 'vitest'
import type { DataTablePayload } from '../api/types'
import { activeTableOf, convertValues, uniqueName, useStore } from './store'

const payload: DataTablePayload = {
  name: 'demo',
  n_rows: 4,
  columns: [
    { name: 'x', data_type: 'numeric', modeling_type: 'continuous', values: [1, 2, 3, 4] },
    { name: 'g', data_type: 'character', modeling_type: 'nominal', values: ['a', 'b', 'a', null], value_order: ['b', 'a'] },
  ],
  model: { responses: ['x'], effects: [['g'], ['g', 'g'], ['missing']] },
}

const s = () => useStore.getState()
const table = () => activeTableOf(s())!
const col = (name: string) => table().columns.find((c) => c.name === name)!

beforeEach(() => {
  s().replaceWorkspace({ tables: [], reports: [], activeTableId: null, activeReportId: null })
  s().addTable(payload)
})

describe('tables', () => {
  it('loads payload properties and maps the saved model to column ids', () => {
    expect(col('g').props.valueOrder).toEqual(['b', 'a'])
    expect(table().model).toEqual({ responses: [col('x').id], effects: [[col('g').id], [col('g').id, col('g').id]] })
  })

  it('keeps several tables with their own reports', () => {
    s().openReport({ kind: 'distribution', roles: { y: [col('x').id] } })
    const first = table().id
    s().newTable()
    expect(s().tables).toHaveLength(2)
    expect(table().columns[0].name).toBe('Column 1')
    s().closeTable(first)
    expect(s().reports).toHaveLength(0)
    expect(s().tables).toHaveLength(1)
  })
})

describe('editing', () => {
  it('edits cells with conversion and undo / redo', () => {
    s().setCell(0, col('x').id, '42')
    expect(col('x').values[0]).toBe(42)
    s().setCell(1, col('x').id, 'oops')
    expect(col('x').values[1]).toBeNull()
    s().undo()
    expect(col('x').values[1]).toBe(2)
    s().undo()
    expect(col('x').values[0]).toBe(1)
    s().redo()
    expect(col('x').values[0]).toBe(42)
  })

  it('adds and deletes rows, keeping row states aligned', () => {
    s().selectRows([3])
    s().addRows(2, 1)
    expect(table().nRows).toBe(6)
    expect(col('x').values).toEqual([1, null, null, 2, 3, 4])
    expect(table().selected[5]).toBe(1)
    s().deleteRows()
    expect(table().nRows).toBe(5)
    expect(table().nSelected).toBe(0)
    expect(col('x').values).toEqual([1, null, null, 2, 3])
  })

  it('adds, renames, retypes and deletes columns', () => {
    const id = s().addColumn({ name: 'x', dataType: 'numeric', modelingType: 'continuous', values: [5] })
    expect(table().columns.find((c) => c.id === id)!.name).toBe('x 2')
    expect(table().columns.find((c) => c.id === id)!.values).toEqual([5, null, null, null])
    s().updateColumn(id, { name: 'g' })
    expect(table().columns.find((c) => c.id === id)!.name).toBe('g 2')
    s().updateColumn(id, { dataType: 'character' })
    const changed = table().columns.find((c) => c.id === id)!
    expect(changed.values).toEqual(['5', null, null, null])
    expect(changed.modelingType).toBe('nominal')
    s().deleteColumns([id])
    expect(table().columns).toHaveLength(2)
  })

  it('exclude toggles like JMP', () => {
    s().selectRows([0, 1])
    s().toggleExcludeSelected()
    expect(table().nExcluded).toBe(2)
    s().toggleExcludeSelected()
    expect(table().nExcluded).toBe(0)
  })
})

describe('helpers', () => {
  it('makes unique names', () => {
    expect(uniqueName('a', ['a', 'a 2'])).toBe('a 3')
    expect(uniqueName('a', ['a'], 'a')).toBe('a')
  })

  it('converts values between data types', () => {
    expect(convertValues([1, 2.5, null], 'character')).toEqual(['1', '2.5', null])
    expect(convertValues(['1', ' ', 'x', 3], 'numeric')).toEqual([1, null, null, 3])
  })
})
