// Report node builders (port of backend/app/report.py).

import type {
  CellFormat,
  OptionItem,
  OutlineNode,
  PlotNode,
  PlotSpec,
  ReportNode,
  RowNode,
  SummaryNode,
  TableNode,
  TextNode,
} from '../api/types'
import { formatG } from './pyformat'

type Maybe<T> = T | null | undefined | false

/** Recursively replace NaN and ±Infinity with null (they aren't valid report values). */
export function clean<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? value : null) as T
  if (Array.isArray(value)) return value.map((v) => clean(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clean(v)
    return out as T
  }
  return value
}

const present = <T,>(children: Maybe<T>[]): T[] => children.filter((c): c is T => c !== null && c !== undefined && c !== false)

export function outline(title: string, children: Maybe<ReportNode>[], closed = false): OutlineNode {
  return { type: 'outline', title, closed, children: present(children) }
}

export function row(...children: Maybe<ReportNode>[]): RowNode {
  return { type: 'row', children: present(children) }
}

/** Columns are names or [name, format] pairs; the default format is number. */
export function table(columns: (string | [string, CellFormat])[], rows: unknown[][], title: string | null = null): TableNode {
  return {
    type: 'table',
    title,
    columns: columns.map((c) => (typeof c === 'string' ? { name: c, format: 'number' } : { name: c[0], format: c[1] })),
    rows: rows.map((r) => clean(r) as TableNode['rows'][number]),
  }
}

/** Label / value summary from [label, value, format?] items. */
export function summary(items: ([string, unknown] | [string, unknown, CellFormat])[], title: string | null = null): SummaryNode {
  return {
    type: 'summary',
    title,
    items: items.map(([label, value, format = 'number']) => ({ label, value: clean(value) as SummaryNode['items'][number]['value'], format })),
  }
}

export function text(message: string, tone: TextNode['tone'] = 'info'): TextNode {
  return { type: 'text', text: message, tone }
}

export function warning(message: string): TextNode {
  return text(message, 'warning')
}

export function plot(spec: PlotSpec): PlotNode {
  return { type: 'plot', plot: clean(spec) }
}

/**
 * Merge requested option values over defaults ([key, label, default] triples). Disabled
 * options are reported with enabled=false and always evaluate to false.
 */
export function resolveOptions(
  defaults: [string, string, boolean][],
  requested: Record<string, boolean>,
  disabled: Iterable<string> = [],
): [Record<string, boolean>, OptionItem[]] {
  const off = new Set(disabled)
  const values: Record<string, boolean> = {}
  const items: OptionItem[] = []
  for (const [key, label, fallback] of defaults) {
    const value = Boolean(key in requested ? requested[key] : fallback)
    const enabled = !off.has(key)
    values[key] = value && enabled
    items.push({ key, label, value, enabled })
  }
  return [values, items]
}

/** A number with `sig` significant digits for equations and labels ("." when missing). */
export function fmtNum(x: number | null | undefined, sig = 5): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '.'
  if (x === 0) return '0'
  return formatG(x, sig)
}
