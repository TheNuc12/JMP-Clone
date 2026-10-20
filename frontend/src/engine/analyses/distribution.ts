import type { AnalysisResult } from '../../api/types'
import { NotPortedError } from '../errors'

export function continuous(...args: unknown[]): AnalysisResult {
  void args
  throw new NotPortedError('distribution.continuous')
}

export function categorical(...args: unknown[]): AnalysisResult {
  void args
  throw new NotPortedError('distribution.categorical')
}

