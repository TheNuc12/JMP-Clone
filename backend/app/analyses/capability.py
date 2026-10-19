"""Process capability: Cp, Cpk, Pp, Ppk and nonconformance against spec limits.

Inputs: a continuous Y; ``params["lsl"|"target"|"usl"]`` (at least one limit); optional
``roles["subgroup"]``. The within-subgroup sigma is the pooled subgroup standard deviation
when subgroups are given, otherwise the average moving range / d2(2) in row order. The
overall sigma is the sample standard deviation.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats

from .. import report as r
from ..schemas import AnalysisResult, AnalyzeRequest, HistogramPlot, NormalCurve, ReferenceLine
from .common import label_values, numeric_values
from .distribution import nice_bins
from .spc import make_subgroups, moving_range_sigma, param_float, pooled_sigma

Z975 = float(stats.norm.ppf(0.975))


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    y = req.y
    title = f"Process Capability of {y.name}"
    lsl, target, usl = (param_float(req.params, k) for k in ("lsl", "target", "usl"))
    raw = numeric_values(y)
    finite = np.isfinite(raw)
    values = raw[finite]

    children: list[Any] = []
    if y.modeling_type != "continuous":
        children.append(r.warning("Process capability needs a continuous column."))
        return _result(title, children)

    subgroup = (req.roles.get("subgroup") or [None])[0]
    if subgroup is not None:
        groups = make_subgroups(raw, label_values(subgroup))
        within = pooled_sigma([g.values for g in groups])
        method = f"Within sigma: pooled standard deviation of {len(groups)} subgroups of {subgroup.name}."
    else:
        within = moving_range_sigma(raw)
        method = "Within sigma: average moving range / d2(2), in row order."

    children.extend(capability_nodes(y.name, values, lsl, target, usl, within, method, n_missing=int(raw.size - values.size)))
    return _result(title, children)


def _result(title: str, children: list[Any]) -> AnalysisResult:
    return AnalysisResult(analysis="capability", title=title, options=[], nodes=[r.outline(title, children)])


def capability_nodes(
    name: str,
    values: np.ndarray,
    lsl: float | None,
    target: float | None,
    usl: float | None,
    within_sigma: float,
    within_method: str,
    n_missing: int = 0,
) -> list[Any]:
    """Histogram with spec limits, capability indices, sigma summary and nonconformance."""
    nodes: list[Any] = []
    n = int(values.size)
    if lsl is None and usl is None:
        nodes.append(r.warning("Enter at least one specification limit (LSL or USL) to compute capability."))
    if lsl is not None and usl is not None and lsl >= usl:
        nodes.append(r.warning("The lower spec limit must be below the upper spec limit."))
        lsl_ok, usl_ok = None, None
    else:
        lsl_ok, usl_ok = lsl, usl
    if n == 0:
        nodes.append(r.warning("No nonmissing values; nothing to analyze."))
        return nodes
    if n < 2:
        nodes.append(r.warning("Capability needs at least two values."))

    mean = float(values.mean())
    overall = float(values.std(ddof=1)) if n > 1 else math.nan
    within = within_sigma if math.isfinite(within_sigma) else math.nan
    if n > 1 and overall == 0:
        nodes.append(r.warning("All values are identical; capability indices are undefined."))

    refs = [ReferenceLine(label=label, value=v) for label, v in (("LSL", lsl), ("Target", target), ("USL", usl)) if v is not None]
    nodes.append(
        r.plot(
            HistogramPlot(
                column=name,
                bins=nice_bins(values),
                normal=NormalCurve(mu=mean, sigma=overall) if n > 1 and overall > 0 else None,
                reference_lines=refs,
            )
        )
    )

    have_limits = lsl_ok is not None or usl_ok is not None
    if have_limits:
        within_rows = _index_rows("C", mean, within, lsl_ok, usl_ok, n)
        overall_rows = _index_rows("P", mean, overall, lsl_ok, usl_ok, n)
        cpm = _cpm(mean, overall, lsl_ok, target, usl_ok)
        if cpm is not None:
            overall_rows.append(["Cpm", cpm, None, None])
        columns = [("Index", "text"), "Estimate", "Lower 95%", "Upper 95%"]
        nodes.append(
            r.outline(
                "Capability Indices",
                [
                    r.row(
                        r.table(columns, within_rows, title="Within Sigma"),
                        r.table(columns, overall_rows, title="Overall Sigma"),
                    ),
                    r.text("Confidence intervals: chi-square for Cp and Pp, Bissell's approximation for the others."),
                ],
            )
        )

    summary = [
        ("Mean", mean),
        ("Within Sigma", within),
        ("Overall Sigma", overall),
        ("Stability Index", overall / within if within and within > 0 else None),
        ("N", n, "integer"),
    ]
    if n_missing:
        summary.append(("N Missing", n_missing, "integer"))
    spec = [(label, v) for label, v in (("LSL", lsl), ("Target", target), ("USL", usl)) if v is not None]
    nodes.append(r.outline("Sigma", [r.summary(summary + spec), r.text(within_method)]))

    if have_limits:
        nodes.append(r.outline("Nonconformance", [_nonconformance(values, mean, within, overall, lsl_ok, usl_ok)]))
    return nodes


def capability_indices(mean: float, sigma: float, lsl: float | None, usl: float | None) -> dict[str, float | None]:
    """Cp, Cpk, Cpl and Cpu (or the P versions, given the overall sigma). None when undefined."""
    ok = math.isfinite(sigma) and sigma > 0
    cp = (usl - lsl) / (6 * sigma) if ok and lsl is not None and usl is not None else None
    cpl = (mean - lsl) / (3 * sigma) if ok and lsl is not None else None
    cpu = (usl - mean) / (3 * sigma) if ok and usl is not None else None
    sides = [v for v in (cpl, cpu) if v is not None]
    return {"p": cp, "pk": min(sides) if sides else None, "pl": cpl, "pu": cpu}


def _index_rows(prefix: str, mean: float, sigma: float, lsl: float | None, usl: float | None, n: int) -> list[list[Any]]:
    ix = capability_indices(mean, sigma, lsl, usl)
    rows = []
    for key in ("p", "pk", "pl", "pu"):
        value = ix[key]
        if key == "p":
            lo, hi = _cp_ci(value, n)
        else:
            lo, hi = _cpk_ci(value, n)
        rows.append([f"{prefix}{key}", value, lo, hi])
    return rows


def _cp_ci(cp: float | None, n: int) -> tuple[float | None, float | None]:
    if cp is None or n < 2:
        return None, None
    df = n - 1
    return cp * math.sqrt(stats.chi2.ppf(0.025, df) / df), cp * math.sqrt(stats.chi2.ppf(0.975, df) / df)


def _cpk_ci(cpk: float | None, n: int) -> tuple[float | None, float | None]:
    """Bissell's normal approximation."""
    if cpk is None or n < 2:
        return None, None
    half = Z975 * math.sqrt(1 / (9 * n) + cpk**2 / (2 * (n - 1)))
    return cpk - half, cpk + half


