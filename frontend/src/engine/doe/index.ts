// Design of experiments (port of backend/app/doe.py): full factorial, fractional factorial,
// response surface and custom designs.
//
// Continuous factors are coded -1/+1 at their low/high settings; table values are decoded
// back to the factor's units. Replicates repeat the design's non-center runs; center points
// (continuous factors at their midpoint, categorical factors cycling through their levels)
// are added once. The Pattern column uses '-' / '+' for low / high, '0' for center, 'a' / 'A'
// for axial low / high, and 1-9, A-Z for categorical levels.

import type { CellFormat, ColumnData, DataTablePayload, DoeRequest, DoeResponse, DoeResult, ReportNode } from '../../api/types'
import { SeedSequence, defaultRng, type Generator } from '../math/random'
import { npRound, pyRound } from '../pyformat'
import * as r from '../report'
import * as d from './designs'

/** Thrown for design requests that can't be satisfied (the reference API's HTTP 400). */
export class DoeError extends Error {}

const MAX_RUNS = 5000
const MAX_FULL_FACTORIAL_FACTORS = 12
const MAX_CUSTOM_RUNS = 1000

const DESIGN_NAMES: Record<DoeRequest['design'], string> = {
  full_factorial: 'Full Factorial',
  fractional_factorial: 'Screening',
  response_surface: 'Response Surface',
  custom: 'Custom Design',
}

type SummaryItem = [string, unknown] | [string, unknown, CellFormat]

interface Built {
  runs: d.Runs
  effects: d.Effect[]
  info: SummaryItem[]
  extra: ReportNode[]
}

/** The request with the reference API's defaults filled in. */
type Request = Required<Omit<DoeRequest, 'seed' | 'resolution' | 'model' | 'n_runs'>> & Pick<DoeRequest, 'seed' | 'resolution' | 'model' | 'n_runs'>

/** Python's repr() of a string (used in a validation message). */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote
}

// ------------------------------------------------------------------- validation

function factorsOf(req: Request): d.Factor[] {
  if (!req.factors.length) throw new DoeError('Add at least one factor.')
  const factors: d.Factor[] = []
  const seen = new Set<string>()
  for (const f of req.factors) {
    const name = f.name.trim()
    if (!name) throw new DoeError('Every factor needs a name.')
    if (seen.has(name.toLowerCase())) throw new DoeError(`Factor names must be unique ('${name}' is used twice).`)
    if (name.toLowerCase() === 'pattern') throw new DoeError("'Pattern' is reserved for the pattern column; rename the factor.")
    seen.add(name.toLowerCase())
    if (f.kind === 'continuous') {
      const low = f.low ?? -1
      const high = f.high ?? 1
      if (!(Number.isFinite(low) && Number.isFinite(high)) || low >= high) {
        throw new DoeError(`Factor '${name}': the low setting must be below the high setting.`)
      }
      factors.push({ name, continuous: true, low, high, levels: [] })
    } else {
      const levels = (f.levels ?? []).map((lv) => lv.trim()).filter((lv) => lv)
      if (new Set(levels).size !== levels.length) throw new DoeError(`Factor '${name}' lists the same level twice.`)
      if (levels.length < 2) throw new DoeError(`Categorical factor '${name}' needs at least 2 levels.`)
      factors.push({ name, continuous: false, low: -1, high: 1, levels })
    }
  }
  return factors
}

function responsesOf(req: Request, factorNames: Set<string>): string[] {
  const names = req.responses.map((resp) => resp.name.trim())
  if (!names.length) throw new DoeError('Add at least one response.')
  const seen = new Set<string>()
  for (const name of names) {
    if (!name) throw new DoeError('Every response needs a name.')
    const lower = name.toLowerCase()
    if (seen.has(lower) || factorNames.has(lower) || lower === 'pattern') throw new DoeError(`Response name '${name}' is already used.`)
    seen.add(lower)
  }
  return names
}

