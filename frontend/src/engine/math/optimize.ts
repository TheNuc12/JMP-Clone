// Root finding, BFGS minimization and finite differences (scipy.optimize and
// statsmodels.tools.numdiff equivalents, ported so results follow the same iteration paths).

export interface BrentOptions {
  xtol?: number
  rtol?: number
  maxiter?: number
}

/**
 * Brent's method for a root of f in [a, b], where f(a) and f(b) have opposite signs.
 * A port of scipy's brentq (zeros.c), so results follow the same iteration path.
 */
export function brentq(f: (x: number) => number, a: number, b: number, options: BrentOptions = {}): number {
  const { xtol = 2e-12, rtol = 8.881784197001252e-16, maxiter = 100 } = options
  let xpre = a
  let xcur = b
  let xblk = 0
  let fpre = f(xpre)
  let fcur = f(xcur)
  let fblk = 0
  let spre = 0
  let scur = 0
  if (fpre === 0) return xpre
  if (fcur === 0) return xcur
  if (Math.sign(fpre) === Math.sign(fcur)) throw new Error('f(a) and f(b) must have different signs')
  for (let i = 0; i < maxiter; i++) {
    if (fpre !== 0 && fcur !== 0 && Math.sign(fpre) !== Math.sign(fcur)) {
      xblk = xpre
      fblk = fpre
      spre = scur = xcur - xpre
    }
    if (Math.abs(fblk) < Math.abs(fcur)) {
      xpre = xcur
      xcur = xblk
      xblk = xpre
      fpre = fcur
      fcur = fblk
      fblk = fpre
    }
    const delta = (xtol + rtol * Math.abs(xcur)) / 2
    const sbis = (xblk - xcur) / 2
    if (fcur === 0 || Math.abs(sbis) < delta) return xcur
    if (Math.abs(spre) > delta && Math.abs(fcur) < Math.abs(fpre)) {
      let stry: number
      if (xpre === xblk) {
        stry = (-fcur * (xcur - xpre)) / (fcur - fpre) // interpolate
      } else {
        const dpre = (fpre - fcur) / (xpre - xcur) // extrapolate
        const dblk = (fblk - fcur) / (xblk - xcur)
        stry = (-fcur * (fblk * dblk - fpre * dpre)) / (dblk * dpre * (fblk - fpre))
      }
      if (2 * Math.abs(stry) < Math.min(Math.abs(spre), 3 * Math.abs(sbis) - delta)) {
        spre = scur
        scur = stry
      } else {
        spre = sbis
        scur = sbis
      }
    } else {
      spre = sbis
      scur = sbis
    }
    xpre = xcur
    fpre = fcur
    xcur += Math.abs(scur) > delta ? scur : sbis > 0 ? delta : -delta
    fcur = f(xcur)
  }
  return xcur
}

// ------------------------------------------------------------------ finite differences

const EPS_CBRT = 6.055454452393343e-6 // EPS ** (1 / 3), as Python computes it
const EPS_QTRT = 0.0001220703125 // EPS ** (1 / 4)

/** Centered-difference gradient (statsmodels approx_fprime with centered=True). */
export function approxFprime(x: readonly number[], f: (x: number[]) => number): number[] {
  return x.map((xk, k) => {
    const h = (EPS_CBRT * Math.max(Math.abs(xk), 0.1)) / 2
    const up = x.slice()
    const down = x.slice()
    up[k] = xk + h
    down[k] = xk - h
    return (f(up) - f(down)) / (2 * h)
  })
}

/** Finite-difference Hessian (statsmodels approx_hess / approx_hess3). */
export function approxHess(x: readonly number[], f: (x: number[]) => number): number[][] {
  const n = x.length
  const h = x.map((v) => EPS_QTRT * Math.max(Math.abs(v), 0.1))
  const at = (i: number, si: number, j: number, sj: number) =>
    f(x.map((v, m) => v + (m === i ? si * h[i] : 0) + (m === j ? sj * h[j] : 0)))
  const hess = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      hess[i][j] = (at(i, 1, j, 1) - at(i, 1, j, -1) - (at(i, -1, j, 1) - at(i, -1, j, -1))) / (4 * (h[i] * h[j]))
      hess[j][i] = hess[i][j]
    }
  }
  return hess
}

// ------------------------------------------------------------------------------ BFGS

