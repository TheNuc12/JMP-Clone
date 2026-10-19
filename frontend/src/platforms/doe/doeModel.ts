// Editable design settings for the DOE dialog, with validation, run-count previews and the
// request sent to /api/doe. Run-count previews mirror backend/app/doe_designs.py.

import type { DesignType, DoeRequest, DoeResponse } from '../../api/types'

export interface FactorDraft {
  id: string
  name: string
  kind: 'continuous' | 'categorical'
  low: string
  high: string
  /** Comma-separated level names (categorical). */
  levels: string
}

export interface ResponseDraft {
  id: string
  name: string
  goal: DoeResponse['goal']
}

export interface DesignDraft {
  design: DesignType
  factors: FactorDraft[]
  responses: ResponseDraft[]
  replicates: number
  centerPoints: number
  randomize: boolean
  /** Blank means a fresh random seed. */
  seed: string
  /** Screening resolution; null picks the smallest design with resolution IV when possible. */
  resolution: number | null
  rsmType: 'ccd' | 'box_behnken'
  ccdAlpha: 'rotatable' | 'orthogonal' | 'face_centered'
  /** Custom design terms beyond main effects, as keys of factor ids (see termKey). */
  extraTerms: string[]
  /** Blank means the default (parameters + 4). */
  nRuns: string
}

export const DESIGN_TITLES: Record<DesignType, string> = {
  full_factorial: 'Full Factorial Design',
  fractional_factorial: 'Screening Design',
  response_surface: 'Response Surface Design',
  custom: 'Custom Design',
}

export const DESIGN_DESCRIPTIONS: Record<DesignType, string> = {
  full_factorial: 'Every combination of factor levels. Continuous factors run at their low and high settings.',
  fractional_factorial: 'A two-level fractional factorial that screens many factors in few runs.',
  response_surface: 'Central composite or Box-Behnken designs for fitting curvature and finding optima.',
  custom: 'A D-optimal design for the model you specify, in the number of runs you choose.',
}

let nextId = 1
const newId = () => `d${nextId++}`

export function newFactor(kind: FactorDraft['kind'], taken: string[], levelCount = 3): FactorDraft {
  let i = 1
  while (taken.includes(`X${i}`)) i++
  const levels = Array.from({ length: levelCount }, (_, j) => `L${j + 1}`).join(', ')
  return { id: newId(), name: `X${i}`, kind, low: '-1', high: '1', levels }
}

export function newResponse(taken: string[]): ResponseDraft {
  let name = 'Y'
  for (let i = 2; taken.includes(name); i++) name = `Y${i}`
  return { id: newId(), name, goal: 'maximize' }
}

const DEFAULT_FACTOR_COUNT: Record<DesignType, number> = {
  full_factorial: 3,
  fractional_factorial: 5,
  response_surface: 3,
  custom: 3,
}

export function defaultDraft(design: DesignType): DesignDraft {
  const factors: FactorDraft[] = []
  for (let i = 0; i < DEFAULT_FACTOR_COUNT[design]; i++) factors.push(newFactor('continuous', factors.map((f) => f.name)))
  const draft: DesignDraft = {
    design,
    factors,
    responses: [newResponse([])],
    replicates: 0,
    centerPoints: 0,
    randomize: true,
    seed: '',
    resolution: null,
    rsmType: 'ccd',
    ccdAlpha: 'rotatable',
    extraTerms: [],
    nRuns: '',
  }
  return { ...draft, centerPoints: defaultCenterPoints(draft) }
}

// Center points for uniform precision CCDs (Myers & Montgomery); 3 for Box-Behnken.
const CCD_CENTER_DEFAULT: Record<number, number> = { 2: 5, 3: 6, 4: 7, 5: 6, 6: 9, 7: 14, 8: 20 }

export function defaultCenterPoints(draft: Pick<DesignDraft, 'design' | 'factors' | 'rsmType'>): number {
  if (draft.design !== 'response_surface') return 0
  if (draft.rsmType === 'box_behnken') return 3
  return CCD_CENTER_DEFAULT[draft.factors.length] ?? 5
}

