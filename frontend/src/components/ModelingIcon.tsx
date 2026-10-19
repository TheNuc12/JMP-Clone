import type { ModelingType } from '../api/types'

const TITLES: Record<ModelingType, string> = {
  continuous: 'Continuous',
  ordinal: 'Ordinal',
  nominal: 'Nominal',
}

/** Small glyph for a column's modeling type: blue ramp, green rising bars, red uneven bars. */
export function ModelingIcon({ type }: { type: ModelingType }) {
  return (
    <svg className={`modeling-icon mt-${type}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={TITLES[type]}>
      <title>{TITLES[type]}</title>
      {type === 'continuous' && <path d="M1 12.5 L13 12.5 L13 2 Z" fill="#1f5fa8" />}
      {type === 'ordinal' && (
        <g fill="#2f9e44">
          <rect x="1" y="9" width="3" height="4" />
          <rect x="5.5" y="6" width="3" height="7" />
          <rect x="10" y="2" width="3" height="11" />
        </g>
      )}
      {type === 'nominal' && (
        <g fill="#c92a2a">
          <rect x="1" y="5" width="3" height="8" />
          <rect x="5.5" y="9" width="3" height="4" />
          <rect x="10" y="2" width="3" height="11" />
        </g>
      )}
    </svg>
  )
}
