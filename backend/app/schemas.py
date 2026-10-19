"""API contract between the Sift backend and frontend.

The frontend mirrors these types in ``frontend/src/api/types.ts``; keep the two in sync.

Design notes
------------
* The backend is stateless. The browser owns the data table and sends the column
  values an analysis needs with every request (only non-excluded rows).
* Categorical (ordinal / nominal) values are sent as strings - the frontend owns the
  value -> label conversion so both sides agree on level names. Continuous values are
  sent as numbers. Missing values are ``null``.
* An analysis returns a *report*: a tree of generic nodes (outlines, tables, summaries,
  text) plus plot specs. Plot specs carry only summary geometry (fitted curves, box
  statistics, bins, ...); the frontend draws the individual points from its own copy of
  the data so that row selection can be linked across every view.
* Numbers are sent raw; the frontend formats them. NaN / inf must never be serialised -
  use ``None`` instead.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

ModelingType = Literal["continuous", "ordinal", "nominal"]
DataType = Literal["numeric", "character"]
CellFormat = Literal["number", "integer", "pvalue", "percent", "text"]
Cell = Union[float, int, str, None]


# --------------------------------------------------------------------------- data


class SpecLimits(BaseModel):
    lsl: float | None = None
    target: float | None = None
    usl: float | None = None


class ColumnData(BaseModel):
    name: str
    data_type: DataType
    modeling_type: ModelingType
    values: list[float | int | str | None]
    # Column properties
    value_order: list[str] | None = None  # display order of categorical levels
    spec_limits: SpecLimits | None = None


class SavedModel(BaseModel):
    """A model attached to a table (e.g. by DOE) that Fit Model can launch with."""

    responses: list[str]
    effects: list[list[str]]  # each effect is a list of column names; repeats mean powers


class DataTablePayload(BaseModel):
    name: str
    n_rows: int
    columns: list[ColumnData]
    model: SavedModel | None = None


class SampleInfo(BaseModel):
    id: str
    name: str
    description: str
    n_rows: int
    n_cols: int


# ------------------------------------------------------------------------ requests


class AnalysisColumn(BaseModel):
    name: str
    modeling_type: ModelingType
    values: list[float | int | str | None]
    # Value Order column property: categorical levels listed here come first, in this order.
    levels: list[str] | None = None


Platform = Literal["distribution", "fit_y_by_x", "fit_model", "control_chart", "capability"]


class AnalyzeRequest(BaseModel):
    """One analysis. All value arrays have the same length and are in table row order.

    Platform-specific inputs:

    * ``fit_model``: ``roles["factors"]`` holds every column used by an effect.
      ``params["effects"]``: list of effects, each a list of factor names (a repeated
      name is a power, e.g. ``["x", "x"]``). ``params["personality"]``:
      ``"standard_least_squares"`` | ``"stepwise"`` (categorical Y always uses logistic).
      Stepwise also reads ``params["direction"]`` (``"forward"`` | ``"backward"`` |
      ``"mixed"``), ``params["p_enter"]`` and ``params["p_leave"]``.
    * ``control_chart``: ``params["chart_type"]``: ``"imr"`` | ``"xbar_r"`` | ``"xbar_s"`` |
      ``"p"`` | ``"np"`` | ``"c"`` | ``"u"``. Subgroups come from ``roles["subgroup"]`` (a
      label column) or ``params["subgroup_size"]`` (consecutive rows). Attribute charts
      take sample sizes from ``roles["sample_size"]`` or ``params["sample_size"]``.
      Optional ``params["lsl"|"target"|"usl"]`` add a capability section.
    * ``capability``: ``params["lsl"|"target"|"usl"]`` (at least one limit);
      optional ``roles["subgroup"]`` for the within-subgroup sigma.
    """

    platform: Platform
    y: AnalysisColumn
    x: AnalysisColumn | None = None
    roles: dict[str, list[AnalysisColumn]] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    # Option toggles keyed by OptionItem.key. Missing keys take the analysis default.
    options: dict[str, bool] = Field(default_factory=dict)


# ------------------------------------------------------------------------ plot specs


class BoxStats(BaseModel):
    q1: float
    median: float
    q3: float
    lower_whisker: float  # farthest observation within q1 - 1.5 * IQR
    upper_whisker: float  # farthest observation within q3 + 1.5 * IQR
    mean: float


class HistogramBins(BaseModel):
    start: float
    size: float
    end: float  # bin edges are start, start + size, ..., end


class NormalCurve(BaseModel):
    mu: float
    sigma: float


class ReferenceLine(BaseModel):
    label: str
    value: float


class HistogramPlot(BaseModel):
    kind: Literal["histogram"] = "histogram"
    column: str
    bins: HistogramBins
    box: BoxStats | None = None  # outlier box plot drawn above the histogram
    mean_ci: tuple[float, float] | None = None  # 95% CI of the mean (mean diamond)
    normal: NormalCurve | None = None  # fitted normal density overlay
    reference_lines: list[ReferenceLine] = Field(default_factory=list)  # e.g. spec limits


class BarPlot(BaseModel):
    kind: Literal["bar"] = "bar"
    column: str
    levels: list[str]
    counts: list[int]


class Curve(BaseModel):
    label: str
    x: list[float]
    y: list[float]
    lower: list[float] | None = None  # 95% confidence band of the fit
    upper: list[float] | None = None


class ScatterPlot(BaseModel):
    kind: Literal["scatter"] = "scatter"
    x: str
    y: str
    curves: list[Curve] = Field(default_factory=list)


class GroupSummary(BaseModel):
    level: str
    n: int
    mean: float | None
    ci_lower: float | None  # 95% CI of the mean using the pooled std error (means diamond)
    ci_upper: float | None
    box: BoxStats | None


class OnewayPlot(BaseModel):
    kind: Literal["oneway"] = "oneway"
    x: str
    y: str
    levels: list[str]
    groups: list[GroupSummary]  # one per level, same order as levels
    grand_mean: float | None
    show_diamonds: bool
    show_boxes: bool


class MosaicPlot(BaseModel):
    kind: Literal["mosaic"] = "mosaic"
    x: str
    y: str
    x_levels: list[str]
    y_levels: list[str]
    counts: list[list[int]]  # counts[i][j]: rows with x == x_levels[i] and y == y_levels[j]


class LogisticPlot(BaseModel):
    kind: Literal["logistic"] = "logistic"
    x: str
    y: str
    y_levels: list[str]
    curve_x: list[float]
    # len(y_levels) - 1 curves; cum_probs[k][i] = P(Y <= y_levels[k] | X = curve_x[i])
    cum_probs: list[list[float]]


class IndexedScatterPlot(BaseModel):
    """Points computed by the backend (residuals, actual by predicted, ...).

    ``indices[i]`` is the position of point i in the request's value arrays, which the
    frontend maps back to table rows for linked selection.
    """

    kind: Literal["indexed_scatter"] = "indexed_scatter"
    x_label: str
    y_label: str
    x: list[float]
    y: list[float]
    indices: list[int]
    curves: list[Curve] = Field(default_factory=list)
    hlines: list[ReferenceLine] = Field(default_factory=list)


class ControlPoint(BaseModel):
    label: str  # x-axis label: row number or subgroup label
    value: float | None  # plotted statistic (individual, mean, range, proportion, ...)
    center: float | None
    lcl: float | None
    ucl: float | None
    indices: list[int]  # request positions summarized by this point
    tests: list[int] = Field(default_factory=list)  # failed Nelson/Western Electric tests (1-8)


class ControlChartPlot(BaseModel):
    kind: Literal["control_chart"] = "control_chart"
    title: str  # e.g. "Individual Measurement of yield"
    y_label: str
    x_label: str
    points: list[ControlPoint]
    show_zones: bool = False  # draw 1 and 2 sigma zone lines


class ModelFactor(BaseModel):
    name: str
    kind: Literal["continuous", "categorical"]
    min: float | None = None  # continuous: observed range and mean
    max: float | None = None
    mean: float | None = None
    levels: list[str] | None = None  # categorical, in display order


class TermPart(BaseModel):
    """One factor's contribution to a design-matrix column.

    Continuous: ``(x - center) ** power``. Categorical (effect coding): 1 when the row's
    level equals ``level``, -1 when it equals the factor's last level, else 0.
    """

    factor: str
    center: float = 0.0
    power: int = 1
    level: str | None = None


class ModelTerm(BaseModel):
    label: str  # parameter name, e.g. "sex[F]" or "(height-62.55)*(weight-105.3)"
    parts: list[TermPart]  # empty for the intercept; the column is the product of parts


class LinearModelSpec(BaseModel):
    """Enough of a fitted least squares model for the frontend to predict and profile."""

    response: str
    factors: list[ModelFactor]
    terms: list[ModelTerm]
    coef: list[float]
    cov: list[list[float]]  # covariance of the estimates
    df_error: int
    rmse: float


class ProfilerPlot(BaseModel):
    kind: Literal["profiler"] = "profiler"
    model: LinearModelSpec


PlotSpec = Annotated[
    Union[
        HistogramPlot,
        BarPlot,
        ScatterPlot,
        OnewayPlot,
        MosaicPlot,
        LogisticPlot,
        IndexedScatterPlot,
        ControlChartPlot,
        ProfilerPlot,
    ],
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------------- report nodes


class TableColumn(BaseModel):
    name: str
    format: CellFormat = "number"


class TableNode(BaseModel):
    type: Literal["table"] = "table"
    title: str | None = None
    columns: list[TableColumn]
    rows: list[list[Cell]]


class SummaryItem(BaseModel):
    label: str
    value: Cell
    format: CellFormat = "number"


class SummaryNode(BaseModel):
    """Two-column label / value table, e.g. JMP's "Summary of Fit"."""

    type: Literal["summary"] = "summary"
    title: str | None = None
    items: list[SummaryItem]


