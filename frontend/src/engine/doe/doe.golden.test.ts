// The DOE 'properties' golden cases: custom (D-optimal) designs, which golden.test.ts skips.
//
// The coordinate exchange draws the same random stream as numpy, so most designs match
// the Python ones exactly and are compared that way. A few cannot: where two candidate
// levels give exactly the same determinant ratio (e.g. both 65/56), or two random starts
// reach equally good designs, Python's choice is decided by the last bit of OpenBLAS and
// LAPACK rounding, which plain JavaScript arithmetic can't reproduce. Those cases get a
// property check instead: same table shape and report apart from the design-dependent
// diagnostics, valid factor levels, and a D-efficiency no more than half a point below
// the Python design's.

import { describe, expect, it } from 'vitest'
import type { DoeRequest, DoeResult, ReportNode } from '../../api/types'
import { diff, type GoldenFile } from '../golden'
import file from '../golden/doe.json'
import { makeDesign } from '.'

/** Cases whose Python design is picked by a rounding-level tie (see above). */
const TIED = new Set(['custom quadratic', 'custom categorical'])

const DESIGN_DEPENDENT = new Set(['Design Diagnostics', 'Correlations of Model Terms'])

function withoutDiagnostics(nodes: ReportNode[]): ReportNode[] {
  return nodes
    .filter((n) => !(n.type === 'outline' && DESIGN_DEPENDENT.has(n.title)))
    .map((n) => (n.type === 'outline' ? { ...n, children: withoutDiagnostics(n.children) } : n))
}

function dEfficiency(nodes: ReportNode[]): number | undefined {
  for (const n of nodes) {
    if (n.type === 'summary') {
      const item = n.items.find((i) => i.label === 'D Efficiency')
      if (item) return item.value as number
    }
    if (n.type === 'outline') {
      const found = dEfficiency(n.children)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function checkProperties(req: DoeRequest, actual: DoeResult, expected: DoeResult) {
  const strip = (r: DoeResult) => ({ ...r.table, columns: r.table.columns.map((c) => ({ ...c, values: null })) })
  expect(diff(strip(actual), strip(expected)), 'table shape').toEqual([])
  expect(diff(withoutDiagnostics(actual.nodes), withoutDiagnostics(expected.nodes)), 'report').toEqual([])
  for (const f of req.factors) {
    const values = actual.table.columns.find((c) => c.name === f.name)!.values
    const allowed: unknown[] =
      f.kind === 'categorical' ? f.levels! : [f.low!, (f.low! + f.high!) / 2, f.high!]
    expect(values.filter((v) => !allowed.includes(v)), `levels of ${f.name}`).toEqual([])
  }
  const python = dEfficiency(expected.nodes)!
  expect(dEfficiency(actual.nodes)).toBeGreaterThanOrEqual(python - 0.5)
}

describe('golden doe properties', () => {
  for (const c of (file as unknown as GoldenFile).cases) {
    if (c.compare !== 'properties') continue
    it(c.name, () => {
      const req = c.request as unknown as DoeRequest
      const actual = makeDesign(req)
      if (TIED.has(c.name)) checkProperties(req, actual, c.expected as DoeResult)
      else expect(diff(actual, c.expected, c.tol)).toEqual([])
    })
  }
})
