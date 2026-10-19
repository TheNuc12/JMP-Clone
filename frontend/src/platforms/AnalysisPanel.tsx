import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { AnalysisColumn, AnalysisResult, Platform } from '../api/types'
import type { MenuItem } from '../components/Menu'
import { Outline, ReportNodes, type PlotContext } from '../components/Report'
import { toAnalysisColumn } from '../lib/data'
import type { Column } from '../state/store'
import { findColumn, includedRows, useActiveTable, useExcluded } from '../state/store'

const versions = new WeakMap<Column, number>()
let nextVersion = 1

/** A number that changes whenever the column object is replaced. */
function columnVersion(column: Column | undefined): number {
  if (!column) return 0
  let v = versions.get(column)
  if (!v) versions.set(column, (v = nextVersion++))
  return v
}

interface Props {
  platform: Platform
  /** Column ids. */
  y: string
  x?: string
  /** Extra role columns by id, e.g. { factors: [...] } or { subgroup: [...] }. */
  roles?: Record<string, string[]>
  /** Request params, already in the backend's terms (column names, not ids). */
  params?: Record<string, unknown>
  options: Record<string, boolean>
  onOptionsChange: (options: Record<string, boolean>) => void
  /** Extra red-triangle actions, e.g. saving columns from a fitted model. */
  menuItems?: (result: AnalysisResult, ctx: PlotContext) => MenuItem[]
}

/**
 * One analysis rendered as a report. Re-runs whenever its inputs change: options, params,
 * excluded rows, or any column it uses (values, modeling type, value order, name).
 */
export function AnalysisPanel({ platform, y, x, roles, params, options, onOptionsChange, menuItems }: Props) {
  const table = useActiveTable()
  const excluded = useExcluded()
  const yCol = findColumn(table, y)
  const xCol = x ? findColumn(table, x) : undefined
  const rows = useMemo(() => includedRows(excluded), [excluded])
  const optionsKey = JSON.stringify(options)
  const paramsKey = JSON.stringify(params ?? {})

  // Changes whenever a role column is replaced (edited, renamed, retyped) or the roles change.
  const rolesKey = Object.entries(roles ?? {})
    .map(([role, ids]) => `${role}:${ids.map((id) => columnVersion(findColumn(table, id))).join(',')}`)
    .join(';')

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!yCol || (x && !xCol)) return
    const controller = new AbortController()
    setLoading(true)
    const requestRoles: Record<string, AnalysisColumn[]> = {}
    for (const [role, ids] of Object.entries(roles ?? {})) {
      requestRoles[role] = ids
        .map((id) => findColumn(table, id))
        .filter((c): c is Column => !!c)
        .map((c) => toAnalysisColumn(c, rows))
    }
    api
      .analyze(
        {
          platform,
          y: toAnalysisColumn(yCol, rows),
          x: xCol ? toAnalysisColumn(xCol, rows) : null,
          roles: requestRoles,
          params: JSON.parse(paramsKey),
          options: JSON.parse(optionsKey),
        },
        controller.signal,
      )
      .then((r) => {
        setResult(r)
        setError(null)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return
        setError(e.message)
        setLoading(false)
      })
    return () => controller.abort()
    // `roles` and `table` are captured through rolesKey.
  }, [platform, yCol, xCol, x, rolesKey, rows, optionsKey, paramsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo<PlotContext>(() => ({ rows, columns: new Map((table?.columns ?? []).map((c) => [c.name, c])) }), [rows, table])

  if (!yCol || (x && !xCol)) return <p className="report-text tone-warning">A column used by this report was deleted.</p>

  // Reports usually arrive wrapped in a single outline; hoist it so the menu sits on its header.
  const nodes = result?.nodes ?? []
  const hoisted = nodes.length === 1 && nodes[0].type === 'outline' ? nodes[0] : null
  const title = hoisted?.title ?? result?.title ?? (xCol ? `${yCol.name} by ${xCol.name}` : yCol.name)
  return (
    <div className={`analysis-panel${loading ? ' is-loading' : ''}`}>
      <Outline
        title={
          <>
            {title}
            {loading && <span className="spinner" aria-label="Computing" />}
          </>
        }
        options={result?.options}
        onToggleOption={(key, value) => onOptionsChange({ ...options, [key]: value })}
        menuItems={result && menuItems ? menuItems(result, ctx) : []}
        level={0}
      >
        {error && <p className="report-text tone-warning">{error}</p>}
        {result && <ReportNodes nodes={hoisted ? hoisted.children : nodes} ctx={ctx} />}
        {!result && !error && <p className="report-text">Computing…</p>}
      </Outline>
    </div>
  )
}
