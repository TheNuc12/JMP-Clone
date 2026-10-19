import type { LimitText } from './settings'

const FIELDS: { key: keyof LimitText; label: string }[] = [
  { key: 'lsl', label: 'LSL' },
  { key: 'target', label: 'Target' },
  { key: 'usl', label: 'USL' },
]

/** Lower spec limit, target and upper spec limit inputs in one row. */
export function SpecLimitFields({ value, onChange, idPrefix }: { value: LimitText; onChange: (v: LimitText) => void; idPrefix: string }) {
  return (
    <div className="spec-fields">
      {FIELDS.map((f) => (
        <label key={f.key} className="field" htmlFor={`${idPrefix}-${f.key}`}>
          <span>{f.label}</span>
          <input
            id={`${idPrefix}-${f.key}`}
            type="text"
            inputMode="decimal"
            value={value[f.key]}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  )
}
