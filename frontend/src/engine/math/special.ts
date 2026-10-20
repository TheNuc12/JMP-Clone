// Special functions (scipy.special equivalents). Double precision throughout; the
// regularized incomplete beta and gamma functions use large-parameter forms of their
// prefactors so p-values stay accurate for large degrees of freedom.

export const LOG_SQRT_2PI = 0.9189385332046728 // ln √(2π)
const EPS = 2.220446049250313e-16
const MAXLOG = 709.782712893384 // ln(largest double)
const TINY = 1e-300

// ------------------------------------------------------------------------- gamma

/** Stirling-series remainder δ(x) = lgamma(x) − [(x − ½) ln x − x + ln √(2π)], for x ≥ 10. */
export function stirlingCorrection(x: number): number {
  const r = 1 / (x * x)
  return (
    (1 / 12 + r * (-1 / 360 + r * (1 / 1260 + r * (-1 / 1680 + r * (1 / 1188 + r * (-691 / 360360 + r * (1 / 156 + r * (-3617 / 122400)))))))) / x
  )
}

/** sin(πx) with exact zeros at integers. */
function sinpi(x: number): number {
  const r = x - 2 * Math.round(x / 2) // in [-1, 1]
  if (r === 0 || Math.abs(r) === 1) return 0
  return Math.sin(Math.PI * r)
}

/** ln|Γ(x)|. */
export function gammaln(x: number): number {
  if (Number.isNaN(x)) return NaN
  if (x === Infinity) return Infinity
  if (x <= 0) {
    if (Number.isInteger(x)) return Infinity
    return Math.log(Math.PI / Math.abs(sinpi(x))) - gammaln(1 - x)
  }
  if (x < 10) {
    // Shift up to where the Stirling series is accurate: Γ(x) = Γ(x + m) / (x (x+1) … (x+m−1)).
    let prod = 1
    let y = x
    while (y < 10) {
      prod *= y
      y += 1
    }
    return gammaln(y) - Math.log(prod)
  }
  return (x - 0.5) * Math.log(x) - x + LOG_SQRT_2PI + stirlingCorrection(x)
}

/** Γ(x). */
export function gamma(x: number): number {
  if (Number.isNaN(x)) return NaN
  if (x <= 0 && Number.isInteger(x)) return NaN
  if (x > 171.7) return Infinity
  if (Number.isInteger(x) && x <= 23) {
    let f = 1
    for (let i = 2; i < x; i++) f *= i
    return f
  }
  const sign = x > 0 || Math.floor(-x) % 2 === 1 ? 1 : -1
  return sign * Math.exp(gammaln(x))
}

/** ln B(a, b), computed without cancellation when either parameter is large. */
export function betaln(a: number, b: number): number {
  if (a > b) [a, b] = [b, a]
  if (a >= 10) {
    const s = a + b
    return (
      LOG_SQRT_2PI -
      0.5 * Math.log(s) +
      (a - 0.5) * Math.log(a / s) +
      (b - 0.5) * Math.log(b / s) +
      stirlingCorrection(a) +
      stirlingCorrection(b) -
      stirlingCorrection(s)
    )
  }
  if (b >= 10) {
    // ln Γ(b) − ln Γ(a + b) by Stirling differences rather than two large logs.
    const s = a + b
    return gammaln(a) + (b - 0.5) * Math.log1p(-a / s) - a * Math.log(s) + a + stirlingCorrection(b) - stirlingCorrection(s)
  }
  return gammaln(a) + gammaln(b) - gammaln(a + b)
}

/** a ln(r) + a − a r for r = x / a, accurate both near r = 1 and far from it. */
function scaledLogTerm(a: number, x: number): number {
  const e = (x - a) / a
  return Math.abs(e) < 0.5 ? a * log1pmx(e) : a * Math.log(x / a) + a - x
}

/** log(1 + x) − x without cancellation for small x. */
export function log1pmx(x: number): number {
  if (Math.abs(x) >= 0.5) return Math.log1p(x) - x
  let term = x
  let sum = 0
  for (let n = 2; n < 200; n++) {
    term *= -x
    const add = term / n
    sum += add
    if (Math.abs(add) < EPS * Math.abs(sum)) break
  }
  return sum
}

// ------------------------------------------------------------------------- erf

