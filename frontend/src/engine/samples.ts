// Built-in sample tables (exported from the reference engine by backend/golden/export.py).

import type { DataTablePayload, SampleInfo } from '../api/types'
import data from './samples.json'

const samples = data as unknown as { info: SampleInfo[]; tables: Record<string, DataTablePayload> }

export function listSamples(): SampleInfo[] {
  return samples.info
}

export function getSample(id: string): DataTablePayload {
  const table = samples.tables[id]
  if (!table) throw new Error(`Unknown sample '${id}'.`)
  return table
}