export function parseLevels(levels: string): string[] {
  return levels
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

function levelCount(f: FactorDraft): number {
  return f.kind === 'continuous' ? 2 : parseLevels(f.levels).length
}

// ------------------------------------------------------------------ model terms

/** Key of a model term: factor ids joined by '*' (a repeated id is a square). */
export function termKey(ids: string[]): string {
  return ids.join('*')
}

export interface CandidateTerm {
  key: string
  ids: string[]
  label: string
  group: 'interaction' | 'quadratic'
}

/** Terms the custom model can add to the main effects. */
export function candidateTerms(factors: FactorDraft[]): CandidateTerm[] {
  const out: CandidateTerm[] = []
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const ids = [factors[i].id, factors[j].id]
      out.push({ key: termKey(ids), ids, label: `${factors[i].name}*${factors[j].name}`, group: 'interaction' })
    }
  }
  for (const f of factors) {
    if (f.kind !== 'continuous') continue
    const ids = [f.id, f.id]
    out.push({ key: termKey(ids), ids, label: `${f.name}*${f.name}`, group: 'quadratic' })
  }
  return out
}

/** Model effects (as factor names) for a custom design: main effects plus chosen terms. */
export function customModel(draft: DesignDraft): string[][] {
  const byId = new Map(draft.factors.map((f) => [f.id, f]))
  const extras = candidateTerms(draft.factors).filter((t) => draft.extraTerms.includes(t.key))
  return [...draft.factors.map((f) => [f.name]), ...extras.map((t) => t.ids.map((id) => byId.get(id)!.name))]
}

/** Number of model parameters, counting categorical factors as levels - 1 columns. */
export function parameterCount(draft: DesignDraft): number {
  const byName = new Map(draft.factors.map((f) => [f.name, f]))
  let p = 1
  for (const effect of customModel(draft)) {
    let size = 1
    for (const name of new Set(effect)) {
      const f = byName.get(name)
      if (f && f.kind === 'categorical') size *= Math.max(1, levelCount(f) - 1)
    }
    p += size
  }
  return p
}

// -------------------------------------------------------------- run previews

/** Regular two-level designs by factor count: [runs, resolution]; 99 = full factorial. */
const SCREENING: Record<number, [number, number][]> = {
  2: [[4, 99]],
  3: [[4, 3], [8, 99]],
  4: [[8, 4], [16, 99]],
  5: [[8, 3], [16, 5], [32, 99]],
  6: [[8, 3], [16, 4], [32, 6], [64, 99]],
  7: [[8, 3], [16, 4], [32, 4], [64, 7], [128, 99]],
  8: [[16, 4], [32, 4], [64, 5], [128, 8], [256, 99]],
  9: [[16, 3], [32, 4], [64, 4], [128, 6], [512, 99]],
  10: [[16, 3], [32, 4], [64, 4], [128, 5], [1024, 99]],
  11: [[16, 3], [32, 4], [64, 4], [128, 5], [2048, 99]],
  12: [[16, 3], [32, 4], [64, 4], [128, 4], [4096, 99]],
  13: [[16, 3], [32, 4], [64, 4], [128, 4]],
  14: [[16, 3], [32, 4], [64, 4], [128, 4]],
  15: [[16, 3], [32, 4], [64, 4], [128, 4]],
}

/** The screening design the backend will pick: [runs, resolution], or null if none qualifies. */
export function screeningChoice(k: number, resolution: number | null): [number, number] | null {
  const options = SCREENING[k] ?? []
  const wanted = resolution ?? 4
  const match = options.find(([, res]) => res >= wanted)
  if (match) return match
  return resolution === null && options.length ? options[0] : null
}

const CCD_CUBE: Record<number, number> = { 2: 4, 3: 8, 4: 16, 5: 16, 6: 32, 7: 64, 8: 64 }
const BBD_RUNS: Record<number, number> = { 3: 12, 4: 24, 5: 40, 6: 48, 7: 56 }

/** Runs the design will have (before validation), or null when it can't be predicted. */
export function previewRuns(draft: DesignDraft): number | null {
  const k = draft.factors.length
  let base: number | null
  switch (draft.design) {
    case 'full_factorial':
      base = draft.factors.reduce((n, f) => n * Math.max(1, levelCount(f)), 1)
      break
    case 'fractional_factorial':
      base = screeningChoice(k, draft.resolution)?.[0] ?? null
      break
    case 'response_surface':
      base = draft.rsmType === 'box_behnken' ? (BBD_RUNS[k] ?? null) : CCD_CUBE[k] ? CCD_CUBE[k] + 2 * k : null
      break
    case 'custom': {
      const n = Number(draft.nRuns)
      base = draft.nRuns.trim() && Number.isInteger(n) ? n : parameterCount(draft) + 4
      break
    }
  }
  return base === null ? null : base * (draft.replicates + 1) + draft.centerPoints
}

// ------------------------------------------------------------------ validation