// Cephes ndtr.c rational approximations.
const ERFC_P = [
  2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687, 4.86371970985681366614e1,
  1.96520832956077098242e2, 5.26445194995477358631e2, 9.3452852717195760754e2, 1.02755188689515710272e3,
  5.57535335369399327526e2,
]
const ERFC_Q = [
  1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2, 9.75708501743205489753e2,
  1.82390916687909736289e3, 2.24633760818710981792e3, 1.65666309194161350182e3, 5.57535340817727675546e2,
]
const ERFC_R = [
  5.64189583547755073984e-1, 1.27536670759978104416, 5.01905042251180477414, 6.16021097993053585195,
  7.4097426995044893916, 2.9788666537210024067,
]
const ERFC_S = [
  2.2605286322011727659, 9.39603524938001434673, 1.20489539808096656605e1, 1.70814450747565897222e1,
  9.60896809063285878198, 3.3690764510008151605,
]
const ERF_T = [9.60497373987051638749, 9.00260197203842689217e1, 2.23200534594684319226e3, 7.00332514112805075473e3, 5.55923013010394962768e4]
const ERF_U = [3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3, 2.26290000613890934246e4, 4.92673942608635921086e4]

/** Polynomial with coefficients from the highest degree down. */
function polevl(x: number, coef: number[]): number {
  let y = coef[0]
  for (let i = 1; i < coef.length; i++) y = y * x + coef[i]
  return y
}

/** Same, with an implied leading coefficient of 1. */
function p1evl(x: number, coef: number[]): number {
  let y = x + coef[0]
  for (let i = 1; i < coef.length; i++) y = y * x + coef[i]
  return y
}

/** exp(−x²) without the rounding error of squaring x first (Cephes expx2). */
function expNegSquare(x: number): number {
  const ax = Math.abs(x)
  const m = Math.round(ax * 128) / 128 // split x = m + f with m exactly representable on a coarse grid
  const f = ax - m
  const u = m * m
  const u1 = 2 * m * f + f * f
  if (u + u1 > 745) return 0
  return Math.exp(-u) * Math.exp(-u1)
}

export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN
  if (Math.abs(x) > 1) return 1 - erfc(x)
  const z = x * x
  return (x * polevl(z, ERF_T)) / p1evl(z, ERF_U)
}

export function erfc(a: number): number {
  if (Number.isNaN(a)) return NaN
  const x = Math.abs(a)
  if (x < 1) return 1 - erf(a)
  if (a * a > MAXLOG) return a < 0 ? 2 : 0
  const z = expNegSquare(a)
  const y = x < 8 ? (z * polevl(x, ERFC_P)) / p1evl(x, ERFC_Q) : (z * polevl(x, ERFC_R)) / p1evl(x, ERFC_S)
  return a < 0 ? 2 - y : y
}

/** Standard normal CDF Φ(x). */
export function ndtr(x: number): number {
  if (Number.isNaN(x)) return NaN
  const t = x * Math.SQRT1_2
  const z = Math.abs(t)
  if (z < Math.SQRT1_2) return 0.5 + 0.5 * erf(t)
  const y = 0.5 * erfc(z)
  return t > 0 ? 1 - y : y
}

// Acklam's rational approximation, refined below with Halley steps.
const ACK_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
const ACK_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
const ACK_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
const ACK_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

/** Lower-tail inverse for p ≤ 0.5 (so the residual Φ(x) − p keeps its relative precision). */
function ndtriLower(p: number): number {
  let x: number
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = polevl(q, ACK_C) / (((((ACK_D[0] * q + ACK_D[1]) * q + ACK_D[2]) * q + ACK_D[3]) * q) + 1)
  } else {
    const q = p - 0.5
    const r = q * q
    x = (polevl(r, ACK_A) * q) / (((((ACK_B[0] * r + ACK_B[1]) * r + ACK_B[2]) * r + ACK_B[3]) * r + ACK_B[4]) * r + 1)
  }
  for (let i = 0; i < 3; i++) {
    const e = ndtr(x) - p
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp(0.5 * x * x)
    const step = u / (1 + 0.5 * x * u)
    x -= step
    if (Math.abs(step) <= 1e-16 * Math.abs(x)) break
  }
  return x
}

/** Inverse of Φ. */
export function ndtri(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN
  if (p === 0) return -Infinity
  if (p === 1) return Infinity
  if (p === 0.5) return 0
  return p < 0.5 ? ndtriLower(p) : -ndtriLower(1 - p)
}

// --------------------------------------------------------------- incomplete beta

/** x^a (1−x)^b / B(a, b), with y = 1 − x passed separately to keep its precision. */
function betaPowerTerms(a: number, b: number, x: number, y: number): number {
  if (a >= 10 && b >= 10) {
    const s = a + b
    const d = x * b - y * a // x s − a
    const ta = Math.abs(d) < 0.5 * a ? a * Math.log1p(d / a) : a * Math.log((x * s) / a)
    const tb = Math.abs(d) < 0.5 * b ? b * Math.log1p(-d / b) : b * Math.log((y * s) / b)
    const t = ta + tb
    return Math.exp(t + stirlingCorrection(s) - stirlingCorrection(a) - stirlingCorrection(b)) * Math.sqrt((a * b) / (2 * Math.PI * s))
  }
  const logX = x < 0.5 ? Math.log(x) : Math.log1p(-y)
  const logY = x < 0.5 ? Math.log1p(-x) : Math.log(y)
  return Math.exp(a * logX + b * logY - betaln(a, b))
}

