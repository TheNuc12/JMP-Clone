import { useEffect, useRef } from 'react'
import type { Config, Data, Layout, PlotDatum, PlotlyHTMLElement } from 'plotly.js'
import { useStore } from '../state/store'
import { GRID } from '../lib/theme'

/** Maps a clicked or brushed point to the data-table rows it stands for. */
export type PointRows = (curveNumber: number, pointNumber: number) => number[] | undefined

interface Props {
  data: Data[]
  layout: Partial<Layout>
  height: number
  pointRows?: PointRows
  /** Zoom/pan survive re-renders until this changes; change it when the chart's structure changes. */
  uirevision?: string
}

const CONFIG: Partial<Config> = {
  displaylogo: false,
  responsive: false,
  displayModeBar: 'hover',
  modeBarButtonsToRemove: ['autoScale2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'],
}

const AXIS = {
  showline: true,
  linecolor: '#868e96',
  mirror: true,
  ticks: 'outside' as const,
  tickcolor: '#868e96',
  gridcolor: GRID,
  zeroline: false,
  automargin: true,
}

export const BASE_LAYOUT: Partial<Layout> = {
  margin: { l: 56, r: 16, t: 12, b: 44 },
  font: { family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', size: 11, color: '#343a40' },
  paper_bgcolor: '#fff',
  plot_bgcolor: '#fff',
  dragmode: 'select',
  hovermode: 'closest',
  showlegend: false,
  uirevision: 'keep',
  xaxis: AXIS,
  yaxis: AXIS,
}

/** Merge axis settings with the shared axis style. */
export function axis(extra: Partial<Layout['xaxis']>): Partial<Layout['xaxis']> {
  return { ...AXIS, ...extra }
}

let revision = 0

// Plotly is most of the bundle, so it is loaded on first use rather than with the app.
type PlotlyModule = typeof import('plotly.js-cartesian-dist-min').default
let plotly: Promise<PlotlyModule> | null = null
const loadPlotly = () => (plotly ??= import('plotly.js-cartesian-dist-min').then((m) => m.default))

/**
 * A Plotly chart wired into the shared row selection: clicking or brushing points
 * selects their rows (shift adds, ctrl/cmd toggles), double-clicking clears.
 */
export function PlotlyChart({ data, layout, height, pointRows, uirevision = 'keep' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const attached = useRef(false)
  const pointRowsRef = useRef(pointRows)
  pointRowsRef.current = pointRows
  const shiftHeld = useRef(false)
  // True while Plotly applies our own update; selection events fired then are echoes, not user input.
  const updating = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    // `selections: []` clears the brush outline once the selection lands in the store.
    const fullLayout = {
      ...BASE_LAYOUT,
      ...layout,
      height,
      uirevision,
      selections: [],
      datarevision: ++revision,
      selectionrevision: revision,
    } as Partial<Layout>
    loadPlotly()
      .then((Plotly) => {
        if (cancelled) return null
        updating.current = true
        return Plotly.react(el, data, fullLayout, CONFIG)
      })
      .then((gd: PlotlyHTMLElement | null) => {
        updating.current = false
        if (!gd || cancelled || attached.current) return
        attached.current = true
        attachSelectionHandlers(gd)
      })
    return () => {
      cancelled = true
    }
  }, [data, layout, height, uirevision])

  function attachSelectionHandlers(gd: PlotlyHTMLElement) {
    const rowsOf = (points: PlotDatum[]) => {
      const rows = new Set<number>()
      for (const p of points) {
        const found = pointRowsRef.current?.(p.curveNumber, p.pointNumber)
        if (found) for (const r of found) rows.add(r)
      }
      return rows
    }
    gd.on('plotly_selected', (event) => {
      if (!event || updating.current) return
      const { selectRows, clearSelection } = useStore.getState()
      const rows = rowsOf(event.points)
      if (rows.size === 0 && !shiftHeld.current) clearSelection()
      else selectRows(rows, shiftHeld.current ? 'add' : 'replace')
    })
    gd.on('plotly_click', (event) => {
      const mouse = event.event as MouseEvent | undefined
      const rows = rowsOf(event.points.slice(0, 1))
      if (rows.size === 0) return
      const mode = mouse?.shiftKey ? 'add' : mouse?.ctrlKey || mouse?.metaKey ? 'toggle' : 'replace'
      useStore.getState().selectRows(rows, mode)
    })
    gd.on('plotly_deselect', () => {
      if (!updating.current) useStore.getState().clearSelection()
    })
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && (el as unknown as { _fullLayout?: unknown })._fullLayout) loadPlotly().then((Plotly) => Plotly.Plots.resize(el))
    })
    observer.observe(el)
    const onKey = (e: KeyboardEvent) => {
      shiftHeld.current = e.shiftKey
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      loadPlotly().then((Plotly) => Plotly.purge(el))
    }
  }, [])

  return <div ref={ref} className="plot" style={{ height }} />
}
