import { useMemo, useState, type DragEvent } from 'react'
import type { Layout } from 'plotly.js'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { ModelingIcon } from '../components/ModelingIcon'
import { COLUMN_DRAG_TYPE } from '../components/ColumnsPanel'
import type { GBRole, ReportConfig } from '../state/store'
import { findColumn, includedRows, useStore } from '../state/store'
import { availableElements, buildGraph, defaultElements, ELEMENT_LABELS, toggleElement } from './graphBuilderTraces'

type GBConfig = Extract<ReportConfig, { kind: 'graph_builder' }>

const ROLE_LABELS: Record<GBRole, string> = { x: 'X', y: 'Y', overlay: 'Overlay' }

/** Drag columns onto X, Y and Overlay; pick the elements to draw. */
export function GraphBuilder({ report }: { report: GBConfig }) {
  const table = useStore((s) => s.table)
  const excluded = useStore((s) => s.excluded)
  const selected = useStore((s) => s.selected)
  const nSelected = useStore((s) => s.nSelected)
  const updateReport = useStore((s) => s.updateReport)
  const [picked, setPicked] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<GBRole | null>(null)

  const x = report.roles.x ? findColumn(table, report.roles.x) : undefined
  const y = report.roles.y ? findColumn(table, report.roles.y) : undefined
  const overlay = report.roles.overlay ? findColumn(table, report.roles.overlay) : undefined
  const available = availableElements(x, y)
  const elements = report.elements.filter((e) => available.includes(e))
  const rows = useMemo(() => includedRows(excluded), [excluded])

  const graph = useMemo(
    () => buildGraph({ x, y, overlay, elements, rows, selected, nSelected }),
    // `elements` is re-derived each render; key the memo on its contents.
    [x, y, overlay, elements.join(','), rows, selected, nSelected],
  )
  const layout = useMemo<Partial<Layout>>(
    () => ({
      ...graph.layout,
      xaxis: axis(graph.layout.xaxis ?? {}),
      yaxis: axis(graph.layout.yaxis ?? {}),
      margin: { l: 64, r: 24, t: 12, b: 52 },
    }),
    [graph],
  )

  const assign = (role: GBRole, column: string | undefined) => {
    updateReport(report.id, (r) => {
      if (r.kind !== 'graph_builder') return r
      const roles = { ...r.roles, [role]: column }
      if (!column) delete roles[role]
      const nx = roles.x ? findColumn(table, roles.x) : undefined
      const ny = roles.y ? findColumn(table, roles.y) : undefined
      // Overlay changes keep the chosen elements; axis changes reset to sensible defaults.
      const nextElements = role === 'overlay' ? r.elements : defaultElements(nx, ny)
      return { ...r, roles, elements: nextElements }
    })
    setPicked(null)
  }

  const onDrop = (role: GBRole) => (e: DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const name = e.dataTransfer.getData(COLUMN_DRAG_TYPE)
    if (name) assign(role, name)
  }

  const zone = (role: GBRole) => {
    const assigned = report.roles[role]
    return (
      <div
        className={`drop-zone zone-${role}${dragOver === role ? ' drag-over' : ''}${picked ? ' armed' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) {
            e.preventDefault()
            setDragOver(role)
          }
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={onDrop(role)}
        onClick={() => picked && assign(role, picked)}
        title={picked ? `Assign ${picked} to ${ROLE_LABELS[role]}` : `Drop a column here for ${ROLE_LABELS[role]}`}
      >
        <span className="zone-label">{ROLE_LABELS[role]}</span>
        {assigned ? (
          <span className="zone-chip">
            {assigned}
            <button
              aria-label={`Remove ${assigned}`}
              onClick={(e) => {
                e.stopPropagation()
                assign(role, undefined)
              }}
            >
              ×
            </button>
          </span>
        ) : (
          <span className="zone-empty">drop here</span>
        )}
      </div>
    )
  }

  const single = !(x && y)
  return (
    <div className="graph-builder">
      <aside className="gb-columns">
        <div className="gb-columns-title">Columns</div>
        <ul>
          {table?.columns.map((c) => (
            <li
              key={c.name}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(COLUMN_DRAG_TYPE, c.name)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className={picked === c.name ? 'picked' : ''}
              onClick={() => setPicked(picked === c.name ? null : c.name)}
              title="Drag to a drop zone, or click and then click a zone"
            >
              <ModelingIcon type={c.modelingType} /> {c.name}
            </li>
          ))}
        </ul>
      </aside>
      <div className="gb-main">
        <div className="gb-toolbar">
          {available.map((e) => (
            <button
              key={e}
              className={`toggle${elements.includes(e) ? ' on' : ''}`}
              onClick={() =>
                updateReport(report.id, (r) => (r.kind === 'graph_builder' ? { ...r, elements: toggleElement(elements, e, single) } : r))
              }
            >
              {ELEMENT_LABELS[e]}
            </button>
          ))}
          <span className="spacer" />
          {(x || y || overlay) && (
            <button className="link-button" onClick={() => updateReport(report.id, (r) => (r.kind === 'graph_builder' ? { ...r, roles: {}, elements: [] } : r))}>
              Start over
            </button>
          )}
        </div>
        <div className="gb-canvas">
          {zone('overlay')}
          {zone('y')}
          <div className="gb-plot">
            {x || y ? (
              <PlotlyChart
                data={graph.data}
                layout={layout}
                height={460}
                uirevision={[x?.name, x?.modelingType, y?.name, y?.modelingType, overlay?.name, elements.join()].join('|')}
                pointRows={(curve, point) => graph.lookup[curve]?.(point)}
              />
            ) : (
              <div className="gb-empty">Drag a column to the X or Y zone to start a graph.</div>
            )}
          </div>
          {zone('x')}
        </div>
      </div>
    </div>
  )
}