/** Python's min/max: the first argument wins unless the second compares strictly beyond it. */
const pyMin = (a: number, b: number) => (b < a ? b : a)
const pyMax = (a: number, b: number) => (b > a ? b : a)
const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

interface StepInterval {
  stx: number
  fx: number
  dx: number
  sty: number
  fy: number
  dy: number
  stp: number
  brackt: boolean
}

/** One safeguarded cubic / quadratic step of the Moré–Thuente line search (MINPACK dcstep). */
function dcstep(s: StepInterval, fp: number, dp: number, stpmin: number, stpmax: number): void {
  const { stx, fx, dx, sty, fy, dy, stp } = s
  const sgnd = Math.sign(dp) * Math.sign(dx)
  let stpf: number
  if (fp > fx) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp
    const m = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp))
    let gamma = m * Math.sqrt((theta / m) ** 2 - (dx / m) * (dp / m))
    if (stp < stx) gamma = -gamma
    const p = gamma - dx + theta
    const q = gamma - dx + gamma + dp
    const stpc = stx + (p / q) * (stp - stx)
    const stpq = stx + (dx / ((fx - fp) / (stp - stx) + dx) / 2) * (stp - stx)
    stpf = Math.abs(stpc - stx) <= Math.abs(stpq - stx) ? stpc : stpc + (stpq - stpc) / 2
    s.brackt = true
  } else if (sgnd < 0) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp
    const m = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp))
    let gamma = m * Math.sqrt((theta / m) ** 2 - (dx / m) * (dp / m))
    if (stp > stx) gamma = -gamma
    const p = gamma - dp + theta
    const q = gamma - dp + gamma + dx
    const stpc = stp + (p / q) * (stx - stp)
    const stpq = stp + (dp / (dp - dx)) * (stx - stp)
    stpf = Math.abs(stpc - stp) > Math.abs(stpq - stp) ? stpc : stpq
    s.brackt = true
  } else if (Math.abs(dp) < Math.abs(dx)) {
    const theta = (3 * (fx - fp)) / (stp - stx) + dx + dp
    const m = Math.max(Math.abs(theta), Math.abs(dx), Math.abs(dp))
    const radicand = (theta / m) ** 2 - (dx / m) * (dp / m)
    let gamma = m * Math.sqrt(pyMax(0, radicand))
    if (stp > stx) gamma = -gamma
    const p = gamma - dp + theta
    const q = gamma + (dx - dp) + gamma
    const r = p / q
    const stpc = r < 0 && gamma !== 0 ? stp + r * (stx - stp) : stp > stx ? stpmax : stpmin
    const stpq = stp + (dp / (dp - dx)) * (stx - stp)
    if (s.brackt) {
      stpf = Math.abs(stpc - stp) < Math.abs(stpq - stp) ? stpc : stpq
      stpf = stp > stx ? pyMin(stp + 0.66 * (sty - stp), stpf) : pyMax(stp + 0.66 * (sty - stp), stpf)
    } else {
      stpf = clip(Math.abs(stpc - stp) > Math.abs(stpq - stp) ? stpc : stpq, stpmin, stpmax)
    }
  } else if (s.brackt) {
    const theta = (3 * (fp - fy)) / (sty - stp) + dy + dp
    const m = Math.max(Math.abs(theta), Math.abs(dy), Math.abs(dp))
    let gamma = m * Math.sqrt((theta / m) ** 2 - (dy / m) * (dp / m))
    if (stp > sty) gamma = -gamma
    const p = gamma - dp + theta
    const q = gamma - dp + gamma + dy
    stpf = stp + (p / q) * (sty - stp)
  } else {
    stpf = stp > stx ? stpmax : stpmin
  }
  if (fp > fx) {
    s.sty = stp
    s.fy = fp
    s.dy = dp
  } else {
    if (sgnd < 0) {
      s.sty = stx
      s.fy = fx
      s.dy = dx
    }
    s.stx = stp
    s.fx = fp
    s.dx = dp
  }
  s.stp = stpf
}

/**
 * Moré–Thuente line search for a step satisfying the strong Wolfe conditions
 * (scipy's DCSRCH port of MINPACK-2). Returns null when it fails.
 */