class TextNode(BaseModel):
    type: Literal["text"] = "text"
    text: str
    tone: Literal["info", "warning", "equation"] = "info"


class CrosstabNode(BaseModel):
    """Contingency table; the frontend derives Total %, Col % and Row % from counts."""

    type: Literal["crosstab"] = "crosstab"
    row_title: str  # X column name
    col_title: str  # Y column name
    row_levels: list[str]
    col_levels: list[str]
    counts: list[list[int]]  # counts[i][j]: row level i, col level j


class PlotNode(BaseModel):
    type: Literal["plot"] = "plot"
    plot: PlotSpec


class OutlineNode(BaseModel):
    """Collapsible section with a title (JMP's outline box)."""

    type: Literal["outline"] = "outline"
    title: str
    closed: bool = False
    children: list[ReportNode]


class RowNode(BaseModel):
    """Lays its children out side by side."""

    type: Literal["row"] = "row"
    children: list[ReportNode]


ReportNode = Annotated[
    Union[OutlineNode, RowNode, TableNode, SummaryNode, TextNode, CrosstabNode, PlotNode],
    Field(discriminator="type"),
]

OutlineNode.model_rebuild()
RowNode.model_rebuild()


class OptionItem(BaseModel):
    """A toggle in the report's red-triangle menu."""

    key: str
    label: str
    value: bool
    enabled: bool = True


