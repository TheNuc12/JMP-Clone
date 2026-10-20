// The statistics engine: everything the reference Python API did, in the browser.

import type { AnalyzeRequest, DoeRequest } from '../api/types'
import { runAnalysis } from './analyses'
import { DoeError, makeDesign } from './doe'
import { RequestError } from './errors'
import { parseUpload, UploadError } from './io'
import { getSample, listSamples } from './samples'

export const engine = {
  samples: () => listSamples(),
  sample: (id: string) => getSample(id),
  upload: (filename: string, content: Uint8Array) => parseUpload(filename, content),
  analyze: (req: AnalyzeRequest) => runAnalysis(req),
  doe: (req: DoeRequest) => makeDesign(req),
}

export type Engine = typeof engine
export type Method = keyof Engine

/**
 * The message shown for a failed call. Rejected requests explain themselves; anything
 * else is a bug, reported like the reference API's 500s.
 */
export function errorMessage(method: Method, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RequestError || error instanceof DoeError || error instanceof UploadError) return message
  return method === 'analyze' ? `Analysis failed: ${message}` : message
}

/** Call an engine method by name (used by the worker and the main-thread fallback). */
export async function callEngine(method: Method, args: unknown[]): Promise<unknown> {
  const fn = engine[method] as (...a: unknown[]) => unknown
  return fn(...args)
}
