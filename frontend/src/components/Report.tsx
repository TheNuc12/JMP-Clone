import { useState, type ReactNode } from 'react'
import type { CrosstabNode, OptionItem, PlotSpec, ReportNode, SummaryNode, TableNode } from '../api/types'
import { formatCell, formatNumber } from '../lib/format'
import { BarChart, HistogramChart } from '../plots/DistributionPlots'
import { LogisticChart, MosaicChart, OnewayChart, ScatterChart } from '../plots/FitPlots'
import type { Column } from '../state/store'
import { Menu } from './Menu'

/** What plots need to draw individual points: the rows the analysis used and the table's columns. */
export interface PlotContext {
  rows: number[]
  columns: Map<string, Column>
}

export function Outline({
  title,
  initiallyClosed = false,
  options,
  onToggleOption,
  children,
  level = 0,
}: {
  title: ReactNode
  initiallyClosed?: boolean
  options?: OptionItem[]
  onToggleOption?: (key: string, value: boolean) => void
  children: ReactNode
  level?: number
}) {
  const [open, setOpen] = useState(!initiallyClosed)
  return (
    <section className={`outline outline-l${Math.min(level, 2)}`}>
      <header className="outline-header">
        <button className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        {options && options.length > 0 && onToggleOption && (
          <Menu
            trigger={<span className="red-triangle" title="Options" aria-label="Options" />}
            triggerClassName="red-triangle-button"
            items={options.map((o) => ({
              label: o.label,
              checked: o.value,
              disabled: !o.enabled,
              onSelect: () => onToggleOption(o.key, !o.value),
            }))}
          />
        )}
        <span className="outline-title" onDoubleClick={() => setOpen(!open)}>
          {title}
        </span>
      </header>
      {open && <div className="outline-body">{children}</div>}
    </section>
  )
}

export function ReportNodes({ nodes, ctx, level = 1 }: { nodes: ReportNode[]; ctx: PlotContext; level?: number }) {
  return (
    <>
      {nodes.map((node, i) => (
        <ReportNodeView key={i} node={node} ctx={ctx} level={level} />
      ))}
    </>
  )
}

function ReportNodeView({ node, ctx, level }: { node: ReportNode; ctx: PlotContext; level: number }) {
  switch (node.type) {
    case 'outline':
      return (
        <Outline title={node.title} initiallyClosed={node.closed} level={level}>
          <ReportNodes nodes={node.children} ctx={ctx} level={level + 1} />
        </Outline>
      )
    case 'row':
      return (
        <div className="report-row">
          <ReportNodes nodes={node.children} ctx={ctx} level={level} />
        </div>
      )
    case 'table':
      return <TableView node={node} />
    case 'summary':
      return <SummaryView node={node} />
    case 'text':
      return <p className={`report-text tone-${node.tone}`}>{node.text}</p>
    case 'crosstab':
      return <CrosstabView node={node} />
    case 'plot':
      return (
        <div className="report-plot">
          <PlotView spec={node.plot} ctx={ctx} />
        </div>
      )
  }
}

function PlotView({ spec, ctx }: { spec: PlotSpec; ctx: PlotContext }) {
  switch (spec.kind) {
    case 'histogram':
      return <HistogramChart spec={spec} {...ctx} />
    case 'bar':
      return <BarChart spec={spec} {...ctx} />
    case 'scatter':
      return <ScatterChart spec={spec} {...ctx} />
    case 'oneway':
      return <OnewayChart spec={spec} {...ctx} />
    case 'mosaic':
      return <MosaicChart spec={spec} {...ctx} />
    case 'logistic':
      return <LogisticChart spec={spec} {...ctx} />
  }
}

function alignOf(format: string) {
  return format === 'text' ? 'text-cell' : 'num-cell'
}

function TableView({ node }: { node: TableNode }) {
  return (
    <div className="report-table-wrap">
      {node.title && <div className="report-table-title">{node.title}</div>}
      <table className="report-table">
        <thead>
          <tr>
            {node.columns.map((c, i) => (
              <th key={i} className={alignOf(c.format)}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const format = node.columns[c]?.format ?? 'number'
                const text = formatCell(cell, format)
                return (
                  <td key={c} className={`${alignOf(format)}${format === 'pvalue' && text.endsWith('*') ? ' significant' : ''}`}>
                    {text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SummaryView({ node }: { node: SummaryNode }) {
  return (
    <div className="report-table-wrap">
      {node.title && <div className="report-table-title">{node.title}</div>}
      <table className="report-table summary-table">
        <tbody>
          {node.items.map((item, i) => {
            const text = formatCell(item.value, item.format)
            return (
              <tr key={i}>
                <th className="text-cell">{item.label}</th>
                <td className={`num-cell${item.format === 'pvalue' && text.endsWith('*') ? ' significant' : ''}`}>{text}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function pct(n: number, d: number): string {
  return d ? `${formatNumber((100 * n) / d, 4)}` : ''
}

function CrosstabView({ node }: { node: CrosstabNode }) {
  const rowTotals = node.counts.map((row) => row.reduce((a, b) => a + b, 0))
  const colTotals = node.col_levels.map((_, j) => node.counts.reduce((a, row) => a + row[j], 0))
  const total = rowTotals.reduce((a, b) => a + b, 0)
  const cell = (count: number, row: number, col: number) => (
    <div className="crosstab-cell">
      <span>{count}</span>
      <span>{pct(count, total)}</span>
      <span>{pct(count, colTotals[col])}</span>
      <span>{pct(count, rowTotals[row])}</span>
    </div>
  )
  return (
    <div className="report-table-wrap">
      <table className="report-table crosstab">
        <thead>
          <tr>
            <th className="crosstab-corner" rowSpan={2}>
              <div className="crosstab-legend">
                <span>Count</span>
                <span>Total %</span>
                <span>Col %</span>
                <span>Row %</span>
              </div>
            </th>
            <th colSpan={node.col_levels.length + 1} className="crosstab-var">
              {node.col_title}
            </th>
          </tr>
          <tr>
            {node.col_levels.map((l) => (
              <th key={l} className="num-cell">
                {l}
              </th>
            ))}
            <th className="num-cell">Total</th>
          </tr>
        </thead>
        <tbody>
          {node.row_levels.map((level, i) => (
            <tr key={level}>
              <th className="text-cell">
                <span className="crosstab-rowvar">{i === 0 ? node.row_title : ''}</span> {level}
              </th>
              {node.counts[i].map((count, j) => (
                <td key={j}>{cell(count, i, j)}</td>
              ))}
              <td>
                <div className="crosstab-cell">
                  <span>{rowTotals[i]}</span>
                  <span>{pct(rowTotals[i], total)}</span>
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <th className="text-cell">Total</th>
            {colTotals.map((count, j) => (
              <td key={j}>
                <div className="crosstab-cell">
                  <span>{count}</span>
                  <span>{pct(count, total)}</span>
                </div>
              </td>
            ))}
            <td>
              <div className="crosstab-cell">
                <span>{total}</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
