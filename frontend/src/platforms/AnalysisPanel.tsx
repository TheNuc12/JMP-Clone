import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { AnalysisResult, Platform } from '../api/types'
import { Outline, ReportNodes, type PlotContext } from '../components/Report'
import { toAnalysisColumn } from '../lib/data'
import { findColumn, includedRows, useStore } from '../state/store'

interface Props {
  platform: Platform
  y: string
  x?: string
  options: Record<string, boolean>
  onOptionsChange: (options: Record<string, boolean>) => void
}

/**
 * One analysis (one Y, optionally one X) rendered as a report. Re-runs whenever its
 * options, the excluded rows or the columns' modeling types change.
 */
export function AnalysisPanel({ platform, y, x, options, onOptionsChange }: Props) {
  const table = useStore((s) => s.table)
  const excluded = useStore((s) => s.excluded)
  const yCol = findColumn(table, y)
  const xCol = x ? findColumn(table, x) : undefined
  const rows = useMemo(() => includedRows(excluded), [excluded])
  const optionsKey = JSON.stringify(options)

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!yCol || (x && !xCol)) return
    const controller = new AbortController()
    setLoading(true)
    api
      .analyze(
        {
          platform,
          y: toAnalysisColumn(yCol, rows),
          x: xCol ? toAnalysisColumn(xCol, rows) : null,
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
  }, [platform, yCol, xCol, x, rows, optionsKey])

  const ctx = useMemo<PlotContext>(
    () => ({ rows, columns: new Map((table?.columns ?? []).map((c) => [c.name, c])) }),
    [rows, table],
  )

  if (!yCol || (x && !xCol)) return <p className="report-text tone-warning">Column not found.</p>

  // Reports usually arrive wrapped in a single outline; hoist it so the menu sits on its header.
  const nodes = result?.nodes ?? []
  const hoisted = nodes.length === 1 && nodes[0].type === 'outline' ? nodes[0] : null
  const title = hoisted?.title ?? result?.title ?? (x ? `${y} by ${x}` : y)
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
        level={0}
      >
        {error && <p className="report-text tone-warning">{error}</p>}
        {result && <ReportNodes nodes={hoisted ? hoisted.children : nodes} ctx={ctx} />}
        {!result && !error && <p className="report-text">Computing…</p>}
      </Outline>
    </div>
  )
}
