import type { Cell, CellFormat } from '../api/types'

/** Up to `digits` significant digits, without trailing zeros or exponent noise for typical values. */
export function formatNumber(value: number, digits = 7): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '-∞' : ''
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e15 || abs < 1e-9) return value.toExponential(digits - 1).replace(/\.?0+e/, 'e')
  const decimals = Math.max(0, digits - 1 - Math.floor(Math.log10(abs)))
  const fixed = value.toFixed(Math.min(decimals, 12))
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** JMP-style p-value: "<.0001*", "0.0312*", "0.4417". The star marks significance at 0.05. */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return ''
  if (p < 0.0001) return '<.0001*'
  const text = p.toFixed(4)
  return p < 0.05 ? `${text}*` : text
}

export function formatCell(value: Cell, format: CellFormat = 'number'): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  switch (format) {
    case 'integer':
      return Number.isInteger(value) ? String(value) : formatNumber(value)
    case 'pvalue':
      return formatPValue(value)
    case 'percent':
      return `${formatNumber(value * 100, 4)}%`
    case 'text':
      return String(value)
    default:
      return formatNumber(value)
  }
}

/** Short form for data-grid cells. */
export function formatValue(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return formatNumber(value, 8)
  return value
}
