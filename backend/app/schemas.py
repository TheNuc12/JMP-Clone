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

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

ModelingType = Literal["continuous", "ordinal", "nominal"]
DataType = Literal["numeric", "character"]
CellFormat = Literal["number", "integer", "pvalue", "percent", "text"]
Cell = Union[float, int, str, None]


# --------------------------------------------------------------------------- data


class ColumnData(BaseModel):
    name: str
    data_type: DataType
    modeling_type: ModelingType
    values: list[float | int | str | None]


class DataTablePayload(BaseModel):
    name: str
    n_rows: int
    columns: list[ColumnData]


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


class AnalyzeRequest(BaseModel):
    platform: Literal["distribution", "fit_y_by_x"]
    y: AnalysisColumn
    x: AnalysisColumn | None = None
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


class HistogramPlot(BaseModel):
    kind: Literal["histogram"] = "histogram"
    column: str
    bins: HistogramBins
    box: BoxStats | None = None  # outlier box plot drawn above the histogram
    mean_ci: tuple[float, float] | None = None  # 95% CI of the mean (mean diamond)
    normal: NormalCurve | None = None  # fitted normal density overlay


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


PlotSpec = Annotated[
    Union[HistogramPlot, BarPlot, ScatterPlot, OnewayPlot, MosaicPlot, LogisticPlot],
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
]


class AnalysisResult(BaseModel):
    analysis: AnalysisKind
    title: str
    options: list[OptionItem]
    nodes: list[ReportNode]
