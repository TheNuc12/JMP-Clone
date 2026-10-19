import { useMemo, useState, type DragEvent } from 'react'
import type { Layout } from 'plotly.js'
import { axis, PlotlyChart } from '../components/PlotlyChart'
import { ModelingIcon } from '../components/ModelingIcon'
import { COLUMN_DRAG_TYPE } from '../components/ColumnsPanel'
import type { GBElement, GBRole, ReportConfig } from '../state/store'
import { findColumn, includedRows, isCategorical, useActiveTable, useStore } from '../state/store'
import { availableElements, buildFacetedGraph, defaultElements, ELEMENT_LABELS, MAX_FACETS, toggleElement } from './graphBuilderTraces'
import './graphBuilder.css'

const ROLE_LABELS: Record<GBRole, string> = { x: 'X', y: 'Y', overlay: 'Overlay', group_x: 'Group X', group_y: 'Group Y' }
const GROUP_ROLES: GBRole[] = ['group_x', 'group_y']

/** Elements chosen in a Graph Builder report (stored in its params). */
export function elementsOf(report: ReportConfig): GBElement[] {
  return (report.params.elements as GBElement[] | undefined) ?? []
}

/** Drag columns onto X, Y, Overlay and the Group zones; pick the elements to draw. */
export function GraphBuilder({ report }: { report: ReportConfig }) {
  const table = useActiveTable()
  const updateReport = useStore((s) => s.updateReport)
  const notify = useStore((s) => s.notify)
  const [picked, setPicked] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<GBRole | null>(null)
  const excluded = table!.excluded
  const selected = table!.selected
  const nSelected = table!.nSelected

  const roleColumn = (role: GBRole) => {
    const id = report.roles[role]?.[0]
    return id ? findColumn(table, id) : undefined
  }
  const x = roleColumn('x')
  const y = roleColumn('y')
  const overlay = roleColumn('overlay')
  const groupX = roleColumn('group_x')
  const groupY = roleColumn('group_y')
  const available = availableElements(x, y)
  const elements = elementsOf(report).filter((e) => available.includes(e))
  const rows = useMemo(() => includedRows(excluded), [excluded])

  const graph = useMemo(
    () => buildFacetedGraph({ x, y, overlay, groupX, groupY, elements, rows, selected, nSelected }),
    // `elements` is re-derived each render; key the memo on its contents.
    [x, y, overlay, groupX, groupY, elements.join(','), rows, selected, nSelected],
  )
  const faceted = graph.facets.xLevels.length > 0 || graph.facets.yLevels.length > 0
  const layout = useMemo<Partial<Layout>>(() => {
    // Every panel axis (xaxis, xaxis2, ..., yaxis, yaxis2, ...) gets the shared axis style.
    const styled: Record<string, unknown> = { ...graph.layout }
    for (const key of Object.keys(styled)) {
      if (/^[xy]axis\d*$/.test(key)) styled[key] = axis(styled[key] as Partial<Layout['xaxis']>)
    }
    if (!styled.xaxis) styled.xaxis = axis({})
    if (!styled.yaxis) styled.yaxis = axis({})
    return { ...styled, margin: graph.layout.margin ?? { l: 64, r: 24, t: 12, b: 52 } } as Partial<Layout>
  }, [graph])
  const height = Math.max(460, faceted ? 220 * Math.max(1, graph.facets.yLevels.length) + 110 : 0)

  const assign = (role: GBRole, columnId: string | undefined) => {
    const column = columnId ? findColumn(table, columnId) : undefined
    if (column && GROUP_ROLES.includes(role) && !isCategorical(column.modelingType)) {
      notify(`${ROLE_LABELS[role]} needs a categorical column. Make ${column.name} ordinal or nominal to group by it.`, 'error')
      setPicked(null)
      return
    }
    updateReport(report.id, (r) => {
      const roles = { ...r.roles, [role]: columnId ? [columnId] : [] }
      const nx = roles.x?.[0] ? findColumn(table, roles.x[0]) : undefined
      const ny = roles.y?.[0] ? findColumn(table, roles.y[0]) : undefined
      // Axis changes reset the elements to sensible defaults; other roles keep them.
      const nextElements = role === 'x' || role === 'y' ? defaultElements(nx, ny) : elementsOf(r)
      return { ...r, roles, params: { ...r.params, elements: nextElements } }
    })
    setPicked(null)
  }

  const onDrop = (role: GBRole) => (e: DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const dropped = e.dataTransfer.getData(COLUMN_DRAG_TYPE)
    const column = table?.columns.find((c) => c.id === dropped || c.name === dropped)
    if (column) assign(role, column.id)
  }

  const zone = (role: GBRole) => {
    const assigned = findColumn(table, report.roles[role]?.[0] ?? '')?.name
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
        title={picked ? `Assign ${findColumn(table, picked)?.name} to ${ROLE_LABELS[role]}` : `Drop a column here for ${ROLE_LABELS[role]}`}
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

  const notes: string[] = []
  if (graph.facets.hiddenLevels > 0) notes.push(`Showing at most ${MAX_FACETS} panels per direction; ${graph.facets.hiddenLevels} more group level(s) are not shown.`)
  if (graph.facets.missingRows > 0) notes.push(`${graph.facets.missingRows} row(s) with a missing group value are not shown.`)

  const single = !(x && y)
  return (
    <div className="graph-builder">
      <aside className="gb-columns">
        <div className="gb-columns-title">Columns</div>
        <ul>
          {table?.columns.map((c) => (
            <li
              key={c.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(COLUMN_DRAG_TYPE, c.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className={picked === c.id ? 'picked' : ''}
              onClick={() => setPicked(picked === c.id ? null : c.id)}
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
              onClick={() => updateReport(report.id, (r) => ({ ...r, params: { ...r.params, elements: toggleElement(elements, e, single) } }))}
            >
              {ELEMENT_LABELS[e]}
            </button>
          ))}
          <span className="spacer" />
          {(x || y || overlay || groupX || groupY) && (
            <button className="link-button" onClick={() => updateReport(report.id, (r) => ({ ...r, roles: {}, params: { ...r.params, elements: [] } }))}>
              Start over
            </button>
          )}
        </div>
        {notes.length > 0 && <p className="gb-note">{notes.join(' ')}</p>}
        <div className="gb-canvas">
          <div className="gb-top">
            {zone('group_x')}
            {zone('overlay')}
          </div>
          {zone('y')}
          <div className="gb-plot">
            {x || y ? (
              <PlotlyChart
                data={graph.data}
                layout={layout}
                height={height}
                uirevision={[x?.name, x?.modelingType, y?.name, y?.modelingType, overlay?.name, groupX?.name, groupY?.name, elements.join()].join('|')}
                pointRows={(curve, point) => graph.lookup[curve]?.(point)}
              />
            ) : (
              <div className="gb-empty">Drag a column to the X or Y zone to start a graph.</div>
            )}
          </div>
          {zone('group_y')}
          {zone('x')}
        </div>
      </div>
    </div>
  )
}
