"""Control charts: I-MR, Xbar-R, Xbar-S, P, NP, C and U, with Nelson tests.

Request inputs (values are in table row order):

* ``params["chart_type"]``: ``"imr"`` | ``"xbar_r"`` | ``"xbar_s"`` | ``"p"`` | ``"np"`` | ``"c"`` | ``"u"``.
* Subgroups: ``roles["subgroup"]`` (rows sharing a label form a subgroup, in order of first
  appearance; for I-MR it only labels the points) or ``params["subgroup_size"]``
  (consecutive non-missing values; Xbar charts default to 5).
* Attribute charts: Y holds counts per row (defectives for P/NP, defects for C/U) with
  sample sizes from ``roles["sample_size"]`` or ``params["sample_size"]``. P and NP charts
  also accept a categorical Y: each row is one unit, nonconforming when its level equals
  ``params["defect_level"]`` (default: the first level), counted per subgroup.
* ``params["lsl"|"target"|"usl"]`` on a variables chart add a capability section that uses
  the chart's within-subgroup sigma.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .. import report as r
from ..schemas import AnalysisResult, AnalyzeRequest, ControlChartPlot, ControlPoint
from .capability import capability_nodes
from .common import label_values, levels_of, numeric_values
from .spc import c4, d2, d3, make_subgroups, param_float, param_int

OPTIONS = [
    ("test_beyond_limits", "Test Beyond Limits", True),
    ("nelson_tests", "Nelson Tests 2–8", False),
    ("show_zones", "Show Zones", False),
]

CHART_NAMES = {
    "imr": "Individual & Moving Range",
    "xbar_r": "XBar & R",
    "xbar_s": "XBar & S",
    "p": "P",
    "np": "NP",
    "c": "C",
    "u": "U",
}

TEST_DESCRIPTIONS = {
    1: "One point beyond Zone A (outside the control limits)",
    2: "Nine points in a row on one side of the center line",
    3: "Six points in a row steadily increasing or decreasing",
    4: "Fourteen points in a row alternating up and down",
    5: "Two out of three points in a row in Zone A or beyond, on one side",
    6: "Four out of five points in a row in Zone B or beyond, on one side",
    7: "Fifteen points in a row in Zone C (within one sigma)",
    8: "Eight points in a row on both sides of center with none in Zone C",
}


@dataclass
class Point:
    label: str
    value: float | None
    center: float | None
    lcl: float | None
    ucl: float | None
    sigma: float | None  # standard deviation of the plotted statistic at this point
    indices: list[int]
    tests: list[int] = field(default_factory=list)


@dataclass
class Chart:
    title: str
    name: str  # short name for tables, e.g. "Individual"
    y_label: str
    points: list[Point]
    location: bool  # Nelson tests 2-8 and zones apply to location charts only
    process_sigma: float | None
    subgroup_size: float | None


class ChartError(Exception):
    """The data can't support the requested chart; the message becomes a warning."""


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    opts, items = r.resolve_options(OPTIONS, req.options)
    chart_type = str(req.params.get("chart_type") or "imr")
    y = req.y
    name = CHART_NAMES.get(chart_type)
    title = f"{name} Chart of {y.name}" if name else f"Control Chart of {y.name}"

    children: list[Any] = []
    charts: list[Chart] = []
    within: float | None = None
    method = ""
    try:
        if name is None:
            raise ChartError(f"Unknown chart type '{chart_type}'.")
        if chart_type in ("imr", "xbar_r", "xbar_s"):
            charts, within, method, notes = _variables_charts(req, chart_type)
        else:
            charts, notes = _attribute_charts(req, chart_type)
        children.extend(r.warning(n) for n in notes)
    except ChartError as exc:
        children.append(r.warning(str(exc)))

    failures = []
    for chart in charts:
        _run_tests(chart, opts["test_beyond_limits"], opts["nelson_tests"])
        x_label = _x_label(req, chart_type)
        plot = ControlChartPlot(
            title=chart.title,
            y_label=chart.y_label,
            x_label=x_label,
            points=[
                ControlPoint(
                    label=p.label,
                    value=r.clean(p.value),
                    center=r.clean(p.center),
                    lcl=r.clean(p.lcl),
                    ucl=r.clean(p.ucl),
                    indices=p.indices,
                    tests=p.tests,
                )
                for p in chart.points
            ],
            show_zones=opts["show_zones"] and chart.location,
        )
        children.append(r.outline(chart.title, [r.plot(plot)]))
        for k, p in enumerate(chart.points):
            for t in p.tests:
                failures.append([chart.name, k + 1, p.label, t, TEST_DESCRIPTIONS[t]])

    if charts:
        children.append(_limit_summaries(charts))
    if failures:
        children.append(
            r.outline(
                "Test Failures",
                [r.table([("Chart", "text"), ("Point", "integer"), ("Label", "text"), ("Test", "integer"), ("Description", "text")], failures)],
            )
        )

    lsl, target, usl = (param_float(req.params, k) for k in ("lsl", "target", "usl"))
    if charts and (lsl is not None or usl is not None):
        if within is None:
            children.append(r.warning("Spec limits apply to variables charts (I-MR, XBar-R, XBar-S) only."))
        else:
            raw = numeric_values(y)
            values = raw[np.isfinite(raw)]
            children.append(
                r.outline(
                    f"Process Capability of {y.name}",
                    capability_nodes(y.name, values, lsl, target, usl, within, method, n_missing=int(raw.size - values.size)),
                )
            )

    return AnalysisResult(analysis="control_chart", title=title, options=items, nodes=[r.outline(title, children)])