const compareEffects = (a: d.Effect, b: d.Effect) => {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Model effects as factor-index tuples, by degree then factor order; defaults to main effects. */
function effectsOf(model: string[][] | null | undefined, factors: d.Factor[]): d.Effect[] {
  if (!model || !model.length) return factors.map((_, i) => [i])
  const index = new Map(factors.map((f, i) => [f.name.toLowerCase(), i]))
  const effects: d.Effect[] = []
  for (const effect of model) {
    if (!effect.length) continue
    const term = effect
      .map((name) => {
        const key = name.trim().toLowerCase()
        const i = index.get(key)
        if (i === undefined) throw new DoeError(`The model uses an unknown factor ${pyRepr(key)}.`)
        return i
      })
      .sort((a, b) => a - b)
    for (const i of new Set(term)) {
      const count = term.filter((t) => t === i).length
      if (count > 1 && !factors[i].continuous) throw new DoeError(`Categorical factor '${factors[i].name}' can't appear twice in one effect.`)
      if (count > 2) throw new DoeError('Model effects can use a factor at most twice (quadratic).')
    }
    if (!effects.some((e) => compareEffects(e, term) === 0)) effects.push(term)
  }
  return effects.sort(compareEffects)
}

function twoFactorEffects(k: number): d.Effect[] {
  const out: d.Effect[] = []
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) out.push([i, j])
  return out
}

// ----------------------------------------------------------------------- designs

function checkRuns(n: number): void {
  if (n > MAX_RUNS) throw new DoeError(`The design would have ${n} runs; the limit is ${MAX_RUNS}.`)
}

function withReplicates(base: d.Runs, centers: d.Runs, replicates: number): d.Runs {
  const runs = base.repeat(replicates + 1).extend(centers)
  checkRuns(runs.length)
  return runs
}

const anyContinuous = (factors: d.Factor[]) => factors.some((f) => f.continuous)

function fullFactorial(req: Request, factors: d.Factor[]): Built {
  if (factors.length > MAX_FULL_FACTORIAL_FACTORS) {
    throw new DoeError(`Full factorial designs support up to ${MAX_FULL_FACTORIAL_FACTORS} factors; try a screening design.`)
  }
  const size = factors.reduce((acc, f) => acc * d.nLevels(f), 1)
  checkRuns(size * (req.replicates + 1) + req.center_points)
  const cube = d.fullFactorial(factors)
  if (req.center_points && !anyContinuous(factors)) throw new DoeError('Center points need at least one continuous factor.')
  const centers = d.centerPoints(factors, req.center_points)
  const k = factors.length
  const effects = [...factors.map((_, i) => [i]), ...twoFactorEffects(k)]
  return { runs: withReplicates(cube, centers, req.replicates), effects, info: [['Design', 'Full factorial', 'text']], extra: [] }
}

function fractional(req: Request, factors: d.Factor[]): Built {
  const k = factors.length
  if (k < 2) throw new DoeError('Screening designs need at least 2 factors.')
  if (k > d.MAX_FRACTIONAL_FACTORS) throw new DoeError(`Screening designs support up to ${d.MAX_FRACTIONAL_FACTORS} factors.`)
  for (const f of factors) {
    if (d.nLevels(f) !== 2) throw new DoeError(`Screening designs use 2-level factors; '${f.name}' has ${d.nLevels(f)} levels.`)
  }
  const resolution = req.resolution ?? null
  if (resolution !== null && ![3, 4, 5].includes(resolution)) throw new DoeError('Resolution must be III, IV or V.')
  let fraction: d.Fraction
  try {
    fraction = d.chooseFraction(k, resolution)
  } catch (e) {
    throw new DoeError((e as Error).message)
  }
  if (req.center_points && !anyContinuous(factors)) throw new DoeError('Center points need at least one continuous factor.')
  const cube = d.fractionRuns(fraction, factors)
  const centers = d.centerPoints(factors, req.center_points)
  const names = factors.map((f) => f.name)
  const effects: d.Effect[] = factors.map((_, i) => [i])
  const full = fraction.generators.length === 0
  if (full || fraction.resolution >= 5) effects.push(...twoFactorEffects(k))
  const info: SummaryItem[] = [
    ['Design', full ? 'Full factorial' : `2^(${k}-${fraction.generators.length}) fractional factorial`, 'text'],
    ['Resolution', full ? 'Full' : d.roman(fraction.resolution), 'text'],
  ]
  const extra: ReportNode[] = []
  if (!full) {
    extra.push(r.outline('Design Generators', d.generatorText(fraction, names).map((line) => r.text(line, 'equation'))))
    extra.push(
      r.outline('Alias Structure', [
        r.table(
          [
            ['Effect', 'text'],
            ['Aliases (up to two-factor interactions)', 'text'],
          ],
          d.aliasStructure(fraction, names).map(([e, a]) => [e, a || '—']),
        ),
        r.text('Higher-order interactions are assumed negligible.'),
      ]),
    )
  }
  return { runs: withReplicates(cube, centers, req.replicates), effects, info, extra }
}

