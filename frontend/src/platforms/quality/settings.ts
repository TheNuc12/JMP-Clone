// Chart-type rules, validation and spec-limit parsing for the quality dialogs.

import type { SpecLimits } from '../../api/types'
import type { Column } from '../../state/store'
import { isCategorical } from '../../state/store'

export type ChartType = 'imr' | 'xbar_r' | 'xbar_s' | 'p' | 'np' | 'c' | 'u'

export const CHART_TYPES: { value: ChartType; label: string; description: string }[] = [
  { value: 'imr', label: 'Individual & Moving Range', description: 'One measurement per row; sigma from the average moving range.' },
  { value: 'xbar_r', label: 'XBar & R', description: 'Subgroup means and ranges; sigma from the average range.' },
  { value: 'xbar_s', label: 'XBar & S', description: 'Subgroup means and standard deviations; best for larger subgroups.' },
  { value: 'p', label: 'P (proportion defective)', description: 'Fraction nonconforming per sample; sample sizes may vary.' },
  { value: 'np', label: 'NP (number defective)', description: 'Count of nonconforming units in samples of equal size.' },
  { value: 'c', label: 'C (defects)', description: 'Count of defects per inspection unit.' },
  { value: 'u', label: 'U (defects per unit)', description: 'Defects per unit when the number of units varies.' },
]

export const isVariablesChart = (t: ChartType) => t === 'imr' || t === 'xbar_r' || t === 'xbar_s'

/** Whether a column can be the Y of a chart type. */
export function acceptsY(chartType: ChartType, column: Column): boolean {
  if (!isCategorical(column.modelingType)) return true
  return chartType === 'p' || chartType === 'np'
}

export function yHint(chartType: ChartType): string {
  if (isVariablesChart(chartType)) return 'Continuous measurements'
  if (chartType === 'p' || chartType === 'np') return 'Defective counts, or a pass/fail column'
  return 'Defect counts'
}

/** Which settings a chart needs, given the assigned columns. */
export interface ChartNeeds {
  subgroupSize: boolean
  sampleSize: boolean
  defectLevel: boolean
  specLimits: boolean
}

export function chartNeeds(chartType: ChartType, y: Column | undefined, hasSubgroup: boolean, hasSampleSizeColumn: boolean): ChartNeeds {
  const categoricalY = !!y && isCategorical(y.modelingType)
  const proportion = chartType === 'p' || chartType === 'np'
  return {
    subgroupSize: !hasSubgroup && (chartType === 'xbar_r' || chartType === 'xbar_s' || (proportion && categoricalY)),
    sampleSize: !hasSampleSizeColumn && !categoricalY && (proportion || chartType === 'u'),
    defectLevel: proportion && categoricalY,
    specLimits: isVariablesChart(chartType),
  }
}

export interface LimitText {
  lsl: string
  target: string
  usl: string
}

export const EMPTY_LIMITS: LimitText = { lsl: '', target: '', usl: '' }

export function limitsToText(limits: SpecLimits | undefined): LimitText {
  const text = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return { lsl: text(limits?.lsl), target: text(limits?.target), usl: text(limits?.usl) }
}

/** Parse limit text: blank → null; returns an error for text that isn't a number or LSL ≥ USL. */
export function parseLimits(text: LimitText): { limits: SpecLimits; error: string | null } {
  const parse = (s: string) => (s.trim() === '' ? null : Number(s))
  const limits = { lsl: parse(text.lsl), target: parse(text.target), usl: parse(text.usl) }
  if ([limits.lsl, limits.target, limits.usl].some((v) => v !== null && !Number.isFinite(v))) {
    return { limits, error: 'Spec limits must be numbers.' }
  }
  if (limits.lsl !== null && limits.usl !== null && limits.lsl >= limits.usl) {
    return { limits, error: 'LSL must be below USL.' }
  }
  return { limits, error: null }
}

export function hasLimit(limits: SpecLimits): boolean {
  return (limits.lsl ?? null) !== null || (limits.usl ?? null) !== null
}

/** Spec limits as request params, leaving out blanks. */
export function limitParams(limits: SpecLimits): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of ['lsl', 'target', 'usl'] as const) {
    const v = limits[key]
    if (v !== null && v !== undefined) out[key] = v
  }
  return out
}

export interface ChartSettings {
  chartType: ChartType
  subgroupSize: string
  sampleSize: string
  defectLevel: string
  limits: LimitText
}

/** Request params for a control chart, or the first problem with the settings. */
export function buildChartParams(settings: ChartSettings, needs: ChartNeeds, ys: Column[]): { params: Record<string, unknown>; error: string | null } {
  const { chartType } = settings
  const params: Record<string, unknown> = { chart_type: chartType }
  const label = CHART_TYPES.find((t) => t.value === chartType)!.label
  const bad = ys.find((y) => !acceptsY(chartType, y))
  if (bad) return { params, error: `${label} charts need a numeric Y; ${bad.name} is categorical.` }

  if (needs.subgroupSize) {
    const n = Number(settings.subgroupSize)
    const min = isVariablesChart(chartType) ? 2 : 1
    if (!Number.isInteger(n) || n < min) return { params, error: `Subgroup size must be a whole number of at least ${min}.` }
    params.subgroup_size = n
  }
  if (needs.sampleSize) {
    const n = Number(settings.sampleSize)
    if (settings.sampleSize.trim() === '' || !Number.isFinite(n) || n <= 0) {
      return { params, error: 'Enter the sample size per row, or cast a Sample Size column.' }
    }
    params.sample_size = n
  }
  if (needs.defectLevel && settings.defectLevel) params.defect_level = settings.defectLevel
  if (needs.specLimits) {
    const { limits, error } = parseLimits(settings.limits)
    if (error) return { params, error }
    Object.assign(params, limitParams(limits))
  }
  return { params, error: null }
}
