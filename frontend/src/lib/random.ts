/**
 * Deterministic pseudo-random number in [0, 1) for a row, so jittered points
 * keep their position across re-renders. `salt` decorrelates different uses.
 */
export function rowNoise(row: number, salt = 0): number {
  let h = (row + 1) * 0x9e3779b1 + salt * 0x85ebca6b
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad)
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Symmetric jitter in [-width/2, width/2). */
export function jitter(row: number, width: number, salt = 0): number {
  return (rowNoise(row, salt) - 0.5) * width
}
