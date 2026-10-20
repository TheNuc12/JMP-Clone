import type { AnalysisResult, AnalyzeRequest, DataTablePayload, DoeRequest, DoeResult, SampleInfo } from './types'
import type { Method } from '../engine'
import EngineWorker from '../engine/worker?worker&inline'

export class ApiError extends Error {}

interface Pending {
  method: Method
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
/** Set when this browser can't run the engine in a worker; calls then run on the page. */
let workerFailed = false
let nextId = 1
const pending = new Map<number, Pending>()

async function callOnPage(method: Method, args: unknown[]): Promise<unknown> {
  const { callEngine, errorMessage } = await import('../engine')
  try {
    return await callEngine(method, args)
  } catch (error) {
    throw new ApiError(errorMessage(method, error))
  }
}

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker
  try {
    worker = new EngineWorker()
  } catch {
    workerFailed = true
    return null
  }
  // If the worker can't run, finish its calls on the page and stop using workers.
  worker.onerror = (event) => {
    event.preventDefault()
    worker?.terminate()
    worker = null
    workerFailed = true
    for (const call of pending.values()) callOnPage(call.method, call.args).then(call.resolve, call.reject)
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const call = pending.get(event.data.id)
    if (!call) return
    pending.delete(event.data.id)
    if (event.data.ok) call.resolve(event.data.result)
    else call.reject(new ApiError(event.data.error))
  }
  return worker
}

async function call<T>(method: Method, args: unknown[], signal?: AbortSignal): Promise<T> {
  const w = getWorker()
  if (!w) return (await callOnPage(method, args)) as T
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { method, args, resolve: resolve as (value: unknown) => void, reject })
    // An aborted call still finishes in the worker; its result is just dropped.
    signal?.addEventListener('abort', () => {
      pending.delete(id)
      reject(new DOMException('Aborted', 'AbortError'))
    })
    w.postMessage({ id, method, args })
  })
}

export const api = {
  samples: () => call<SampleInfo[]>('samples', []),

  sample: (id: string) => call<DataTablePayload>('sample', [id]),

  upload: async (file: File) => call<DataTablePayload>('upload', [file.name, new Uint8Array(await file.arrayBuffer())]),

  analyze: (req: AnalyzeRequest, signal?: AbortSignal) => call<AnalysisResult>('analyze', [req], signal),

  doe: (req: DoeRequest) => call<DoeResult>('doe', [req]),
}
