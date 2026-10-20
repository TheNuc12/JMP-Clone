import type { AnalysisResult } from '../../api/types'
import { NotPortedError } from '../errors'

export function analyze(...args: unknown[]): AnalysisResult {
  void args
  throw new NotPortedError('fit_model.analyze')
}

