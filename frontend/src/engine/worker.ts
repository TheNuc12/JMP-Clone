// Web Worker running the engine, so long computations never block the page.

import { NotPortedError } from './errors'
import { callEngine, errorMessage, type Method } from './index'

interface Call {
  id: number
  method: Method
  args: unknown[]
}

self.onmessage = async (event: MessageEvent<Call>) => {
  const { id, method, args } = event.data
  try {
    self.postMessage({ id, ok: true, result: await callEngine(method, args) })
  } catch (error) {
    if (!(error instanceof NotPortedError)) console.error(error)
    self.postMessage({ id, ok: false, error: errorMessage(method, error) })
  }
}