def _cpm(mean: float, sigma: float, lsl: float | None, target: float | None, usl: float | None) -> float | None:
    """Taguchi index: distance from target to the nearer limit over 3 * sqrt(sigma^2 + (mean - target)^2)."""
    if target is None or not math.isfinite(sigma) or (lsl is None and usl is None):
        return None
    tau = math.sqrt(sigma**2 + (mean - target) ** 2)
    if tau == 0:
        return None
    gaps = [g for g in ((target - lsl) if lsl is not None else None, (usl - target) if usl is not None else None) if g is not None]
    return min(gaps) / (3 * tau)


def _nonconformance(values: np.ndarray, mean: float, within: float, overall: float, lsl: float | None, usl: float | None):
    def expected(sigma: float, below: bool) -> float | None:
        limit = lsl if below else usl
        if limit is None or not math.isfinite(sigma) or sigma <= 0:
            return None
        z = (limit - mean) / sigma
        return float(stats.norm.cdf(z) if below else stats.norm.sf(z))

    n = values.size
    below_obs = float(np.sum(values < lsl)) / n if lsl is not None else None
    above_obs = float(np.sum(values > usl)) / n if usl is not None else None

    def total(a: float | None, b: float | None) -> float | None:
        parts = [p for p in (a, b) if p is not None]
        return sum(parts) if parts else None

    below = (below_obs, expected(within, True), expected(overall, True))
    above = (above_obs, expected(within, False), expected(overall, False))
    rows: list[list[Any]] = []
    if lsl is not None:
        rows.append(["Below LSL", *below])
    if usl is not None:
        rows.append(["Above USL", *above])
    rows.append(["Total Outside", *(total(a, b) for a, b in zip(below, above))])
    return r.table(
        [("Portion", "text"), ("Observed %", "percent"), ("Expected Within %", "percent"), ("Expected Overall %", "percent")],
        rows,
    )
