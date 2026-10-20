// Dense linear algebra on row-major number[][] matrices, with numpy.linalg semantics
// (cutoffs, minimum-norm least squares, LAPACK's Householder sign convention in qr).

export type Matrix = number[][]

const EPS = 2.220446049250313e-16

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
}

export function identity(n: number): Matrix {
  const m = zeros(n, n)
  for (let i = 0; i < n; i++) m[i][i] = 1
  return m
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length
  const cols = rows ? a[0].length : 0
  const t = zeros(cols, rows)
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) t[j][i] = a[i][j]
  return t
}

export function matmul(a: Matrix, b: Matrix): Matrix {
  const n = a.length
  const m = b.length
  const p = m ? b[0].length : 0
  const out = zeros(n, p)
  for (let i = 0; i < n; i++) {
    const row = out[i]
    const ai = a[i]
    for (let k = 0; k < m; k++) {
      const aik = ai[k]
      if (aik === 0) continue
      const bk = b[k]
      for (let j = 0; j < p; j++) row[j] += aik * bk[j]
    }
  }
  return out
}

export function matvec(a: Matrix, x: readonly number[]): number[] {
  return a.map((row) => dot(row, x))
}

export function dot(x: readonly number[], y: readonly number[]): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * y[i]
  return s
}

/** Euclidean norm (np.linalg.norm of a vector). */
export function norm(x: readonly number[]): number {
  return Math.sqrt(dot(x, x))
}

/** X'X for an n × p matrix, computed without forming the transpose. */
export function crossprod(x: Matrix): Matrix {
  const p = x.length ? x[0].length : 0
  const out = zeros(p, p)
  for (const row of x) {
    for (let i = 0; i < p; i++) {
      const ri = row[i]
      if (ri === 0) continue
      const oi = out[i]
      for (let j = i; j < p; j++) oi[j] += ri * row[j]
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) out[i][j] = out[j][i]
  return out
}

export class LinAlgError extends Error {}

// ------------------------------------------------------------------------------- LU

interface LU {
  lu: Matrix
  pivots: number[]
  sign: number
  singular: boolean
}

/** LU decomposition with partial pivoting (LAPACK getrf). Exactly zero pivots mark singularity. */
function luDecompose(a: Matrix): LU {
  const n = a.length
  const lu = a.map((row) => row.slice())
  const pivots = Array.from({ length: n }, (_, i) => i)
  let sign = 1
  let singular = false
  for (let k = 0; k < n; k++) {
    let p = k
    let max = Math.abs(lu[k][k])
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i][k])
      if (v > max) {
        max = v
        p = i
      }
    }
    if (p !== k) {
      ;[lu[p], lu[k]] = [lu[k], lu[p]]
      ;[pivots[p], pivots[k]] = [pivots[k], pivots[p]]
      sign = -sign
    }
    const pivot = lu[k][k]
    if (pivot === 0) {
      singular = true
      continue
    }
    for (let i = k + 1; i < n; i++) {
      const factor = (lu[i][k] /= pivot)
      if (factor === 0) continue
      const ri = lu[i]
      const rk = lu[k]
      for (let j = k + 1; j < n; j++) ri[j] -= factor * rk[j]
    }
  }
  return { lu, pivots, sign, singular }
}

function luSolve({ lu, pivots }: LU, b: readonly number[]): number[] {
  const n = lu.length
  const x = pivots.map((p) => b[p])
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) x[i] -= lu[i][j] * x[j]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) x[i] -= lu[i][j] * x[j]
    x[i] /= lu[i][i]
  }
  return x
}

/** Solve A x = b for square A (np.linalg.solve); throws LinAlgError for a singular A. */
export function solve(a: Matrix, b: readonly number[]): number[] {
  const lu = luDecompose(a)
  if (lu.singular) throw new LinAlgError('Singular matrix')
  return luSolve(lu, b)
}

/** Inverse of a square matrix (np.linalg.inv); throws LinAlgError for a singular matrix. */
export function inv(a: Matrix): Matrix {
  const n = a.length
  const lu = luDecompose(a)
  if (lu.singular) throw new LinAlgError('Singular matrix')
  const cols: number[][] = []
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0)
    e[j] = 1
    cols.push(luSolve(lu, e))
  }
  return transpose(cols)
}

/** Sign and log|det| (np.linalg.slogdet); a singular matrix gives sign 0 and −∞. */
export function slogdet(a: Matrix): { sign: number; logabsdet: number } {
  const { lu, sign, singular } = luDecompose(a)
  if (singular) return { sign: 0, logabsdet: -Infinity }
  let s = sign
  let logabsdet = 0
  for (let i = 0; i < lu.length; i++) {
    const d = lu[i][i]
    if (d < 0) s = -s
    logabsdet += Math.log(Math.abs(d))
  }
  return { sign: s, logabsdet }
}