function dcsrch(
  phi: (a: number) => number,
  derphi: (a: number) => number,
  alpha1: number,
  phi0: number,
  derphi0: number,
  { ftol, gtol, xtol, stpmin, stpmax }: { ftol: number; gtol: number; xtol: number; stpmin: number; stpmax: number },
): { stp: number | null; phi1: number } {
  if (alpha1 < stpmin || alpha1 > stpmax || derphi0 >= 0) return { stp: null, phi1: phi0 }
  const gtest = ftol * derphi0
  let stage = 1
  let width = stpmax - stpmin
  let width1 = width / 0.5
  const s: StepInterval = { stx: 0, fx: phi0, dx: derphi0, sty: 0, fy: phi0, dy: derphi0, stp: alpha1, brackt: false }
  let stmin = 0
  let stmax = alpha1 + 4 * alpha1
  let f = phi(alpha1)
  let g = derphi(alpha1)
  for (let iter = 1; iter < 100; iter++) {
    const stp = s.stp
    const ftest = phi0 + stp * gtest
    if (stage === 1 && f <= ftest && g >= 0) stage = 2
    if (f <= ftest && Math.abs(g) <= gtol * -derphi0) return { stp, phi1: f }
    const warning =
      (s.brackt && (stp <= stmin || stp >= stmax)) || // rounding errors prevent progress
      (s.brackt && stmax - stmin <= xtol * stmax) || // xtol test satisfied
      (stp === stpmax && f <= ftest && g <= gtest) ||
      (stp === stpmin && (f > ftest || g >= gtest))
    if (warning) return { stp: null, phi1: f }
    if (stage === 1 && f <= s.fx && f > ftest) {
      // Use the modified function ψ(α) = φ(α) − φ(0) − ftol α φ'(0) until a step has ψ ≤ 0 and φ' ≥ 0.
      const m: StepInterval = { ...s, fx: s.fx - s.stx * gtest, dx: s.dx - gtest, fy: s.fy - s.sty * gtest, dy: s.dy - gtest }
      dcstep(m, f - stp * gtest, g - gtest, stmin, stmax)
      Object.assign(s, m, { fx: m.fx + m.stx * gtest, fy: m.fy + m.sty * gtest, dx: m.dx + gtest, dy: m.dy + gtest })
    } else {
      dcstep(s, f, g, stmin, stmax)
    }
    if (s.brackt) {
      if (Math.abs(s.sty - s.stx) >= 0.66 * width1) s.stp = s.stx + 0.5 * (s.sty - s.stx)
      width1 = width
      width = Math.abs(s.sty - s.stx)
      stmin = Math.min(s.stx, s.sty)
      stmax = Math.max(s.stx, s.sty)
    } else {
      stmin = s.stp + 1.1 * (s.stp - s.stx)
      stmax = s.stp + 4 * (s.stp - s.stx)
    }
    s.stp = clip(s.stp, stpmin, stpmax)
    if (s.brackt && (s.stp <= stmin || s.stp >= stmax || stmax - stmin <= xtol * stmax)) s.stp = s.stx
    if (!Number.isFinite(s.stp)) return { stp: null, phi1: f }
    f = phi(s.stp)
    g = derphi(s.stp)
  }
  return { stp: null, phi1: f }
}

/** Initial step for both line searches: a step that would repeat the last decrease, capped at 1. */
function initialStep(phi0: number, oldPhi0: number, derphi0: number): number {
  const alpha1 = derphi0 !== 0 ? pyMin(1, (1.01 * 2 * (phi0 - oldPhi0)) / derphi0) : 1
  return alpha1 < 0 ? 1 : alpha1
}

/** Minimizer of the cubic through (a, fa), (b, fb), (c, fc) with slope fpa at a, or null. */
function cubicmin(a: number, fa: number, fpa: number, b: number, fb: number, c: number, fc: number): number | null {
  const db = b - a
  const dc = c - a
  const denom = (db * dc) ** 2 * (db - dc)
  const u = fb - fa - fpa * db
  const v = fc - fa - fpa * dc
  const A = (dc ** 2 * u + -(db ** 2) * v) / denom
  const B = (-(dc ** 3) * u + db ** 3 * v) / denom
  const radical = B * B - 3 * A * fpa
  // numpy raises (and scipy returns None) on division by zero, overflow or a negative radical.
  if (denom === 0 || A === 0 || radical < 0) return null
  const xmin = a + (-B + Math.sqrt(radical)) / (3 * A)
  return Number.isFinite(xmin) ? xmin : null
}

