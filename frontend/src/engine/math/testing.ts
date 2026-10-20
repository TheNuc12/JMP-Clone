// Helpers for comparing the math library against reference.json (scipy / statsmodels output).

import { expect } from 'vitest'
import raw from './reference.json'

type Json = number | string | boolean | null | Json[] | { [key: string]: Json }

/** Decode the "NaN" / "Infinity" strings the generator writes for non-finite numbers. */
function decode(v: Json): unknown {
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]))
  return v
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reference = decode(raw as unknown as Json) as any

/** Relative error |a − b| / |b| (absolute when b is 0); 0 when both are equal or both NaN. */
export function relError(actual: number, expected: number): number {
  if (Object.is(actual, expected) || actual === expected) return 0
  if (Number.isNaN(actual) && Number.isNaN(expected)) return 0
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return Infinity
  return expected === 0 ? Math.abs(actual) : Math.abs(actual - expected) / Math.abs(expected)
}

/** Assert |a − b| ≤ atol + rtol |b| (NaN matches NaN, infinities must match exactly). */
export function expectClose(actual: number, expected: number, rtol: number, atol = 0, label = ''): void {
  const ok =
    (Number.isNaN(actual) && Number.isNaN(expected)) ||
    actual === expected ||
    (Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= atol + rtol * Math.abs(expected))
  if (!ok) expect.fail(`${label}: got ${actual}, expected ${expected} (rel err ${relError(actual, expected).toExponential(2)})`)
}

/** Element-wise expectClose over (nested) arrays. */
export function expectAllClose(actual: unknown, expected: unknown, rtol: number, atol = 0, label = ''): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${label}: not an array`).toBe(true)
    const a = actual as unknown[]
    expect(a.length, `${label}: length`).toBe(expected.length)
    expected.forEach((e, i) => expectAllClose(a[i], e, rtol, atol, `${label}[${i}]`))
    return
  }
  expectClose(actual as number, expected as number, rtol, atol, label)
}
