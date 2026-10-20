// Python-compatible number formatting, so labels and equations match the reference engine.

/** Shortest round-trip digits and decimal exponent of a finite non-zero number. */
function shortestDigits(x: number): { digits: string; exp: number } {
  const [mantissa, e] = Math.abs(x).toExponential().split('e')
  return { digits: mantissa.replace('.', ''), exp: Number(e) }
}

/** Digits rounded to `precision` significant figures, and their decimal exponent. */
function roundedDigits(x: number, precision: number): { digits: string; exp: number } {
  const [mantissa, e] = Math.abs(x).toExponential(precision - 1).split('e')
  return { digits: mantissa.replace('.', ''), exp: Number(e) }
}

/** Place a digit string with exponent `exp` in fixed notation. */
function fixedFromDigits(digits: string, exp: number): string {
  if (exp < 0) return `0.${'0'.repeat(-exp - 1)}${digits}`
  if (digits.length <= exp + 1) return digits + '0'.repeat(exp + 1 - digits.length)
  return `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`
}

function exponentSuffix(exp: number): string {
  return `e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
}

function special(x: number): string | null {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  return null
}

/** Python's `format(x, '.{precision}g')`. */
export function formatG(x: number, precision = 6): string {
  const s = special(x)
  if (s !== null) return s
  const p = Math.max(1, precision)
  const sign = x < 0 || Object.is(x, -0) ? '-' : ''
  if (x === 0) return `${sign}0`
  const { digits, exp } = roundedDigits(x, p)
  const trimmed = digits.replace(/0+$/, '') || '0'
  if (exp >= -4 && exp < p) return sign + fixedFromDigits(trimmed, exp)
  const mantissa = trimmed.length > 1 ? `${trimmed[0]}.${trimmed.slice(1)}` : trimmed
  return sign + mantissa + exponentSuffix(exp)
}

/** Python's `format(x, '.{digits}f')`. */
export function formatF(x: number, digits: number): string {
  const s = special(x)
  if (s !== null) return s
  return x.toFixed(digits)
}

/** Python's `str(x)` for an int or float (floats keep a ".0"; exponent outside 1e-4..1e16). */
export function pyStr(x: number, isInt = Number.isInteger(x) && Math.abs(x) < 2 ** 53): string {
  const s = special(x)
  if (s !== null) return s
  if (isInt) return String(x)
  const sign = x < 0 || Object.is(x, -0) ? '-' : ''
  if (x === 0) return `${sign}0.0`
  const { digits, exp } = shortestDigits(x)
  if (exp >= -4 && exp < 16) {
    const fixed = fixedFromDigits(digits, exp)
    return sign + (fixed.includes('.') ? fixed : `${fixed}.0`)
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
  return sign + mantissa + exponentSuffix(exp)
}

/** Round half to even at the integer level (numpy's rint). */
function rint(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Python's `round(x, ndigits)` for 0 <= ndigits <= 20: correctly rounded from the exact
 * binary value, with exact ties going to the even digit (round(2.675, 2) is 2.67,
 * round(0.125, 2) is 0.12).
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x
  // toFixed rounds from the exact value; only exact ties need half-to-even handling.
  const expansion = Math.abs(x).toFixed(Math.min(100, ndigits + 60))
  const [whole, frac = ''] = expansion.split('.')
  if (!/^50*$/.test(frac.slice(ndigits))) return Number(x.toFixed(ndigits))
  const kept = whole + frac.slice(0, ndigits)
  const down = BigInt(kept)
  const value = Number(down % 2n === 0n ? down : down + 1n) / 10 ** ndigits
  return x < 0 ? -value : value
}

/** numpy's `np.round(x, decimals)`: scale, round half to even, unscale. */
export function npRound(x: number, decimals = 0): number {
  if (!Number.isFinite(x)) return x
  if (decimals >= 0) {
    const factor = 10 ** decimals
    return rint(x * factor) / factor
  }
  const factor = 10 ** -decimals
  return rint(x / factor) * factor
}