function responseSurface(req: Request, factors: d.Factor[]): Built {
  const k = factors.length
  if (factors.some((f) => !f.continuous)) throw new DoeError('Response surface designs use continuous factors only.')
  const effects: d.Effect[] = [...factors.map((_, i) => [i]), ...twoFactorEffects(k), ...factors.map((_, i) => [i, i])]
  if (req.rsm_type === 'box_behnken') {
    if (!d.BBD_FACTORS.has(k)) throw new DoeError('Box-Behnken designs support 3 to 7 factors.')
    const base = d.boxBehnken(factors)
    const centers = d.centerPoints(factors, req.center_points)
    return { runs: withReplicates(base, centers, req.replicates), effects, info: [['Design', 'Box-Behnken', 'text']], extra: [] }
  }
  if (!(k >= 2 && k <= d.MAX_CCD_FACTORS)) throw new DoeError(`Central composite designs support 2 to ${d.MAX_CCD_FACTORS} factors.`)
  const { base, centers, alpha, cube } = d.ccd(factors, req.ccd_alpha, req.center_points)
  const label = { rotatable: 'rotatable', orthogonal: 'orthogonal', face_centered: 'face-centered' }[req.ccd_alpha]
  const info: SummaryItem[] = [
    ['Design', `Central composite (${label})`, 'text'],
    ['Axial value (alpha)', pyRound(alpha, 4)],
    ['Cube runs', cube.runs, 'integer'],
  ]
  return { runs: withReplicates(base, centers, req.replicates), effects, info, extra: [] }
}

function custom(req: Request, factors: d.Factor[], rng: Generator): Built {
  const effects = effectsOf(req.model, factors)
  const p = d.nParameters(factors, effects)
  const nRuns = req.n_runs ?? p + 4
  if (nRuns < p) throw new DoeError(`The model has ${p} parameters, so the design needs at least ${p} runs.`)
  if (nRuns > MAX_CUSTOM_RUNS) throw new DoeError(`Custom designs support up to ${MAX_CUSTOM_RUNS} runs.`)
  if (req.center_points && !anyContinuous(factors)) throw new DoeError('Center points need at least one continuous factor.')
  const coded = d.coordinateExchange(factors, effects, nRuns, rng)
  const base = d.makeRuns(coded, factors)
  const centers = d.centerPoints(factors, req.center_points)
  const info: SummaryItem[] = [
    ['Design', 'D-optimal (coordinate exchange)', 'text'],
    ['Model parameters', p, 'integer'],
  ]
  const extra: ReportNode[] = []
  const { labels, corr } = d.correlations(coded, factors, effects)
  if (labels.length > 1 && labels.length <= 24) {
    extra.push(
      r.outline(
        'Correlations of Model Terms',
        [
          r.table(
            [['Term', 'text'], ...labels.map((lb): [string, CellFormat] => [lb, 'number'])],
            labels.map((lb, i) => [lb, ...corr[i]]),
          ),
        ],
        true,
      ),
    )
  }
  return { runs: withReplicates(base, centers, req.replicates), effects, info, extra }
}

// ------------------------------------------------------------------------ output

function decimals(f: d.Factor): number {
  return Math.max(0, 4 - Math.floor(Math.log10(f.high - f.low)))
}

/** Factor columns in the factors' own units (or level names). */
function decode(runs: d.Runs, factors: d.Factor[]): (number | string)[][] {
  return factors.map((f, j) => {
    if (!f.continuous) return runs.coded.map((row) => f.levels[Math.trunc(row[j])])
    const mid = (f.high + f.low) / 2
    const half = (f.high - f.low) / 2
    const digits = decimals(f)
    // round() on numpy floats: numpy's rounding (scale, round half to even, unscale).
    return runs.coded.map((row) => npRound(mid + row[j] * half, digits))
  })
}

function tableOf(name: string, runs: d.Runs, factors: d.Factor[], responses: string[], effects: d.Effect[]): DataTablePayload {
  const n = runs.length
  const columns: ColumnData[] = [{ name: 'Pattern', data_type: 'character', modeling_type: 'nominal', values: runs.patterns.slice() }]
  decode(runs, factors).forEach((values, j) => {
    const f = factors[j]
    if (f.continuous) columns.push({ name: f.name, data_type: 'numeric', modeling_type: 'continuous', values })
    else columns.push({ name: f.name, data_type: 'character', modeling_type: 'nominal', values, value_order: f.levels.slice() })
  })
  for (const resp of responses) columns.push({ name: resp, data_type: 'numeric', modeling_type: 'continuous', values: new Array(n).fill(null) })
  return {
    name,
    n_rows: n,
    columns,
    model: { responses, effects: effects.map((e) => e.map((i) => factors[i].name)) },
  }
}

