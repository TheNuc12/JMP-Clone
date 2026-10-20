import { describe, expect, it } from 'vitest'
import type { AnalysisColumn, AnalysisResult, ReportNode, TableNode } from '../../api/types'
import { analyze } from './fitModel'
import type { Request } from './index'

/** A 10,000-row process with 3 continuous and 2 categorical factors. */
function bigRequest(params: Record<string, unknown>): Request {
  const n = 10000
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const a = Array.from({ length: n }, () => rand() * 10)
  const b = Array.from({ length: n }, () => rand() * 5)
  const c = Array.from({ length: n }, () => rand())
  const m = Array.from({ length: n }, () => ['A', 'B', 'C'][Math.floor(rand() * 3)])
  const s = Array.from({ length: n }, () => (rand() < 0.5 ? 'Day' : 'Night'))
  const y = a.map((v, i) => 3 + 2 * v - b[i] + 0.5 * v * b[i] + (m[i] === 'B' ? 1 : 0) + rand())
  const col = (name: string, values: (number | string)[], modeling_type: AnalysisColumn['modeling_type'] = 'continuous'): AnalysisColumn => ({
    name,
    modeling_type,
    values,
  })
  return {
    platform: 'fit_model',
    y: col('y', y),
    x: null,
    roles: { factors: [col('a', a), col('b', b), col('c', c), col('m', m, 'nominal'), col('s', s, 'nominal')] },
    params,
    options: {},
  }
}

const effects = [['a'], ['b'], ['c'], ['m'], ['s'], ['a', 'b'], ['a', 'a'], ['b', 'm'], ['a', 'c']]

function findTable(nodes: ReportNode[], title: string): TableNode | null {
  for (const node of nodes) {
    if (node.type === 'outline' && node.title === title) {
      const table = node.children.find((c) => c.type === 'table')
      if (table) return table as TableNode
    }
    if ('children' in node) {
      const found = findTable(node.children, title)
      if (found) return found
    }
  }
  return null
}

describe('fit model performance', () => {
  it('fits ~10 terms on 10k rows quickly', () => {
    const req = bigRequest({ effects })
    const start = performance.now()
    const result: AnalysisResult = analyze(req)
    const elapsed = performance.now() - start
    expect(findTable(result.nodes, 'Parameter Estimates')!.rows).toHaveLength(12)
    expect(elapsed).toBeLessThan(300)
  })

  it('runs stepwise on 10k rows in reasonable time', () => {
    const req = bigRequest({ effects, personality: 'stepwise', direction: 'mixed' })
    const start = performance.now()
    const result = analyze(req)
    const elapsed = performance.now() - start
    expect(findTable(result.nodes, 'Step History')!.rows.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(2000)
  })
})
