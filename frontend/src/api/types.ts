// Mirrors backend/app/schemas.py - keep the two in sync.

export type ModelingType = 'continuous' | 'ordinal' | 'nominal'
export type DataType = 'numeric' | 'character'
export type CellFormat = 'number' | 'integer' | 'pvalue' | 'percent' | 'text'
export type Cell = number | string | null
export type Value = number | string | null

// ---------------------------------------------------------------- data

export interface ColumnData {
  name: string
  data_type: DataType
  modeling_type: ModelingType
  values: Value[]
}

export interface DataTablePayload {
  name: string
  n_rows: number
  columns: ColumnData[]
}

export interface SampleInfo {
  id: string
  name: string
  description: string
  n_rows: number
  n_cols: number
}

// ---------------------------------------------------------------- requests

export interface AnalysisColumn {
  name: string
  modeling_type: ModelingType
  values: Value[]
}

export type Platform = 'distribution' | 'fit_y_by_x'

export interface AnalyzeRequest {
  platform: Platform
  y: AnalysisColumn
  x?: AnalysisColumn | null
  options: Record<string, boolean>
}

// ---------------------------------------------------------------- plot specs

export interface BoxStats {
  q1: number
  median: number
  q3: number
  lower_whisker: number
  upper_whisker: number
  mean: number
}

export interface HistogramPlot {
  kind: 'histogram'
  column: string
  bins: { start: number; size: number; end: number }
  box: BoxStats | null
  mean_ci: [number, number] | null
  normal: { mu: number; sigma: number } | null
}

export interface BarPlot {
  kind: 'bar'
  column: string
  levels: string[]
  counts: number[]
}

export interface Curve {
  label: string
  x: number[]
  y: number[]
  lower?: number[] | null
  upper?: number[] | null
}

export interface ScatterPlot {
  kind: 'scatter'
  x: string
  y: string
  curves: Curve[]
}

export interface GroupSummary {
  level: string
  n: number
  mean: number | null
  ci_lower: number | null
  ci_upper: number | null
  box: BoxStats | null
}

export interface OnewayPlot {
  kind: 'oneway'
  x: string
  y: string
  levels: string[]
  groups: GroupSummary[]
  grand_mean: number | null
  show_diamonds: boolean
  show_boxes: boolean
}

export interface MosaicPlot {
  kind: 'mosaic'
  x: string
  y: string
  x_levels: string[]
  y_levels: string[]
  counts: number[][]
}

export interface LogisticPlot {
  kind: 'logistic'
  x: string
  y: string
  y_levels: string[]
  curve_x: number[]
  cum_probs: number[][]
}

export type PlotSpec = HistogramPlot | BarPlot | ScatterPlot | OnewayPlot | MosaicPlot | LogisticPlot

// ---------------------------------------------------------------- report nodes

export interface TableColumn {
  name: string
  format: CellFormat
}

export interface TableNode {
  type: 'table'
  title?: string | null
  columns: TableColumn[]
  rows: Cell[][]
}

export interface SummaryNode {
  type: 'summary'
  title?: string | null
  items: { label: string; value: Cell; format: CellFormat }[]
}

export interface TextNode {
  type: 'text'
  text: string
  tone: 'info' | 'warning' | 'equation'
}

export interface CrosstabNode {
  type: 'crosstab'
  row_title: string
  col_title: string
  row_levels: string[]
  col_levels: string[]
  counts: number[][]
}

export interface PlotNode {
  type: 'plot'
  plot: PlotSpec
}

export interface OutlineNode {
  type: 'outline'
  title: string
  closed: boolean
  children: ReportNode[]
}

export interface RowNode {
  type: 'row'
  children: ReportNode[]
}

export type ReportNode = OutlineNode | RowNode | TableNode | SummaryNode | TextNode | CrosstabNode | PlotNode

export interface OptionItem {
  key: string
  label: string
  value: boolean
  enabled: boolean
}

export type AnalysisKind =
  | 'distribution_continuous'
  | 'distribution_categorical'
  | 'bivariate'
  | 'oneway'
  | 'contingency'
  | 'logistic'

export interface AnalysisResult {
  analysis: AnalysisKind
  title: string
  options: OptionItem[]
  nodes: ReportNode[]
}
