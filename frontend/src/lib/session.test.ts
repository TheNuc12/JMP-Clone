import { describe, expect, it } from 'vitest'
import type { ReportConfig, TableDoc, Workspace } from '../state/store'
import { parseSession, parseSessionText, serializeWorkspace, SessionError, sessionFileName } from './session'

function mask(n: number, on: number[]): Uint8Array {
  const m = new Uint8Array(n)
  for (const i of on) m[i] = 1
  return m
}

const students: TableDoc = {
  id: 't1',
  name: 'Students',
  nRows: 4,
  columns: [
    {
      id: 'c1',
      name: 'height',
      dataType: 'numeric',
      modelingType: 'continuous',
      values: [60.5, null, 62, 70],
      props: { specLimits: { lsl: 50, usl: 80 } },
    },
    {
      id: 'c2',
      name: 'sex',
      dataType: 'character',
      modelingType: 'nominal',
      values: ['F', 'M', null, 'F'],
      props: { valueOrder: ['M', 'F'] },
    },
    {
      id: 'c3',
      name: 'double',
      dataType: 'numeric',
      modelingType: 'continuous',
      values: [121, null, 124, 140],
      props: { formula: ':height * 2' },
    },
  ],
  selected: mask(4, [0, 3]),
  excluded: mask(4, [1]),
  nSelected: 2,
  nExcluded: 1,
  model: { responses: ['c1'], effects: [['c2'], ['c2', 'c2']] },
}

const empty: TableDoc = {
  id: 't2',
  name: 'Untitled',
  nRows: 0,
  columns: [{ id: 'c9', name: 'Column 1', dataType: 'numeric', modelingType: 'continuous', values: [], props: {} }],
  selected: new Uint8Array(0),
  excluded: new Uint8Array(0),
  nSelected: 0,
  nExcluded: 0,
}

const reports: ReportConfig[] = [
  { id: 'r1', tableId: 't1', kind: 'distribution', roles: { y: ['c1', 'c2'] }, params: {}, options: { c1: { fit_normal: true } } },
  { id: 'r2', tableId: 't1', kind: 'graph_builder', roles: { x: ['c1'], y: [] }, params: { elements: ['points'] }, options: {} },
]

const workspace: Workspace = { tables: [students, empty], reports, activeTableId: 't1', activeReportId: 'r2' }

const roundTrip = (w: Workspace) => parseSessionText(JSON.stringify(serializeWorkspace(w)))

describe('session round trip', () => {
  it('restores tables, row states, properties, models and reports', () => {
    const back = roundTrip(workspace)
    expect(back.activeTableId).toBe('t1')
    expect(back.activeReportId).toBe('r2')
    expect(back.reports).toEqual(reports)
    expect(back.tables).toHaveLength(2)
    const t = back.tables[0]
    expect(t.columns).toEqual(students.columns)
    expect(Array.from(t.selected)).toEqual([1, 0, 0, 1])
    expect(Array.from(t.excluded)).toEqual([0, 1, 0, 0])
    expect(t.nSelected).toBe(2)
    expect(t.nExcluded).toBe(1)
    expect(t.model).toEqual(students.model)
    expect(back.tables[1].nRows).toBe(0)
    expect(back.tables[1].model).toBeUndefined()
  })

  it('stores masks as row indices', () => {
    const file = serializeWorkspace(workspace, new Date('2026-10-19T10:00:00Z'))
    expect(file.format).toBe('sift-session')
    expect(file.version).toBe(1)
    expect(file.savedAt).toBe('2026-10-19T10:00:00.000Z')
    expect(file.tables[0].selected).toEqual([0, 3])
    expect(file.tables[0].excluded).toEqual([1])
  })

  it('falls back when the active ids are missing', () => {
    const file = serializeWorkspace(workspace)
    const back = parseSession({ ...file, activeTableId: 'nope', activeReportId: 'gone' })
    expect(back.activeTableId).toBe('t1')
    expect(back.activeReportId).toBeNull()
  })

  it('names the file after the active table', () => {
    expect(sessionFileName(workspace)).toBe('Students.sift')
    expect(sessionFileName({ ...workspace, activeTableId: null })).toBe('session.sift')
  })
})

describe('session validation', () => {
  const file = () => JSON.parse(JSON.stringify(serializeWorkspace(workspace)))

  const rejects = (data: unknown, message: RegExp) => {
    expect(() => parseSession(data)).toThrow(SessionError)
    expect(() => parseSession(data)).toThrow(message)
  }

  it('rejects files that are not sessions', () => {
    expect(() => parseSessionText('a,b\n1,2')).toThrow(/not valid JSON/)
    rejects({ hello: 'world' }, /not a Sift session/)
    rejects({ ...file(), version: 7 }, /newer version of Sift/)
  })

  it('rejects damaged tables', () => {
    const shortColumn = file()
    shortColumn.tables[0].columns[0].values.pop()
    rejects(shortColumn, /should have 4 values/)

    const wrongType = file()
    wrongType.tables[0].columns[1].values[0] = 3
    rejects(wrongType, /doesn't match its data type/)

    const badMask = file()
    badMask.tables[0].selected = [9]
    rejects(badMask, /row that does not exist/)

    const badKind = file()
    badKind.tables[0].columns[0].modelingType = 'interval'
    rejects(badKind, /unknown modeling type/)
  })

  it('rejects reports that point nowhere or have unknown platforms', () => {
    const orphan = file()
    orphan.reports[0].tableId = 'elsewhere'
    rejects(orphan, /not in the session/)

    const unknown = file()
    unknown.reports[0].kind = 'neural_net'
    rejects(unknown, /unknown platform/)
  })

  it('drops model references to columns that no longer exist', () => {
    const f = file()
    f.tables[0].model.effects.push(['ghost'])
    expect(parseSession(f).tables[0].model).toEqual(students.model)
  })
})