def _x_label(req: AnalyzeRequest, chart_type: str) -> str:
    subgroup = (req.roles.get("subgroup") or [None])[0]
    if subgroup is not None:
        return subgroup.name
    grouped = chart_type in ("xbar_r", "xbar_s") or (chart_type in ("p", "np") and req.y.modeling_type != "continuous")
    return "Subgroup" if grouped else "Sample"


# -------------------------------------------------------------------- variables


def _variables_charts(req: AnalyzeRequest, chart_type: str) -> tuple[list[Chart], float, str, list[str]]:
    y = req.y
    if y.modeling_type != "continuous":
        raise ChartError(f"{CHART_NAMES[chart_type]} charts need a continuous Y column.")
    raw = numeric_values(y)
    subgroup = (req.roles.get("subgroup") or [None])[0]
    labels = label_values(subgroup) if subgroup is not None else None
    notes: list[str] = []
    if int(np.isfinite(raw).sum()) == 0:
        raise ChartError("No nonmissing values; nothing to chart.")

    if chart_type == "imr":
        charts, sigma, method = _imr(y.name, raw, labels)
        if sigma == 0:
            notes.append("There is no variation between consecutive values; the control limits collapse onto the center line.")
        return charts, sigma, method, notes

    size = None if labels is not None else (param_int(req.params, "subgroup_size") or 5)
    groups = make_subgroups(raw, labels, size)
    sizes = [g.values.size for g in groups]
    usable = [g for g in groups if g.values.size >= 2]
    if not usable:
        raise ChartError("Subgroups need at least two values each to estimate the process sigma.")
    if len(usable) < len(groups):
        notes.append(f"{len(groups) - len(usable)} subgroup(s) with a single value have no range or standard deviation.")

    if chart_type == "xbar_r":
        sigma = float(np.mean([np.ptp(g.values) / d2(g.values.size) for g in usable]))
        method = "Within sigma: average of subgroup range / d2."
    else:
        sigma = float(np.mean([g.values.std(ddof=1) / c4(g.values.size) for g in usable]))
        method = "Within sigma: average of subgroup standard deviation / c4."
    if sigma == 0:
        notes.append("There is no variation within subgroups; the control limits collapse onto the center line.")
    grand = float(np.mean(np.concatenate([g.values for g in groups])))
    constant = len(set(sizes)) == 1

    means = []
    spread = []
    for g in groups:
        n = g.values.size
        se = sigma / math.sqrt(n)
        means.append(Point(g.label, float(g.values.mean()), grand, grand - 3 * se, grand + 3 * se, se, g.positions))
        if n < 2:
            spread.append(Point(g.label, None, None, None, None, None, g.positions))
        elif chart_type == "xbar_r":
            center, sd = d2(n) * sigma, d3(n) * sigma
            spread.append(Point(g.label, float(np.ptp(g.values)), center, max(0.0, center - 3 * sd), center + 3 * sd, sd, g.positions))
        else:
            cn = c4(n)
            center, sd = cn * sigma, sigma * math.sqrt(1 - cn * cn)
            spread.append(Point(g.label, float(g.values.std(ddof=1)), center, max(0.0, center - 3 * sd), center + 3 * sd, sd, g.positions))

    size_value = float(sizes[0]) if constant else None
    spread_name = "R" if chart_type == "xbar_r" else "S"
    charts = [
        Chart(f"XBar of {y.name}", "XBar", f"Mean of {y.name}", means, True, sigma, size_value),
        Chart(f"{spread_name} of {y.name}", spread_name, f"{'Range' if spread_name == 'R' else 'Std Dev'} of {y.name}", spread, False, sigma, size_value),
    ]
    return charts, sigma, method, notes