/** Lower-triangular Cholesky factor L with A = L Lᵀ; throws LinAlgError if A is not positive definite. */
export function cholesky(a: Matrix): Matrix {
  const n = a.length
  const l = zeros(n, n)
  for (let j = 0; j < n; j++) {
    let d = a[j][j]
    for (let k = 0; k < j; k++) d -= l[j][k] * l[j][k]
    if (!(d > 0)) throw new LinAlgError('Matrix is not positive definite')
    l[j][j] = Math.sqrt(d)
    for (let i = j + 1; i < n; i++) {
      let s = a[i][j]
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k]
      l[i][j] = s / l[j][j]
    }
  }
  return l
}

// ------------------------------------------------------------------------------- QR

/**
 * Reduced QR (np.linalg.qr): Q is m × k and R is k × n with k = min(m, n). Householder
 * reflections follow LAPACK (dgeqrf / dorgqr): R's diagonal takes the opposite sign of
 * the pivot column's leading entry, and a column that is already reduced is left alone.
 */
export function qr(a: Matrix): { q: Matrix; r: Matrix } {
  const m = a.length
  const n = m ? a[0].length : 0
  const k = Math.min(m, n)
  const w = a.map((row) => row.slice())
  const vs: number[][] = []
  const taus: number[] = []
  for (let j = 0; j < k; j++) {
    const alpha = w[j][j]
    let xnorm = 0
    for (let i = j + 1; i < m; i++) xnorm = Math.hypot(xnorm, w[i][j])
    if (xnorm === 0) {
      vs.push([])
      taus.push(0)
      continue
    }
    const beta = -(alpha < 0 ? -1 : 1) * Math.hypot(alpha, xnorm)
    const tau = (beta - alpha) / beta
    const scale = 1 / (alpha - beta)
    const v = [1]
    for (let i = j + 1; i < m; i++) v.push(w[i][j] * scale)
    // Apply H = I − τ v vᵀ to the trailing columns.
    for (let c = j + 1; c < n; c++) {
      let s = 0
      for (let i = j; i < m; i++) s += v[i - j] * w[i][c]
      s *= tau
      for (let i = j; i < m; i++) w[i][c] -= s * v[i - j]
    }
    w[j][j] = beta
    for (let i = j + 1; i < m; i++) w[i][j] = 0
    vs.push(v)
    taus.push(tau)
  }
  // Q = H₀ H₁ … H_{k−1} applied to the first k columns of the identity.
  const q = zeros(m, k)
  for (let i = 0; i < k; i++) q[i][i] = 1
  for (let j = k - 1; j >= 0; j--) {
    const tau = taus[j]
    if (tau === 0) continue
    const v = vs[j]
    for (let c = 0; c < k; c++) {
      let s = 0
      for (let i = j; i < m; i++) s += v[i - j] * q[i][c]
      s *= tau
      for (let i = j; i < m; i++) q[i][c] -= s * v[i - j]
    }
  }
  const r = zeros(k, n)
  for (let i = 0; i < k; i++) for (let c = i; c < n; c++) r[i][c] = w[i][c]
  return { q, r }
}

// ------------------------------------------------------------------------------ SVD

export interface SVD {
  /** m × k left singular vectors. */
  u: Matrix
  /** k singular values, descending. */
  s: number[]
  /** n × k right singular vectors (columns), i.e. Vᵀ transposed. */
  v: Matrix
}

/** Thin SVD by one-sided Jacobi rotations (high relative accuracy); k = min(m, n). */
export function svd(a: Matrix): SVD {
  const m = a.length
  const n = m ? a[0].length : 0
  if (m < n) {
    const t = svd(transpose(a))
    return { u: t.v, s: t.s, v: t.u }
  }
  // Work on columns: u holds A V, rotated until its columns are orthogonal.
  const cols = Array.from({ length: n }, (_, j) => a.map((row) => row[j]))
  const vcols = Array.from({ length: n }, (_, j) => {
    const e = new Array<number>(n).fill(0)
    e[j] = 1
    return e
  })
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const cp = cols[p]
        const cq = cols[q]
        let alpha = 0
        let beta = 0
        let gamma = 0
        for (let i = 0; i < m; i++) {
          alpha += cp[i] * cp[i]
          beta += cq[i] * cq[i]
          gamma += cp[i] * cq[i]
        }
        if (gamma === 0 || Math.abs(gamma) <= EPS * Math.sqrt(alpha * beta)) continue
        rotated = true
        const zeta = (beta - alpha) / (2 * gamma)
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta))
        const c = 1 / Math.sqrt(1 + t * t)
        const s = c * t
        for (let i = 0; i < m; i++) {
          const x = cp[i]
          const y = cq[i]
          cp[i] = c * x - s * y
          cq[i] = s * x + c * y
        }
        const vp = vcols[p]
        const vq = vcols[q]
        for (let i = 0; i < n; i++) {
          const x = vp[i]
          const y = vq[i]
          vp[i] = c * x - s * y
          vq[i] = s * x + c * y
        }
      }
    }
    if (!rotated) break
  }
  const sigma = cols.map((c) => norm(c))
  const order = sigma.map((_, j) => j).sort((x, y) => sigma[y] - sigma[x])
  const s = order.map((j) => sigma[j])
  const u = zeros(m, n)
  const v = zeros(n, n)
  order.forEach((j, k) => {
    const sj = sigma[j]
    for (let i = 0; i < m; i++) u[i][k] = sj > 0 ? cols[j][i] / sj : 0
    for (let i = 0; i < n; i++) v[i][k] = vcols[j][i]
  })
  return { u, s, v }
}