/** Continued fraction for I_x(a, b) (Numerical Recipes betacf, modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m <= 100000; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/**
 * Regularized incomplete beta as a pair [I_x(a, b), 1 − I_x(a, b)], each accurate in
 * relative terms; y = 1 − x may be passed when it is known more precisely than 1 − x.
 */
export function betaincPair(a: number, b: number, x: number, y = 1 - x): [number, number] {
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(x) || a <= 0 || b <= 0) return [NaN, NaN]
  if (x <= 0) return [0, 1]
  if (y <= 0) return [1, 0]
  if (x < (a + 1) / (a + b + 2)) {
    const lower = (betaPowerTerms(a, b, x, y) * betacf(a, b, x)) / a
    return [lower, 1 - lower]
  }
  const upper = (betaPowerTerms(b, a, y, x) * betacf(b, a, y)) / b
  return [1 - upper, upper]
}

/** Regularized incomplete beta I_x(a, b) (scipy.special.betainc). */
export function betainc(a: number, b: number, x: number): number {
  return betaincPair(a, b, x)[0]
}

/** Complement 1 − I_x(a, b) (scipy.special.betaincc). */
export function betaincc(a: number, b: number, x: number): number {
  return betaincPair(a, b, x)[1]
}

/** d/dx I_x(a, b) = x^(a−1) (1−x)^(b−1) / B(a, b). */
function betaDensity(a: number, b: number, x: number, y: number): number {
  return betaPowerTerms(a, b, x, y) / (x * y)
}

/**
 * Solve g(x) = 0 on [lo, hi] where g is increasing, using Newton steps with the given
 * derivative and bisection whenever a step leaves the bracket (Numerical Recipes rtsafe).
 */
export function rtsafe(g: (x: number) => number, dg: (x: number) => number, lo: number, hi: number, x0: number, xtol = 1e-15): number {
  let x = Math.min(Math.max(x0, lo), hi)
  for (let i = 0; i < 300; i++) {
    const gx = g(x)
    if (gx === 0) return x
    if (gx < 0) lo = x
    else hi = x
    const d = dg(x)
    let next = x - gx / d
    if (!(next > lo && next < hi) || !Number.isFinite(next)) next = 0.5 * (lo + hi)
    if (Math.abs(next - x) <= xtol * Math.abs(next) || hi - lo <= xtol * Math.abs(next)) return next
    x = next
  }
  return x
}

/** Solve I_x(a, b) = target (or 1 − I_x(a, b) = target when `upper`) for x. */
function betaincSolve(a: number, b: number, target: number, upper: boolean): number {
  const g = (x: number) => {
    const [lower, complement] = betaincPair(a, b, x)
    return upper ? target - complement : lower - target
  }
  return rtsafe(g, (x) => betaDensity(a, b, x, 1 - x), 0, 1, betaincGuess(a, b, upper ? 1 - target : target))
}

/** Inverse of I_x(a, b) in x (scipy.special.betaincinv). */
export function betaincinv(a: number, b: number, p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1 || a <= 0 || b <= 0) return NaN
  if (p === 0) return 0
  if (p === 1) return 1
  // Work in whichever tail keeps the residual's relative precision.
  return p <= 0.5 ? betaincSolve(a, b, p, false) : betaincSolve(a, b, 1 - p, true)
}

/** Inverse of 1 − I_x(a, b) in x (scipy.special.betainccinv), without forming 1 − q. */
export function betainccinv(a: number, b: number, q: number): number {
  if (Number.isNaN(q) || q < 0 || q > 1 || a <= 0 || b <= 0) return NaN
  if (q === 0) return 1
  if (q === 1) return 0
  return q <= 0.5 ? betaincSolve(a, b, q, true) : betaincSolve(a, b, 1 - q, false)
}

/** Starting point for betaincinv (Numerical Recipes invbetai). */
function betaincGuess(a: number, b: number, p: number): number {
  if (a >= 1 && b >= 1) {
    const pp = p < 0.5 ? p : 1 - p
    const t = Math.sqrt(-2 * Math.log(pp))
    let x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
    if (p < 0.5) x = -x
    const al = (x * x - 3) / 6
    const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1))
    const w = (x * Math.sqrt(al + h)) / h - (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h))
    return a / (a + b * Math.exp(2 * w))
  }
  const lna = Math.log(a / (a + b))
  const lnb = Math.log(b / (a + b))
  const t = Math.exp(a * lna) / a
  const u = Math.exp(b * lnb) / b
  const w = t + u
  return p < t / w ? Math.pow(a * w * p, 1 / a) : 1 - Math.pow(b * w * (1 - p), 1 / b)
}