def _imr(name: str, raw: np.ndarray, labels: list[str | None] | None) -> tuple[list[Chart], float, str]:
    positions = [i for i in range(raw.size) if math.isfinite(raw[i])]
    values = raw[positions]
    if values.size < 2:
        raise ChartError("An Individual & Moving Range chart needs at least two values.")
    point_labels = [labels[i] if labels is not None and labels[i] is not None else str(k + 1) for k, i in enumerate(positions)]
    mr = np.abs(np.diff(values))
    mr_bar = float(mr.mean())
    sigma = mr_bar / d2(2)
    center = float(values.mean())
    individuals = [
        Point(point_labels[k], float(v), center, center - 3 * sigma, center + 3 * sigma, sigma, [positions[k]])
        for k, v in enumerate(values)
    ]
    mr_sd = d3(2) * sigma
    ranges = [
        Point(point_labels[k + 1], float(m), mr_bar, max(0.0, mr_bar - 3 * mr_sd), mr_bar + 3 * mr_sd, mr_sd, [positions[k + 1]])
        for k, m in enumerate(mr)
    ]
    charts = [
        Chart(f"Individual Measurement of {name}", "Individual", name, individuals, True, sigma, 1.0),
        Chart(f"Moving Range of {name}", "Moving Range", f"Moving Range of {name}", ranges, False, sigma, 2.0),
    ]
    return charts, sigma, "Within sigma: average moving range / d2(2)."


# -------------------------------------------------------------------- attribute