export function roman(n: number): string {
  return ({ 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' } as Record<number, string>)[n] ?? String(n)
}

/** Problems that stop the design from being made, in plain words. */
export function validate(draft: DesignDraft): string[] {
  const errors: string[] = []
  const { factors, responses, design } = draft
  const k = factors.length
  if (k === 0) errors.push('Add at least one factor.')
  if (responses.length === 0) errors.push('Add at least one response.')
  const names = [...factors.map((f) => f.name.trim()), ...responses.map((r) => r.name.trim())]
  if (names.some((n) => n === '')) errors.push('Every factor and response needs a name.')
  const lower = names.filter(Boolean).map((n) => n.toLowerCase())
  const dupes = [...new Set(lower.filter((n, i) => lower.indexOf(n) !== i))]
  if (dupes.length) errors.push(`Names must be unique: ${dupes.join(', ')}.`)
  if (lower.includes('pattern')) errors.push("'Pattern' is reserved for the pattern column.")
  for (const f of factors) {
    const label = f.name.trim() || 'A factor'
    if (f.kind === 'continuous') {
      const low = Number(f.low)
      const high = Number(f.high)
      if (f.low.trim() === '' || f.high.trim() === '' || !Number.isFinite(low) || !Number.isFinite(high)) {
        errors.push(`${label}: low and high must be numbers.`)
      } else if (low >= high) errors.push(`${label}: low must be below high.`)
    } else {
      const levels = parseLevels(f.levels)
      if (new Set(levels).size !== levels.length) errors.push(`${label}: a level is listed twice.`)
      else if (levels.length < 2) errors.push(`${label}: list at least 2 levels, separated by commas.`)
    }
  }
  const hasContinuous = factors.some((f) => f.kind === 'continuous')
  if (draft.centerPoints > 0 && !hasContinuous) errors.push('Center points need at least one continuous factor.')
  if (design === 'full_factorial' && k > 12) errors.push('Full factorial designs support up to 12 factors; try a screening design.')
  if (design === 'fractional_factorial') {
    if (k < 2 || k > 15) errors.push('Screening designs support 2 to 15 factors.')
    const multi = factors.filter((f) => levelCount(f) !== 2)
    if (multi.length) errors.push(`Screening designs use 2-level factors: ${multi.map((f) => f.name).join(', ')}.`)
    if (k >= 2 && k <= 15 && !screeningChoice(k, draft.resolution)) {
      errors.push(`No resolution ${roman(draft.resolution ?? 4)} design is available for ${k} factors.`)
    }
  }
  if (design === 'response_surface') {
    if (factors.some((f) => f.kind !== 'continuous')) errors.push('Response surface designs use continuous factors only.')
    if (draft.rsmType === 'box_behnken' && (k < 3 || k > 7)) errors.push('Box-Behnken designs support 3 to 7 factors.')
    if (draft.rsmType === 'ccd' && (k < 2 || k > 8)) errors.push('Central composite designs support 2 to 8 factors.')
  }
  if (design === 'custom') {
    const p = parameterCount(draft)
    const n = Number(draft.nRuns)
    if (draft.nRuns.trim() && (!Number.isInteger(n) || n < 1)) errors.push('Number of runs must be a whole number.')
    else if (draft.nRuns.trim() && n < p) errors.push(`The model has ${p} parameters, so the design needs at least ${p} runs.`)
  }
  const runs = previewRuns(draft)
  if (runs !== null && runs > 5000) errors.push(`The design would have ${runs} runs; the limit is 5000.`)
  return errors
}

// ------------------------------------------------------------------- request

export function toRequest(draft: DesignDraft): DoeRequest {
  const seed = Number(draft.seed)
  const req: DoeRequest = {
    design: draft.design,
    factors: draft.factors.map((f) =>
      f.kind === 'continuous'
        ? { name: f.name.trim(), kind: 'continuous', low: Number(f.low), high: Number(f.high) }
        : { name: f.name.trim(), kind: 'categorical', levels: parseLevels(f.levels) },
    ),
    responses: draft.responses.map((r) => ({ name: r.name.trim(), goal: r.goal })),
    replicates: draft.replicates,
    center_points: draft.centerPoints,
    randomize: draft.randomize,
    seed: draft.seed.trim() && Number.isInteger(seed) ? seed : null,
  }
  if (draft.design === 'fractional_factorial') req.resolution = draft.resolution
  if (draft.design === 'response_surface') {
    req.rsm_type = draft.rsmType
    req.ccd_alpha = draft.ccdAlpha
  }
  if (draft.design === 'custom') {
    req.model = customModel(draft)
    if (draft.nRuns.trim()) req.n_runs = Number(draft.nRuns)
  }
  return req
}
