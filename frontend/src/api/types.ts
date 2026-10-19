// Mirrors backend/app/schemas.py - keep the two in sync.

export type ModelingType = 'continuous' | 'ordinal' | 'nominal'
export type DataType = 'numeric' | 'character'
export type CellFormat = 'number' | 'integer' | 'pvalue' | 'percent' | 'text'
export type Cell = number | string | null
export type Value = number | string | null

// ---------------------------------------------------------------- data

export interface SpecLimits {
  lsl?: number | null
  target?: number | null
  usl?: number | null
}

export interface ColumnData {
  name: string
  data_type: DataType
  modeling_type: ModelingType
  values: Value[]
  value_order?: string[] | null
  spec_limits?: SpecLimits | null
}

/** A model attached to a table (e.g. by DOE); effects are lists of column names. */
export interface SavedModel {
  responses: string[]
  effects: string[][]
}

export interface DataTablePayload {
  name: string
  n_rows: number
  columns: ColumnData[]
  model?: SavedModel | null
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
  /** Value Order column property. */
  levels?: string[] | null
}

export type Platform = 'distribution' | 'fit_y_by_x' | 'fit_model' | 'control_chart' | 'capability'

/** See AnalyzeRequest in backend/app/schemas.py for the roles and params each platform reads. */
export interface AnalyzeRequest {
  platform: Platform
  y: AnalysisColumn
  x?: AnalysisColumn | null
  roles?: Record<string, AnalysisColumn[]>
  params?: Record<string, unknown>
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

export interface ReferenceLine {
  label: string
  value: number
}

export interface HistogramPlot {
  kind: 'histogram'
  column: string
  bins: { start: number; size: number; end: number }
  box: BoxStats | null
  mean_ci: [number, number] | null
  normal: { mu: number; sigma: number } | null
  reference_lines?: ReferenceLine[]
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

/** Backend-computed points; indices[i] is point i's position in the request's value arrays. */
export interface IndexedScatterPlot {
  kind: 'indexed_scatter'
  x_label: string
  y_label: string
  x: number[]
  y: number[]
  indices: number[]
  curves: Curve[]
  hlines: ReferenceLine[]
}

export interface ControlPoint {
  label: string
  value: number | null
  center: number | null
  lcl: number | null
  ucl: number | null
  indices: number[]
  tests: number[]
}

export interface ControlChartPlot {
  kind: 'control_chart'
  title: string
  y_label: string
  x_label: string
  points: ControlPoint[]
  show_zones: boolean
}

export interface ModelFactor {
  name: string
  kind: 'continuous' | 'categorical'
  min?: number | null
  max?: number | null
  mean?: number | null
  levels?: string[] | null
}

/** Continuous: (x - center) ** power. Categorical: 1 at `level`, -1 at the last level, else 0. */
export interface TermPart {
  factor: string
  center: number
  power: number
  level?: string | null
}

export interface ModelTerm {
  label: string
  parts: TermPart[]
}

export interface LinearModelSpec {
  response: string
  factors: ModelFactor[]
  terms: ModelTerm[]
  coef: number[]
  cov: number[][]
  df_error: number
  rmse: number
}

export interface ProfilerPlot {
  kind: 'profiler'
  model: LinearModelSpec
}

export type PlotSpec =
  | HistogramPlot
  | BarPlot
  | ScatterPlot
  | OnewayPlot
  | MosaicPlot
  | LogisticPlot
  | IndexedScatterPlot
  | ControlChartPlot
  | ProfilerPlot

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
  | 'fit_model_least_squares'
  | 'fit_model_stepwise'
  | 'fit_model_logistic'
  | 'control_chart'
  | 'capability'

export interface AnalysisResult {
  analysis: AnalysisKind
  title: string
  options: OptionItem[]
  nodes: ReportNode[]
}

// ---------------------------------------------------------------- DOE

export interface DoeFactor {
  name: string
  kind: 'continuous' | 'categorical'
  low?: number | null
  high?: number | null
  levels?: string[] | null
}

export interface DoeResponse {
  name: string
  goal: 'maximize' | 'minimize' | 'match_target' | 'none'
}

export type DesignType = 'full_factorial' | 'fractional_factorial' | 'response_surface' | 'custom'

export interface DoeRequest {
  design: DesignType
  factors: DoeFactor[]
  responses?: DoeResponse[]
  replicates?: number
  center_points?: number
  randomize?: boolean
  seed?: number | null
  resolution?: number | null
  rsm_type?: 'ccd' | 'box_behnken'
  ccd_alpha?: 'rotatable' | 'orthogonal' | 'face_centered'
  model?: string[][] | null
  n_runs?: number | null
}

export interface DoeResult {
  table: DataTablePayload
  nodes: ReportNode[]
}
