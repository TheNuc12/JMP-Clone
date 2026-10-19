import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Data, Layout, Shape } from 'plotly.js'
import type { ModelFactor, ProfilerPlot } from '../api/types'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { formatNumber } from '../lib/format'
import { defaultSettings, predict, type Prediction, type Settings } from '../lib/model'
import { BAND, FIT, REFERENCE } from '../lib/theme'
import type { Column } from '../state/store'
import '../platforms/fitModel/fitModel.css'

const GRID_POINTS = 60

interface Trace {
  factor: ModelFactor
  x: number[] // grid values, or level positions for categorical factors
  value: number[]
  lower: number[]
  upper: number[]
}

/** Prediction traces for one factor with the others held at their current settings. */
function traceFor(spec: ProfilerPlot['model'], factor: ModelFactor, settings: Settings): Trace {
  const categorical = factor.kind === 'categorical'
  const levels = factor.levels ?? []
  const lo = factor.min ?? 0
  const hi = factor.max ?? lo
  const xs = categorical ? levels.map((_, i) => i) : lo === hi ? [lo] : Array.from({ length: GRID_POINTS }, (_, i) => lo + ((hi - lo) * i) / (GRID_POINTS - 1))
  const preds = xs.map((x) => predict(spec, { ...settings, [factor.name]: categorical ? levels[x] : x }))
  const pick = (f: (p: Prediction) => number) => preds.map((p) => (p ? f(p) : NaN))
  return { factor, x: xs, value: pick((p) => p.value), lower: pick((p) => p.lower), upper: pick((p) => p.upper) }
}

/**
 * JMP-style prediction profiler: one panel per factor showing the predicted response (with
 * its 95% confidence band) as that factor varies and the others stay at their settings.
 * Click or drag in a panel, or type a value below it, to change a setting.
 */
export function ProfilerChart({ spec }: { spec: ProfilerPlot; rows: number[]; columns: Map<string, Column> }) {
  const model = spec.model
  const factorKey = model.factors.map((f) => `${f.name}:${f.kind}:${(f.levels ?? []).join('|')}`).join(';')
  const [settings, setSettings] = useState<Settings>(() => defaultSettings(model))

  // A refit with different factors starts over; a refit of the same factors keeps the settings.
  useEffect(() => {
    setSettings(defaultSettings(model))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the factor set
  }, [factorKey])

  const current = predict(model, settings)
  const traces = useMemo(() => model.factors.map((f) => traceFor(model, f, settings)), [model, settings])
  const yRange = useMemo(() => {
    const all = traces.flatMap((t) => [...t.lower, ...t.upper]).filter(Number.isFinite)
    if (!all.length) return [0, 1] as [number, number]
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1
    return [lo - pad, hi + pad] as [number, number]
  }, [traces])

  const setFactor = (name: string, value: number | string) => setSettings((s) => ({ ...s, [name]: value }))

  return (
    <div className="profiler">
      <div className="profiler-readout">
        <span className="profiler-response">{model.response}</span>
        <span className="profiler-value">{current ? formatNumber(current.value, 6) : '·'}</span>
        {current && current.upper > current.value && <span className="profiler-ci">±{formatNumber(current.upper - current.value, 5)}</span>}
      </div>
      {traces.map((trace, i) => (
        <ProfilerPanel
          key={trace.factor.name}
          trace={trace}
          setting={settings[trace.factor.name]}
          prediction={current?.value ?? null}
          yRange={yRange}
          showYAxis={i === 0}
          onChange={(v) => setFactor(trace.factor.name, v)}
        />
      ))}
    </div>
  )
}