/** Minimizer of the quadratic through (a, fa), (b, fb) with slope fpa at a, or null. */
function quadmin(a: number, fa: number, fpa: number, b: number, fb: number): number | null {
  const db = b - a
  const B = (fb - fa - fpa * db) / (db * db)
  if (db === 0 || B === 0) return null
  const xmin = a - fpa / (2 * B)
  return Number.isFinite(xmin) ? xmin : null
}

/** Zoom stage of scipy's scalar_search_wolfe2 (Nocedal & Wright, Algorithm 3.6). */
function zoom(
  aLo: number, aHi: number, phiLo: number, phiHi: number, derphiLo: number,
  phi: (a: number) => number, derphi: (a: number) => number, phi0: number, derphi0: number, c1: number, c2: number,
): { alpha: number; phi1: number } | null {
  let phiRec = phi0
  let aRec = 0
  for (let i = 0; i <= 10; i++) {
    const dalpha = aHi - aLo
    const [a, b] = dalpha < 0 ? [aHi, aLo] : [aLo, aHi]
    let aj: number | null = null
    let cchk = 0
    if (i > 0) {
      cchk = 0.2 * dalpha
      aj = cubicmin(aLo, phiLo, derphiLo, aHi, phiHi, aRec, phiRec)
    }
    if (i === 0 || aj === null || aj > b - cchk || aj < a + cchk) {
      const qchk = 0.1 * dalpha
      aj = quadmin(aLo, phiLo, derphiLo, aHi, phiHi)
      if (aj === null || aj > b - qchk || aj < a + qchk) aj = aLo + 0.5 * dalpha
    }
    const phiAj = phi(aj)
    if (phiAj > phi0 + c1 * aj * derphi0 || phiAj >= phiLo) {
      phiRec = phiHi
      aRec = aHi
      aHi = aj
      phiHi = phiAj
    } else {
      const derphiAj = derphi(aj)
      if (Math.abs(derphiAj) <= -c2 * derphi0) return { alpha: aj, phi1: phiAj }
      if (derphiAj * (aHi - aLo) >= 0) {
        phiRec = phiHi
        aRec = aHi
        aHi = aLo
        phiHi = phiLo
      } else {
        phiRec = phiLo
        aRec = aLo
      }
      aLo = aj
      phiLo = phiAj
      derphiLo = derphiAj
    }
  }
  return null
}

/**
 * scipy's scalar_search_wolfe2 (the fallback line search), with amax = 1e100. `gradCurrent`
 * is false when it gives up after 10 expansions without evaluating the gradient at alpha.
 */
function wolfe2(
  phi: (a: number) => number, derphi: (a: number) => number, phi0: number, oldPhi0: number, derphi0: number, c1: number, c2: number,
): { alpha: number; phi1: number; gradCurrent: boolean } | null {
  const amax = 1e100
  let alpha0 = 0
  let alpha1 = pyMin(initialStep(phi0, oldPhi0, derphi0), amax)
  let phiA1 = phi(alpha1)
  let phiA0 = phi0
  let derphiA0 = derphi0
  for (let i = 0; i < 10; i++) {
    if (alpha1 === 0 || alpha0 > amax) return null
    if (phiA1 > phi0 + c1 * alpha1 * derphi0 || (phiA1 >= phiA0 && i > 0)) {
      const z = zoom(alpha0, alpha1, phiA0, phiA1, derphiA0, phi, derphi, phi0, derphi0, c1, c2)
      return z && { ...z, gradCurrent: true }
    }
    const derphiA1 = derphi(alpha1)
    if (Math.abs(derphiA1) <= -c2 * derphi0) return { alpha: alpha1, phi1: phiA1, gradCurrent: true }
    if (derphiA1 >= 0) {
      const z = zoom(alpha1, alpha0, phiA1, phiA0, derphiA1, phi, derphi, phi0, derphi0, c1, c2)
      return z && { ...z, gradCurrent: true }
    }
    alpha0 = alpha1
    alpha1 = pyMin(2 * alpha1, amax)
    phiA0 = phiA1
    phiA1 = phi(alpha1)
    derphiA0 = derphiA1
  }
  return { alpha: alpha1, phi1: phiA1, gradCurrent: false }
}