// -------------------------------------------------------------- incomplete gamma

/** x^a e^(−x) / Γ(a), stable for large a. */
function gammaPowerTerms(a: number, x: number): number {
  if (a >= 10) return Math.exp(scaledLogTerm(a, x) - stirlingCorrection(a)) * Math.sqrt(a / (2 * Math.PI))
  return Math.exp(a * Math.log(x) - x - gammaln(a))
}

/** Gamma density x^(a−1) e^(−x) / Γ(a), stable for large a. */
export function gammaDensity(a: number, x: number): number {
  if (x <= 0) return x === 0 ? (a === 1 ? 1 : a < 1 ? Infinity : 0) : 0
  return gammaPowerTerms(a, x) / x
}

/**
 * Regularized incomplete gamma as a pair [P(a, x), Q(a, x)], each accurate in relative
 * terms (series below a + 1, continued fraction above).
 */
export function gammaincPair(a: number, x: number): [number, number] {
  if (Number.isNaN(a) || Number.isNaN(x) || a <= 0 || x < 0) return [NaN, NaN]
  if (x === 0) return [0, 1]
  if (x === Infinity) return [1, 0]
  const prefix = gammaPowerTerms(a, x)
  if (x < a + 1) {
    let ap = a
    let del = 1 / a
    let sum = del
    for (let n = 0; n < 1000000; n++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * EPS) break
    }
    const p = prefix * sum
    return [p, 1 - p]
  }
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  const q = prefix * h
  return [1 - q, q]
}

/** Regularized lower incomplete gamma P(a, x) (scipy.special.gammainc). */
export function gammainc(a: number, x: number): number {
  return gammaincPair(a, x)[0]
}

/** Regularized upper incomplete gamma Q(a, x) (scipy.special.gammaincc). */
export function gammaincc(a: number, x: number): number {
  return gammaincPair(a, x)[1]
}

/** Starting point for the gamma inverses (Numerical Recipes invgammp). */
function gammaincGuess(a: number, p: number): number {
  if (a > 1) {
    const pp = p < 0.5 ? p : 1 - p
    const t = Math.sqrt(-2 * Math.log(pp))
    let x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t
    if (p < 0.5) x = -x
    return Math.max(1e-3, a * Math.pow(1 - 1 / (9 * a) - x / (3 * Math.sqrt(a)), 3))
  }
  const t = 1 - a * (0.253 + a * 0.12)
  return p < t ? Math.pow(p / t, 1 / a) : 1 - Math.log(1 - (p - t) / (1 - t))
}

/** Solve P(a, x) = p (lower) or Q(a, x) = q (upper) for x. */
function gammaincSolve(a: number, target: number, upper: boolean): number {
  const g = (x: number) => {
    const [p, q] = gammaincPair(a, x)
    return upper ? target - q : p - target
  }
  const density = (x: number) => gammaDensity(a, x)
  // Bracket: grow the upper end until the root is inside.
  let hi = Math.max(1, gammaincGuess(a, upper ? 1 - target : target)) * 2
  while (g(hi) < 0) hi *= 2
  return rtsafe(g, density, 0, hi, gammaincGuess(a, upper ? 1 - target : target))
}

/** Inverse of P(a, ·) (scipy.special.gammaincinv). */
export function gammaincinv(a: number, p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1 || a <= 0) return NaN
  if (p === 0) return 0
  if (p === 1) return Infinity
  return p <= 0.5 ? gammaincSolve(a, p, false) : gammaincSolve(a, 1 - p, true)
}

/** Inverse of Q(a, ·) (scipy.special.gammainccinv). */
export function gammainccinv(a: number, q: number): number {
  if (Number.isNaN(q) || q < 0 || q > 1 || a <= 0) return NaN
  if (q === 0) return Infinity
  if (q === 1) return 0
  return q <= 0.5 ? gammaincSolve(a, q, true) : gammaincSolve(a, 1 - q, false)
}

// ----------------------------------------------------------------------- misc

/** Logistic sigmoid 1 / (1 + e^(−x)), evaluated exactly as scipy (and statsmodels' Logit) do. */
export function expit(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/** Log-odds log(p / (1 − p)); scipy switches to log1p differences near p = ½. */
export function logit(p: number): number {
  if (p < 0.3 || p > 0.65) return Math.log(p / (1 - p))
  const s = 2 * (p - 0.5)
  return Math.log1p(s) - Math.log1p(-s)
}

/** log Σ exp(v_i) without overflow. */
export function logsumexp(values: readonly number[]): number {
  let max = -Infinity
  for (const v of values) if (v > max) max = v
  if (max === -Infinity || max === Infinity) return max
  let sum = 0
  for (const v of values) sum += Math.exp(v - max)
  return max + Math.log(sum)
}