function factorTable(factors: d.Factor[]): ReportNode {
  const rows = factors.map((f) =>
    f.continuous ? [f.name, 'Continuous', `${r.fmtNum(f.low, 6)} to ${r.fmtNum(f.high, 6)}`] : [f.name, 'Categorical', f.levels.join(', ')],
  )
  return r.outline('Factors', [
    r.table(
      [
        ['Factor', 'text'],
        ['Type', 'text'],
        ['Values', 'text'],
      ],
      rows,
    ),
  ])
}

const GOALS: Record<DoeResponse['goal'], string> = { maximize: 'Maximize', minimize: 'Minimize', match_target: 'Match target', none: 'None' }

export function makeDesign(input: DoeRequest): DoeResult {
  const req: Request = {
    responses: [{ name: 'Y', goal: 'maximize' }],
    replicates: 0,
    center_points: 0,
    randomize: true,
    rsm_type: 'ccd',
    ccd_alpha: 'rotatable',
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  } as Request
  req.responses = req.responses.map((resp) => ({ ...resp, goal: resp.goal ?? 'maximize' }))
  const factors = factorsOf(req)
  const responses = responsesOf(req, new Set(factors.map((f) => f.name.toLowerCase())))
  if (!(req.replicates >= 0 && req.replicates <= 20)) throw new DoeError('Replicates must be between 0 and 20.')
  if (!(req.center_points >= 0 && req.center_points <= 100)) throw new DoeError('Center points must be between 0 and 100.')
  const [designSeed, orderSeed] = new SeedSequence(req.seed ?? undefined).spawn(2)
  const designRng = defaultRng(designSeed)
  const orderRng = defaultRng(orderSeed)

  const built =
    req.design === 'full_factorial'
      ? fullFactorial(req, factors)
      : req.design === 'fractional_factorial'
        ? fractional(req, factors)
        : req.design === 'response_surface'
          ? responseSurface(req, factors)
          : custom(req, factors, designRng)
  let { runs } = built
  const { effects, info, extra } = built

  if (req.randomize) {
    const order = orderRng.permutation(runs.length)
    runs = new d.Runs(
      order.map((i) => runs.coded[i]),
      order.map((i) => runs.patterns[i]),
    )
  }

  const name = `DOE ${DESIGN_NAMES[req.design]}`
  const table = tableOf(name, runs, factors, responses, effects)
  const modelText = effects.map((e) => d.effectLabel(e, factors)).join(', ')

  const summary: SummaryItem[] = [
    ...info,
    ['Factors', factors.length, 'integer'],
    ['Runs', runs.length, 'integer'],
    ['Replicates', req.replicates, 'integer'],
    ['Center points', req.center_points, 'integer'],
    ['Run order', req.randomize ? 'Randomized' : 'Standard', 'text'],
  ]
  const diag = d.diagnose(runs.coded, factors, effects)
  const diagChildren: ReportNode[] = diag
    ? [
        r.summary([
          ['D Efficiency', diag.dEfficiency],
          ['G Efficiency', diag.gEfficiency],
          ['A Efficiency', diag.aEfficiency],
          ['Average Variance of Prediction', diag.averageVariance],
        ]),
        r.text(`For the model: ${modelText}`),
      ]
    : [r.warning(`The model (${modelText}) cannot be estimated from this design.`)]
  const isClosed = (n: ReportNode) => n.type === 'outline' && n.closed
  const nodes: ReportNode[] = [
    r.outline(name, [
      r.outline('Design', [r.summary(summary)]),
      factorTable(factors),
      r.outline('Responses', [
        r.table(
          [
            ['Response', 'text'],
            ['Goal', 'text'],
          ],
          req.responses.map((resp) => [resp.name.trim(), GOALS[resp.goal]]),
        ),
      ]),
      // Open sections (generators, aliases) come before the diagnostics, closed ones after.
      ...extra.filter((n) => !isClosed(n)),
      r.outline('Design Diagnostics', diagChildren),
      ...extra.filter(isClosed),
    ]),
  ]
  return { table, nodes }
}