/** Number of singular values above S.max() · max(m, n) · eps (np.linalg.matrix_rank). */
export function matrixRank(a: Matrix, tol?: number): number {
  const m = a.length
  const n = m ? a[0].length : 0
  if (m === 0 || n === 0) return 0
  const { s } = svd(a)
  const cutoff = tol ?? s[0] * Math.max(m, n) * EPS
  return s.filter((x) => x > cutoff).length
}

/** V diag(1/s) Uᵀ over singular values above rcond · S.max() (np.linalg.pinv, rcond 1e-15). */
export function pinv(a: Matrix, rcond = 1e-15): Matrix {
  return pinvExtended(a, rcond).pinv
}

/** Pseudo-inverse together with all singular values (statsmodels' pinv_extended). */
export function pinvExtended(a: Matrix, rcond = 1e-15): { pinv: Matrix; s: number[] } {
  const { u, s, v } = svd(a)
  const cutoff = rcond * (s[0] ?? 0)
  const m = a.length
  const n = m ? a[0].length : 0
  const out = zeros(n, m)
  s.forEach((sk, k) => {
    if (!(sk > cutoff)) return
    for (let i = 0; i < n; i++) {
      const vik = v[i][k] / sk
      if (vik === 0) continue
      const row = out[i]
      for (let j = 0; j < m; j++) row[j] += vik * u[j][k]
    }
  })
  return { pinv: out, s }
}

/**
 * Minimum-norm least squares solution of A x ≈ b (np.linalg.lstsq with rcond=None:
 * singular values at or below eps · max(m, n) · S.max() are treated as zero).
 */
export function lstsq(a: Matrix, b: readonly number[]): { x: number[]; rank: number; s: number[] } {
  const m = a.length
  const n = m ? a[0].length : 0
  const { u, s, v } = svd(a)
  const cutoff = EPS * Math.max(m, n) * (s[0] ?? 0)
  const x = new Array<number>(n).fill(0)
  let rank = 0
  s.forEach((sk, k) => {
    if (!(sk > cutoff)) return
    rank++
    let ub = 0
    for (let i = 0; i < m; i++) ub += u[i][k] * b[i]
    const coef = ub / sk
    for (let i = 0; i < n; i++) x[i] += coef * v[i][k]
  })
  return { x, rank, s }
}

// ------------------------------------------------------------------- eigenvalues

/** Eigen-decomposition of a symmetric matrix by cyclic Jacobi (np.linalg.eigh): values ascending. */
export function eigh(a: Matrix): { values: number[]; vectors: Matrix } {
  const n = a.length
  const w = a.map((row) => row.slice())
  const vecs = identity(n)
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += w[i][j] * w[i][j]
    if (off === 0) break
    let scale = 0
    for (let i = 0; i < n; i++) scale += w[i][i] * w[i][i]
    if (off <= EPS * EPS * scale) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = w[p][q]
        if (apq === 0) continue
        const theta = (w[q][q] - w[p][p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const wkp = w[k][p]
          const wkq = w[k][q]
          w[k][p] = c * wkp - s * wkq
          w[k][q] = s * wkp + c * wkq
        }
        for (let k = 0; k < n; k++) {
          const wpk = w[p][k]
          const wqk = w[q][k]
          w[p][k] = c * wpk - s * wqk
          w[q][k] = s * wpk + c * wqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = vecs[k][p]
          const vkq = vecs[k][q]
          vecs[k][p] = c * vkp - s * vkq
          vecs[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => w[x][x] - w[y][y])
  return { values: order.map((i) => w[i][i]), vectors: vecs.map((row) => order.map((i) => row[i])) }
}
