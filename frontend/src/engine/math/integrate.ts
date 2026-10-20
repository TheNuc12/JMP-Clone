// Adaptive Gauss–Kronrod quadrature (the QUADPACK QAG/QAGI approach behind
// scipy.integrate.quad), with infinite limits handled by a change of variables.

// 21-point Kronrod rule and its embedded 10-point Gauss rule on [−1, 1] (QUADPACK qk21).
const XGK = [
  0.995657163025808080735527280689003, 0.973906528517171720077964012084452, 0.930157491355708226001207180059508,
  0.865063366688984510732096688423493, 0.780817726586416897063717578345042, 0.679409568299024406234327365114874,
  0.562757134668604683339000099272694, 0.433395394129247190799265943165784, 0.294392862701460198131126603103866,
  0.14887433898163121088482600112972, 0,
]
const WGK = [
  0.011694638867371874278064396062192, 0.03255816230796472747881897245939, 0.05475589657435199603138130024458,
  0.07503967481091995276704314091619, 0.093125454583697605535065465083366, 0.109387158802297641899210590325805,
  0.123491976262065851077958109831074, 0.134709217311473325928054001771707, 0.142775938577060080797094273138717,
  0.14773910490133849137484151597207, 0.149445554002916905664936468389821,
]
const WG = [0.066671344308688137593568809893332, 0.149451349150580593145776339657697, 0.219086362515982043995534934228163, 0.269266719309996355091226921569469, 0.295524224714752870173892994651338]

interface Segment {
  a: number
  b: number
  value: number
  error: number
  /** ∫|f − mean|, used for QUADPACK's first-panel acceptance test. */
  resasc: number
}

const EPMACH = 2.220446049250313e-16
const UFLOW = 2.2250738585072014e-308

/** One 21-point Kronrod panel with QUADPACK's (deliberately conservative) error estimate. */
function kronrod21(f: (x: number) => number, a: number, b: number): Segment {
  const center = 0.5 * (a + b)
  const half = 0.5 * (b - a)
  const fc = f(center)
  const f1: number[] = []
  const f2: number[] = []
  let resk = WGK[10] * fc
  let resg = 0
  let resabs = Math.abs(resk)
  for (let j = 0; j < 10; j++) {
    const dx = half * XGK[j]
    const v1 = f(center - dx)
    const v2 = f(center + dx)
    f1.push(v1)
    f2.push(v2)
    resk += WGK[j] * (v1 + v2)
    resabs += WGK[j] * (Math.abs(v1) + Math.abs(v2))
    if (j % 2 === 1) resg += WG[(j - 1) / 2] * (v1 + v2)
  }
  const mean = resk * 0.5
  let resasc = WGK[10] * Math.abs(fc - mean)
  for (let j = 0; j < 10; j++) resasc += WGK[j] * (Math.abs(f1[j] - mean) + Math.abs(f2[j] - mean))
  const width = Math.abs(half)
  resabs *= width
  resasc *= width
  let error = Math.abs((resk - resg) * half)
  if (resasc !== 0 && error !== 0) error = resasc * Math.min(1, Math.pow((200 * error) / resasc, 1.5))
  if (resabs > UFLOW / (50 * EPMACH)) error = Math.max(50 * EPMACH * resabs, error)
  return { a, b, value: resk * half, error, resasc }
}

export interface QuadOptions {
  epsabs?: number
  epsrel?: number
  /** Maximum number of subintervals. */
  limit?: number
}

export interface QuadResult {
  value: number
  /** Estimated absolute error. */
  error: number
}

/**
 * ∫ₐᵇ f(x) dx. Bisects the subinterval with the largest error estimate until the total
 * error is below max(epsabs, epsrel |I|). Infinite limits map onto finite ones:
 * [a, ∞) via x = a + t/(1 − t), (−∞, b] via x = b − t/(1 − t), (−∞, ∞) via x = t/(1 − t²).
 */
export function quad(f: (x: number) => number, a: number, b: number, options: QuadOptions = {}): QuadResult {
  const { epsabs = 1.49e-8, epsrel = 1.49e-8, limit = 200 } = options
  if (a === b) return { value: 0, error: 0 }
  if (a > b) {
    const r = quad(f, b, a, options)
    return { value: -r.value, error: r.error }
  }
  if (a === -Infinity && b === Infinity) {
    return adapt((t) => (Math.abs(t) >= 1 ? 0 : f(t / (1 - t * t)) * ((1 + t * t) / ((1 - t * t) * (1 - t * t)))), -1, 1, epsabs, epsrel, limit)
  }
  if (b === Infinity) return adapt((t) => (t >= 1 ? 0 : f(a + t / (1 - t)) / ((1 - t) * (1 - t))), 0, 1, epsabs, epsrel, limit)
  if (a === -Infinity) return adapt((t) => (t >= 1 ? 0 : f(b - t / (1 - t)) / ((1 - t) * (1 - t))), 0, 1, epsabs, epsrel, limit)
  return adapt(f, a, b, epsabs, epsrel, limit)
}

function adapt(f: (x: number) => number, a: number, b: number, epsabs: number, epsrel: number, limit: number): QuadResult {
  const first = kronrod21(f, a, b)
  const segments = [first]
  let value = first.value
  let error = first.error
  // Like QUADPACK, never accept the first panel when its Gauss and Kronrod estimates
  // disagree badly (error == resasc): a narrow peak may sit between the nodes.
  let distrust = first.error === first.resasc && first.error !== 0
  while (segments.length < limit && (distrust || error > Math.max(epsabs, epsrel * Math.abs(value)))) {
    distrust = false
    // Split the worst segment.
    let worst = 0
    for (let i = 1; i < segments.length; i++) if (segments[i].error > segments[worst].error) worst = i
    const s = segments[worst]
    const mid = 0.5 * (s.a + s.b)
    if (mid <= s.a || mid >= s.b) break // cannot subdivide further in floating point
    const left = kronrod21(f, s.a, mid)
    const right = kronrod21(f, mid, s.b)
    segments[worst] = left
    segments.push(right)
    value += left.value + right.value - s.value
    error += left.error + right.error - s.error
  }
  // Re-sum to shed the rounding accumulated by the running updates.
  value = 0
  error = 0
  for (const s of segments) {
    value += s.value
    error += s.error
  }
  return { value, error }
}

/** Gauss–Legendre nodes and weights on [−1, 1] (Newton iteration on Pₙ). */
export function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const nodes = new Array<number>(n)
  const weights = new Array<number>(n)
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let derivative = 0
    for (let iter = 0; iter < 100; iter++) {
      let p1 = 1
      let p2 = 0
      for (let j = 1; j <= n; j++) {
        const p3 = p2
        p2 = p1
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j
      }
      derivative = (n * (z * p1 - p2)) / (z * z - 1)
      const previous = z
      z = previous - p1 / derivative
      if (Math.abs(z - previous) < 1e-16) break
    }
    nodes[i] = -z
    nodes[n - 1 - i] = z
    weights[i] = weights[n - 1 - i] = 2 / ((1 - z * z) * derivative * derivative)
  }
  return { nodes, weights }
}