def _attribute_charts(req: AnalyzeRequest, chart_type: str) -> tuple[list[Chart], list[str]]:
    y = req.y
    subgroup = (req.roles.get("subgroup") or [None])[0]
    labels = label_values(subgroup) if subgroup is not None else None
    notes: list[str] = []
    needs_n = chart_type in ("p", "np", "u")

    if y.modeling_type != "continuous":
        if chart_type not in ("p", "np"):
            raise ChartError(f"{chart_type.upper()} charts need counts in a numeric Y column.")
        counts, sizes = _units_from_levels(y, req.params)
        size = None if labels is not None else param_int(req.params, "subgroup_size")
        if labels is None and not size:
            raise ChartError("A P or NP chart of a categorical column needs a subgroup column or a subgroup size.")
        groups = _group_counts(counts, sizes, labels, size)
    else:
        counts = numeric_values(y)
        if needs_n:
            sample_col = (req.roles.get("sample_size") or [None])[0]
            if sample_col is not None:
                sizes = numeric_values(sample_col)
            else:
                constant_n = param_float(req.params, "sample_size")
                if constant_n is None or constant_n <= 0:
                    raise ChartError(f"{chart_type.upper()} charts need sample sizes: a Sample Size column or a constant sample size.")
                sizes = np.full(counts.size, constant_n)
        else:
            sizes = np.ones(counts.size)
        if np.any(counts[np.isfinite(counts)] < 0):
            notes.append("Some counts are negative.")
        groups = _group_counts(counts, sizes, labels, None)

    groups = [g for g in groups if g[2] > 0]
    if not groups:
        raise ChartError("No usable counts; nothing to chart.")
    c = np.array([g[1] for g in groups], dtype=float)
    n = np.array([g[2] for g in groups], dtype=float)
    if chart_type in ("p", "np") and np.any(c > n):
        notes.append("Some counts exceed their sample size.")
    constant = bool(np.all(n == n[0]))

    points: list[Point] = []
    if chart_type in ("p", "np"):
        p_bar = float(c.sum() / n.sum())
        for (label, count, size, pos) in groups:
            sd_p = math.sqrt(p_bar * (1 - p_bar) / size)
            if chart_type == "p":
                points.append(Point(label, count / size, p_bar, max(0.0, p_bar - 3 * sd_p), min(1.0, p_bar + 3 * sd_p), sd_p, pos))
            else:
                center, sd = size * p_bar, size * sd_p
                points.append(Point(label, count, center, max(0.0, center - 3 * sd), min(size, center + 3 * sd), sd, pos))
        sigma = (points[0].sigma if constant else None)
        stat = "Proportion" if chart_type == "p" else "Count"
    elif chart_type == "c":
        c_bar = float(c.mean())
        sd = math.sqrt(c_bar)
        points = [Point(label, count, c_bar, max(0.0, c_bar - 3 * sd), c_bar + 3 * sd, sd, pos) for (label, count, _, pos) in groups]
        sigma, stat = sd, "Count"
    else:
        u_bar = float(c.sum() / n.sum())
        for (label, count, size, pos) in groups:
            sd = math.sqrt(u_bar / size)
            points.append(Point(label, count / size, u_bar, max(0.0, u_bar - 3 * sd), u_bar + 3 * sd, sd, pos))
        sigma = points[0].sigma if constant else None
        stat = "Defects per Unit"

    if all(p.sigma == 0 for p in points):
        notes.append("The center line is at a boundary (no defects or all defective); the limits have no width.")
    short = chart_type.upper()
    chart = Chart(f"{short} of {y.name}", short, f"{stat} of {y.name}", points, True, sigma, float(n[0]) if constant and needs_n else None)
    return [chart], notes


