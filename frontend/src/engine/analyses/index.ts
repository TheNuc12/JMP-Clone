// Analysis dispatch (port of backend/app/analyses/__init__.py).

import type { AnalysisResult, AnalyzeRequest } from '../../api/types'
import { RequestError } from '../errors'
import * as bivariate from './bivariate'
import * as capability from './capability'
import * as contingency from './contingency'
import * as controlChart from './controlChart'
import * as distribution from './distribution'
import * as fitModel from './fitModel'
import * as logistic from './logistic'
import * as oneway from './oneway'

/** A request with the defaults the reference API fills in. */
export type Request = AnalyzeRequest & { roles: NonNullable<AnalyzeRequest['roles']>; params: NonNullable<AnalyzeRequest['params']> }

export function runAnalysis(input: AnalyzeRequest): AnalysisResult {
  const req: Request = { ...input, x: input.x ?? null, roles: input.roles ?? {}, params: input.params ?? {}, options: input.options ?? {} }
  const yCont = req.y.modeling_type === 'continuous'
  if (req.platform === 'fit_model') return fitModel.analyze(req)
  if (req.platform === 'control_chart') return controlChart.analyze(req)
  if (req.platform === 'capability') return capability.analyze(req)
  if (req.platform === 'distribution') return yCont ? distribution.continuous(req.y, req.options) : distribution.categorical(req.y, req.options)

  if (!req.x) throw new RequestError('Fit Y by X needs an X column.')
  if (req.x.values.length !== req.y.values.length) throw new RequestError('X and Y must have the same number of values.')
  const xCont = req.x.modeling_type === 'continuous'
  if (yCont && xCont) return bivariate.analyze(req.y, req.x, req.options)
  if (yCont) return oneway.analyze(req.y, req.x, req.options)
  if (xCont) return logistic.analyze(req.y, req.x, req.options)
  return contingency.analyze(req.y, req.x, req.options)
}