export interface BfgsOptions {
  /** Stop when the largest absolute gradient component is at most gtol (scipy's default 1e-5). */
  gtol?: number
  maxiter?: number
}

export interface BfgsResult {
  x: number[]
  fun: number
  grad: number[]
  iterations: number
  /** 0 success, 1 maxiter reached, 2 precision loss (line search failed), 3 NaN encountered. */
  warnflag: number
}

/**
 * BFGS minimization with the infinity-norm gradient test (scipy.optimize.fmin_bfgs as
 * statsmodels calls it): Moré–Thuente line search with the Wolfe-2 search as fallback.
 */
export function fminBfgs(f: (x: number[]) => number, grad: (x: number[]) => number[], x0: readonly number[], options: BfgsOptions = {}): BfgsResult {
  const n = x0.length
  const { gtol = 1e-5, maxiter = 200 * n } = options
  const c1 = 1e-4
  const c2 = 0.9
  const infNorm = (v: readonly number[]) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
  const twoNorm = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  let xk = x0.slice()
  let oldFval = f(xk)
  let gfk = grad(xk)
  let oldOldFval = oldFval + twoNorm(gfk) / 2
  let hk: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  let k = 0
  let warnflag = 0
  let gnorm = infNorm(gfk)
  while (gnorm > gtol && k < maxiter) {
    const pk = hk.map((row) => -row.reduce((s, h, j) => s + h * gfk[j], 0))
    const at = (alpha: number) => xk.map((x, i) => x + alpha * pk[i])
    const phi = (alpha: number) => f(at(alpha))
    let gNew: number[] | null = null
    const derphi = (alpha: number) => {
      gNew = grad(at(alpha))
      return gNew.reduce((s, g, i) => s + g * pk[i], 0)
    }
    const derphi0 = gfk.reduce((s, g, i) => s + g * pk[i], 0)
    const search = dcsrch(phi, derphi, initialStep(oldFval, oldOldFval, derphi0), oldFval, derphi0, {
      ftol: c1, gtol: c2, xtol: 1e-14, stpmin: 1e-100, stpmax: 1e100,
    })
    let alpha = search.stp
    let fNew = search.phi1
    if (alpha === null) {
      const fallback = wolfe2(phi, derphi, oldFval, oldOldFval, derphi0, c1, c2)
      if (fallback === null) {
        warnflag = 2
        break
      }
      ;({ alpha, phi1: fNew } = fallback)
      if (!fallback.gradCurrent) gNew = null
    }
    const step = alpha
    const sk = pk.map((p) => step * p)
    xk = xk.map((x, i) => x + sk[i])
    oldOldFval = oldFval
    oldFval = fNew
    const gfkp1: number[] = gNew ?? grad(xk)
    const yk = gfkp1.map((g, i) => g - gfk[i])
    gfk = gfkp1
    k++
    gnorm = infNorm(gfk)
    if (gnorm <= gtol) break
    if (alpha * twoNorm(pk) <= 0) break // scipy's xrtol test with xrtol = 0
    if (!Number.isFinite(oldFval)) {
      warnflag = 2
      break
    }
    const rhokInv = yk.reduce((s, y, i) => s + y * sk[i], 0)
    const rhok = rhokInv === 0 ? 1000 : 1 / rhokInv
    // H ← (I − ρ s yᵀ) H (I − ρ y sᵀ) + ρ s sᵀ
    const a1 = sk.map((si, i) => yk.map((yj, j) => (i === j ? 1 : 0) - si * yj * rhok))
    const a2 = yk.map((yi, i) => sk.map((sj, j) => (i === j ? 1 : 0) - yi * sj * rhok))
    const hA2 = hk.map((row) => a2[0].map((_, j) => row.reduce((s, h, m) => s + h * a2[m][j], 0)))
    hk = a1.map((row, i) => hA2[0].map((_, j) => row.reduce((s, a, m) => s + a * hA2[m][j], 0) + rhok * sk[i] * sk[j]))
  }
  if (warnflag !== 2) {
    if (k >= maxiter) warnflag = 1
    else if (Number.isNaN(gnorm) || Number.isNaN(oldFval) || xk.some(Number.isNaN)) warnflag = 3
  }
  return { x: xk, fun: oldFval, grad: gfk, iterations: k, warnflag }
}