def _units_from_levels(y: Any, params: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """For a categorical Y: 1 for the nonconforming level, 0 otherwise, each row one unit."""
    labels = label_values(y)
    levels = levels_of(labels, y.levels)
    if not levels:
        raise ChartError("No nonmissing values; nothing to chart.")
    defect = params.get("defect_level")
    defect = defect if defect in levels else levels[0]
    counts = np.array([math.nan if lab is None else float(lab == defect) for lab in labels])
    sizes = np.array([math.nan if lab is None else 1.0 for lab in labels])
    return counts, sizes


def _group_counts(
    counts: np.ndarray, sizes: np.ndarray, labels: list[str | None] | None, size: int | None
) -> list[tuple[str, float, float, list[int]]]:
    """(label, total count, total sample size, positions) per point."""
    usable = [i for i in range(counts.size) if math.isfinite(counts[i]) and math.isfinite(sizes[i])]
    if labels is not None:
        groups: dict[str, list[int]] = {}
        for i in usable:
            if labels[i] is not None:
                groups.setdefault(labels[i], []).append(i)
        items = list(groups.items())
    elif size:
        items = [(str(k + 1), usable[s : s + size]) for k, s in enumerate(range(0, len(usable), size))]
    else:
        items = [(str(k + 1), [i]) for k, i in enumerate(usable)]
    return [(label, float(counts[pos].sum()), float(sizes[pos].sum()), pos) for label, pos in items]


# ------------------------------------------------------------------------ tests


def _run_tests(chart: Chart, beyond: bool, nelson: bool) -> None:
    """Flag Western Electric / Nelson test failures on the point that completes each pattern."""
    seq = [p for p in chart.points if p.value is not None and p.center is not None]
    tol = 1e-12
    for k, p in enumerate(seq):
        tests: list[int] = []
        if beyond and ((p.ucl is not None and p.value > p.ucl + tol) or (p.lcl is not None and p.value < p.lcl - tol)):
            tests.append(1)
        if nelson and chart.location:
            tests.extend(_nelson(seq, k))
        p.tests = tests


def _z(p: Point) -> float | None:
    if p.sigma is None or not p.sigma > 0:
        return None
    return (p.value - p.center) / p.sigma  # type: ignore[operator]


def _nelson(seq: list[Point], k: int) -> list[int]:
    def window(m: int) -> list[Point] | None:
        return seq[k - m + 1 : k + 1] if k + 1 >= m else None

    def zs(points: list[Point]) -> list[float] | None:
        out = [_z(p) for p in points]
        return None if any(z is None for z in out) else out  # type: ignore[return-value]

    failed = []
    z_now = _z(seq[k])
    w = window(9)
    if w and (z := zs(w)) and (all(v > 0 for v in z) or all(v < 0 for v in z)):
        failed.append(2)
    w = window(6)
    if w:
        d = np.diff([p.value for p in w])
        if np.all(d > 0) or np.all(d < 0):
            failed.append(3)
    w = window(14)
    if w:
        d = np.diff([p.value for p in w])
        if np.all(d != 0) and np.all(d[:-1] * d[1:] < 0):
            failed.append(4)
    if z_now is not None:
        w = window(3)
        if w and (z := zs(w)):
            if (z_now > 2 and sum(v > 2 for v in z) >= 2) or (z_now < -2 and sum(v < -2 for v in z) >= 2):
                failed.append(5)
        w = window(5)
        if w and (z := zs(w)):
            if (z_now > 1 and sum(v > 1 for v in z) >= 4) or (z_now < -1 and sum(v < -1 for v in z) >= 4):
                failed.append(6)
    w = window(15)
    if w and (z := zs(w)) and all(abs(v) < 1 for v in z):
        failed.append(7)
    w = window(8)
    if w and (z := zs(w)) and all(abs(v) > 1 for v in z):
        failed.append(8)
    return failed


# ---------------------------------------------------------------------- summary


def _limit_summaries(charts: list[Chart]):
    rows = []
    varying = False
    for chart in charts:
        pts = [p for p in chart.points if p.center is not None]
        same = bool(pts) and all(
            math.isclose(p.lcl or 0, pts[0].lcl or 0, abs_tol=1e-12) and math.isclose(p.ucl or 0, pts[0].ucl or 0, abs_tol=1e-12)
            and math.isclose(p.center or 0, pts[0].center or 0, abs_tol=1e-12)
            for p in pts
        )
        varying = varying or not same
        first = pts[0] if pts and same else None
        center = pts[0].center if pts and all(math.isclose(p.center, pts[0].center) for p in pts) else None  # type: ignore[arg-type]
        rows.append(
            [
                chart.name,
                first.lcl if first else None,
                center,
                first.ucl if first else None,
                chart.process_sigma,
                len(chart.points),
                chart.subgroup_size,
            ]
        )
    children = [r.table([("Chart", "text"), "LCL", "Center", "UCL", "Sigma", ("Points", "integer"), "Subgroup Size"], rows)]
    if varying:
        children.append(r.text("Limits vary with subgroup size; blank LCL / UCL cells mean the limits differ by point."))
    return r.outline("Limit Summaries", children)
