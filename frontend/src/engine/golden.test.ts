// Runs every golden case through the TypeScript engine. Cases whose engine part is not
// ported yet are skipped (NotPortedError), so the suite grows as ports land.

import { describe, expect, it } from 'vitest'
import type { AnalyzeRequest, DataTablePayload, DoeRequest, DoeResult } from '../api/types'
import { runAnalysis } from './analyses'
import { makeDesign } from './doe'
import { NotPortedError } from './errors'
import { diff, resolveRequest, type GoldenCase, type GoldenFile } from './golden'
import { parseUpload } from './io'

const files = import.meta.glob<GoldenFile>('./golden/*.json', { eager: true, import: 'default' })

function base64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** Result in the reference engine's shape: the value, or { error } for rejected requests. */
async function run(file: GoldenFile, c: GoldenCase): Promise<unknown> {
  try {
    if (c.kind === 'analyze') return runAnalysis(resolveRequest(file, c) as AnalyzeRequest)
    if (c.kind === 'doe') return makeDesign(c.request as unknown as DoeRequest)
    const req = c.request as { filename: string; content_b64: string }
    return await parseUpload(req.filename, base64Bytes(req.content_b64))
  } catch (e) {
    if (e instanceof NotPortedError) throw e
    if (e instanceof Error && e.constructor !== Error && e.constructor !== TypeError && e.constructor !== RangeError) return { error: e.message }
    throw e
  }
}

/** DOE 'rows' cases: same table except run order. */
function sortRows(result: DoeResult): DoeResult {
  const table: DataTablePayload = result.table
  const n = table.n_rows
  const keys = Array.from({ length: n }, (_, i) => JSON.stringify(table.columns.map((c) => c.values[i])))
  const order = keys.map((k, i) => [k, i] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, i]) => i)
  return { ...result, table: { ...table, columns: table.columns.map((c) => ({ ...c, values: order.map((i) => c.values[i]) })) } }
}

for (const [path, file] of Object.entries(files)) {
  describe(`golden ${file.area}`, () => {
    for (const c of file.cases) {
      if (c.compare === 'properties') continue // checked by the DOE tests
      it(c.name, async (ctx) => {
        let actual: unknown
        try {
          actual = await run(file, c)
        } catch (e) {
          if (e instanceof NotPortedError) return ctx.skip()
          throw e
        }
        let expected = c.expected
        if (c.compare === 'rows' && expected && !('error' in (expected as object))) {
          actual = sortRows(actual as DoeResult)
          expected = sortRows(expected as DoeResult)
        }
        const problems = diff(actual, expected, c.tol)
        expect(problems, `${path} :: ${c.name}`).toEqual([])
      })
    }
  })
}
