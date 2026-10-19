// Colors shared by every chart.

export const POINT = '#2b5797'
export const POINT_SELECTED = '#d9480f'
export const BAR = '#a9c1e0'
export const BAR_EDGE = '#5b7fae'
export const BAR_SELECTED = '#1f5fa8'
export const FIT = '#c0392b'
export const BAND = 'rgba(192, 57, 43, 0.15)'
export const DIAMOND = '#2f9e44'
export const BOX = '#495057'
export const GRID = '#e9ecef'
export const REFERENCE = '#c92a2a'

/** Categorical palette for overlays and mosaic cells. */
export const PALETTE = [
  '#1f5fa8',
  '#e8590c',
  '#2f9e44',
  '#c2255c',
  '#7048e8',
  '#0c8599',
  '#e8a33d',
  '#5c940d',
  '#a61e4d',
  '#495057',
]

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length]
}

/** Lighter variant of a hex color, used for unselected parts of shaded bars. */
export function tint(hex: string, amount = 0.55): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `rgb(${r}, ${g}, ${b})`
}