function ProfilerPanel({
  trace,
  setting,
  prediction,
  yRange,
  showYAxis,
  onChange,
}: {
  trace: Trace
  setting: number | string | null
  prediction: number | null
  yRange: [number, number]
  showYAxis: boolean
  onChange: (value: number | string) => void
}) {
  const { factor } = trace
  const categorical = factor.kind === 'categorical'
  const levels = factor.levels ?? []
  const position = categorical ? Math.max(0, levels.indexOf(String(setting))) : Number(setting)
  const wrapper = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const frame = useRef(0)

  const data = useMemo<Data[]>(() => {
    if (categorical) {
      return [
        {
          type: 'scatter',
          mode: 'lines+markers',
          x: trace.x,
          y: trace.value,
          line: { color: FIT, width: 1.5 },
          marker: { color: FIT, size: 7 },
          error_y: {
            type: 'data',
            symmetric: false,
            array: trace.upper.map((u, i) => u - trace.value[i]),
            arrayminus: trace.value.map((v, i) => v - trace.lower[i]),
            color: '#e0a8a1',
            thickness: 1.5,
          },
          hoverinfo: 'skip',
        },
      ]
    }
    return [
      { type: 'scatter', mode: 'lines', x: trace.x, y: trace.lower, line: { width: 0 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: trace.x, y: trace.upper, line: { width: 0 }, fill: 'tonexty', fillcolor: BAND, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: trace.x, y: trace.value, line: { color: FIT, width: 2 }, hoverinfo: 'skip' },
    ]
  }, [trace, categorical])

  const layout = useMemo<Partial<Layout>>(() => {
    const shapes: Partial<Shape>[] = []
    if (Number.isFinite(position)) {
      shapes.push({ type: 'line', yref: 'paper', x0: position, x1: position, y0: 0, y1: 1, line: { color: REFERENCE, width: 1.5, dash: 'dash' } })
    }
    if (prediction !== null) {
      shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: prediction, y1: prediction, line: { color: REFERENCE, width: 1, dash: 'dot' } })
    }
    const lo = factor.min ?? 0
    const hi = factor.max ?? lo
    return {
      dragmode: false,
      hovermode: false,
      margin: { l: showYAxis ? 52 : 10, r: 8, t: 8, b: 36 },
      xaxis: axis({
        fixedrange: true,
        showgrid: false,
        title: { text: factor.name },
        ...(categorical
          ? { tickmode: 'array' as const, tickvals: trace.x, ticktext: levels, range: [-0.5, levels.length - 0.5] }
          : { range: lo === hi ? [lo - 1, hi + 1] : [lo, hi] }),
      }),
      yaxis: axis({ fixedrange: true, range: yRange, showticklabels: showYAxis }),
      shapes,
    }
  }, [factor, categorical, levels, trace.x, position, prediction, yRange, showYAxis])

  /** Data x under the pointer, from Plotly's laid-out plot area. */
  const valueAt = (clientX: number): number | string | null => {
    const gd = wrapper.current?.querySelector('.js-plotly-plot') as (HTMLElement & { _fullLayout?: PlotlyLayoutInternals }) | null
    const fl = gd?._fullLayout
    if (!gd || !fl) return null
    const box = gd.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - box.left - fl._size.l) / fl._size.w))
    const [r0, r1] = fl.xaxis.range
    const x = r0 + frac * (r1 - r0)
    if (categorical) return levels[Math.min(levels.length - 1, Math.max(0, Math.round(x)))] ?? null
    return x
  }

  const update = (clientX: number) => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const v = valueAt(clientX)
      if (v !== null) onChange(v)
    })
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    update(e.clientX)
  }

  return (
    <div className="profiler-panel">
      <div
        ref={wrapper}
        className="profiler-plot"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => dragging.current && update(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        title={`Click or drag to set ${factor.name}`}
      >
        <PlotlyChart data={data} layout={layout} height={220} />
      </div>
      <div className="profiler-setting">
        {categorical ? (
          <select aria-label={factor.name} value={String(setting ?? '')} onChange={(e) => onChange(e.target.value)}>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <SettingInput label={factor.name} value={Number(setting)} onChange={onChange} />
        )}
      </div>
    </div>
  )
}

interface PlotlyLayoutInternals {
  _size: { l: number; w: number }
  xaxis: { range: [number, number] }
}

/** Number box that commits on Enter or blur, so typing doesn't jump the profiler around. */
function SettingInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const shown = Number.isFinite(value) ? formatNumber(value, 5) : ''
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  const commit = () => {
    setEditing(false)
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n)) onChange(n)
  }
  return (
    <input
      aria-label={label}
      type="text"
      inputMode="decimal"
      value={editing ? text : shown}
      onFocus={() => {
        setText(shown)
        setEditing(true)
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
