"""Shared helpers for analyses: value cleaning, level ordering, box statistics."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np
from scipy import stats

from ..schemas import AnalysisColumn, BoxStats


def _is_float(label: str) -> bool:
    try:
        f = float(label)
    except (TypeError, ValueError):
        return False
    return not math.isnan(f)


def to_label(value: object) -> str | None:
    """Convert a raw categorical value to its label (None for missing)."""
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value):
            return None
        if value.is_integer():
            return str(int(value))
    label = str(value)
    return label if label != "" else None


def to_number(value: object) -> float:
    """Convert a raw continuous value to float (NaN for missing/unparseable)."""
    if value is None or isinstance(value, bool):
        return math.nan
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return math.nan


def numeric_values(column: AnalysisColumn) -> np.ndarray:
    """Column values as a float array; missing values are NaN."""
    return np.array([to_number(v) for v in column.values], dtype=float)


def label_values(column: AnalysisColumn) -> list[str | None]:
    return [to_label(v) for v in column.values]


def levels_of(labels: Sequence[str | None], order: Sequence[str] | None = None) -> list[str]:
    """Unique non-missing labels in display order.

    Labels named in ``order`` (the column's Value Order property) come first, in that order.
    The rest are sorted numerically if all are numbers, else as strings.
    """
    unique = {label for label in labels if label is not None}
    ordered = [label for label in dict.fromkeys(order or []) if label in unique]
    rest = unique.difference(ordered)
    if rest and all(_is_float(u) for u in rest):
        return ordered + sorted(rest, key=float)
    return ordered + sorted(rest)


def quantile(values: np.ndarray, q: float | Sequence[float]) -> np.ndarray | float:
    """JMP-style quantiles ((n+1)p definition, numpy's 'weibull' method)."""
    return np.quantile(values, q, method="weibull")


def box_stats(values: np.ndarray) -> BoxStats | None:
    """Outlier box plot statistics for finite values (None when empty)."""
    v = np.sort(values[np.isfinite(values)])
    if v.size == 0:
        return None
    q1, med, q3 = (float(x) for x in quantile(v, [0.25, 0.5, 0.75]))
    iqr = q3 - q1
    lo_fence, hi_fence = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    inside = v[(v >= lo_fence) & (v <= hi_fence)]
    lower = float(inside.min()) if inside.size else q1
    upper = float(inside.max()) if inside.size else q3
    return BoxStats(
        q1=q1,
        median=med,
        q3=q3,
        lower_whisker=min(lower, q1),
        upper_whisker=max(upper, q3),
        mean=float(v.mean()),
    )


def mean_ci(values: np.ndarray, level: float = 0.95) -> tuple[float, float] | None:
    """t-based confidence interval of the mean (None when n < 2)."""
    n = values.size
    if n < 2:
        return None
    m = float(values.mean())
    se = float(values.std(ddof=1)) / math.sqrt(n)
    t = float(stats.t.ppf(0.5 + level / 2, n - 1))
    return m - t * se, m + t * se


def is_constant(values: np.ndarray) -> bool:
    return values.size > 0 and bool(np.all(values == values[0]))


def grid(lo: float, hi: float, n: int = 100) -> np.ndarray:
    if lo == hi:
        return np.array([lo, hi], dtype=float)
    return np.linspace(lo, hi, n)
