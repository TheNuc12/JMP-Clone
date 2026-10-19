import { beforeEach, describe, expect, it } from 'vitest'
import { activeTableOf, useStore } from '../../state/store'

const s = () => useStore.getState()
const col = (name: string) => activeTableOf(s())!.columns.find((c) => c.name === name)!

beforeEach(() => {
  s().replaceWorkspace({ tables: [], reports: [], activeTableId: null, activeReportId: null })
  s().addTable({
    name: 'students',
    n_rows: 3,
    columns: [
      { name: 'height', data_type: 'numeric', modeling_type: 'continuous', values: [60, 65, 70] },
      { name: 'weight', data_type: 'numeric', modeling_type: 'continuous', values: [100, 130, 160] },
    ],
  })
})

describe('formula columns in the store', () => {
  it('computes on creation and recomputes when a referenced cell changes', () => {
    s().addColumn({ name: 'BMI', dataType: 'numeric', modelingType: 'continuous', props: { formula: ':weight / (:height ^ 2) * 703' } })
    expect(col('BMI').values[0]).toBeCloseTo((100 / 3600) * 703)
    s().setCell(0, col('weight').id, 120)
    expect(col('BMI').values[0]).toBeCloseTo((120 / 3600) * 703)
    s().undo()
    expect(col('BMI').values[0]).toBeCloseTo((100 / 3600) * 703)
  })

  it('keeps formulas working when a referenced column is renamed', () => {
    s().addColumn({ name: 'double', dataType: 'numeric', modelingType: 'continuous', props: { formula: ':height * 2' } })
    s().updateColumn(col('height').id, { name: 'Height (in)' })
    expect(col('double').props.formula).toBe(':"Height (in)" * 2')
    expect(col('double').values).toEqual([120, 130, 140])
    expect(col('double').formulaError).toBeUndefined()
  })

  it('shows formula errors and ignores direct edits to formula cells', () => {
    s().addColumn({ name: 'bad', dataType: 'numeric', modelingType: 'continuous', props: { formula: ':nope' } })
    expect(col('bad').formulaError).toContain('Unknown column "nope"')
    s().updateColumn(col('bad').id, { props: { formula: ':height + 1' } })
    expect(col('bad').formulaError).toBeUndefined()
    s().setCell(0, col('bad').id, 999)
    expect(col('bad').values[0]).toBe(61)
  })
})
