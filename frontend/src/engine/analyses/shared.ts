// Small helpers shared by the Distribution and Fit Y by X ports.

/** [min, max] of a non-empty array (without spreading, so large columns are fine). */
export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

/** numpy's `np.all(x == x[0])`. */
export function allEqual(values: readonly number[]): boolean {
  return values.every((v) => v === values[0])
}

/** "N row(s) excluded for missing values." */
export function excludedNote(total: number, used: number): string {
  return `${total - used} row(s) excluded for missing values.`
}
