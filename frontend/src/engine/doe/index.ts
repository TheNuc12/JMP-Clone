// Design of experiments (port of backend/app/doe.py and doe_designs.py).

import type { DoeRequest, DoeResult } from '../../api/types'
import { NotPortedError } from '../errors'

/** Thrown for design requests that can't be satisfied (the reference API's HTTP 400). */
export class DoeError extends Error {}

export function makeDesign(req: DoeRequest): DoeResult {
  void req
  throw new NotPortedError('doe.makeDesign')
}