AnalysisKind = Literal[
    "distribution_continuous",
    "distribution_categorical",
    "bivariate",
    "oneway",
    "contingency",
    "logistic",
    "fit_model_least_squares",
    "fit_model_stepwise",
    "fit_model_logistic",
    "control_chart",
    "capability",
]


class AnalysisResult(BaseModel):
    analysis: AnalysisKind
    title: str
    options: list[OptionItem]
    nodes: list[ReportNode]


# ------------------------------------------------------------------------------- DOE


class DoeFactor(BaseModel):
    name: str
    kind: Literal["continuous", "categorical"]
    low: float | None = None  # continuous
    high: float | None = None
    levels: list[str] | None = None  # categorical (2 or more)


class DoeResponse(BaseModel):
    name: str
    goal: Literal["maximize", "minimize", "match_target", "none"] = "maximize"


class DoeRequest(BaseModel):
    design: Literal["full_factorial", "fractional_factorial", "response_surface", "custom"]
    factors: list[DoeFactor]
    responses: list[DoeResponse] = Field(default_factory=lambda: [DoeResponse(name="Y")])
    replicates: int = 0  # extra copies of the whole design
    center_points: int = 0  # continuous factors only
    randomize: bool = True
    seed: int | None = None
    # fractional_factorial (2-level continuous / 2-level categorical factors)
    resolution: int | None = None  # 3, 4 or 5; None picks the smallest design with resolution >= 4 if possible
    # response_surface (continuous factors)
    rsm_type: Literal["ccd", "box_behnken"] = "ccd"
    ccd_alpha: Literal["rotatable", "orthogonal", "face_centered"] = "rotatable"
    # custom (D-optimal): model effects as lists of factor names, and the run count
    model: list[list[str]] | None = None
    n_runs: int | None = None


class DoeResult(BaseModel):
    """A new design table (factors, empty responses, run order) plus design diagnostics."""

    table: DataTablePayload
    nodes: list[ReportNode]
