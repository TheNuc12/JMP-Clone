"""Statistical process control helpers shared by control charts and capability."""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np
from scipy import integrate, special, stats

# Mean (d2) and standard deviation (d3) of the range of n standard normal values,
# computed by numerical integration (they match published tables to the digits shown there).
_RANGE_CONSTANTS: dict[int, tuple[float, float]] = {
    2: (1.128379, 0.852502),
    3: (1.692569, 0.888368),
    4: (2.058751, 0.879808),
    5: (2.325929, 0.864082),
    6: (2.534413, 0.848040),
    7: (2.704357, 0.833205),
    8: (2.847201, 0.819831),
    9: (2.970026, 0.807834),
    10: (3.077505, 0.797051),
    11: (3.172873, 0.787315),
    12: (3.258455, 0.778478),
    13: (3.335980, 0.770416),
    14: (3.406763, 0.763023),
    15: (3.471827, 0.756211),
    16: (3.531983, 0.749908),
    17: (3.587884, 0.744052),
    18: (3.640064, 0.738591),
    19: (3.688963, 0.733481),
    20: (3.734950, 0.728686),
    21: (3.778336, 0.724173),
    22: (3.819385, 0.719915),
    23: (3.858323, 0.715887),
    24: (3.895348, 0.712068),
    25: (3.930629, 0.708441),
}


@lru_cache(maxsize=None)
def _range_constants(n: int) -> tuple[float, float]:
    if n in _RANGE_CONSTANTS:
        return _RANGE_CONSTANTS[n]
    # Larger subgroups: integrate directly (slow, but rare and cached).
    d2_n = integrate.quad(lambda x: 1 - stats.norm.cdf(x) ** n - stats.norm.sf(x) ** n, -np.inf, np.inf)[0]

    def cdf(r: float) -> float:
        g = lambda x: stats.norm.pdf(x) * (stats.norm.cdf(x + r) - stats.norm.cdf(x)) ** (n - 1)
        return n * integrate.quad(g, -12, 12, limit=400)[0]

    er2 = 2 * integrate.quad(lambda r: r * (1 - cdf(r)), 0, 20, limit=400)[0]
    return d2_n, math.sqrt(max(er2 - d2_n**2, 0.0))


def d2(n: int) -> float:
    return _range_constants(n)[0]


def d3(n: int) -> float:
    return _range_constants(n)[1]


def c4(n: int) -> float:
    """Bias correction for the sample standard deviation: E[s] = c4 * sigma."""
    return math.sqrt(2.0 / (n - 1)) * math.exp(special.gammaln(n / 2) - special.gammaln((n - 1) / 2))


# Derived chart constants (as in published tables).
def a2(n: int) -> float:
    return 3 / (d2(n) * math.sqrt(n))


def d3_lower(n: int) -> float:
    """D3: lower R-chart limit factor."""
    return max(0.0, 1 - 3 * d3(n) / d2(n))


def d4_upper(n: int) -> float:
    """D4: upper R-chart limit factor."""
    return 1 + 3 * d3(n) / d2(n)


def a3(n: int) -> float:
    return 3 / (c4(n) * math.sqrt(n))


def b3(n: int) -> float:
    c = c4(n)
    return max(0.0, 1 - 3 * math.sqrt(1 - c * c) / c)


def b4(n: int) -> float:
    c = c4(n)
    return 1 + 3 * math.sqrt(1 - c * c) / c


# ------------------------------------------------------------------ subgroups


@dataclass
class Subgroup:
    label: str
    positions: list[int]  # request positions with a usable value
    values: np.ndarray


def make_subgroups(
    values: np.ndarray,
    labels: list[str | None] | None = None,
    size: int | None = None,
) -> list[Subgroup]:
    """Split finite values into subgroups.

    With ``labels``, rows sharing a label form a subgroup, ordered by first appearance
    (rows with a missing label are skipped). Otherwise consecutive non-missing values are
    chunked into groups of ``size`` (the last group may be smaller). Without either, every
    value is its own subgroup.
    """
    finite = [i for i in range(values.size) if math.isfinite(values[i])]
    if labels is not None:
        groups: dict[str, list[int]] = {}
        for i in finite:
            if labels[i] is not None:
                groups.setdefault(labels[i], []).append(i)
        return [Subgroup(label, pos, values[pos]) for label, pos in groups.items()]
    size = max(1, int(size or 1))
    out = []
    for k, start in enumerate(range(0, len(finite), size)):
        pos = finite[start : start + size]
        out.append(Subgroup(str(k + 1), pos, values[pos]))
    return out


# ------------------------------------------------------------ sigma estimates


def moving_range_sigma(values: np.ndarray) -> float:
    """Within sigma from the average moving range of consecutive values: MR-bar / d2(2)."""
    v = values[np.isfinite(values)]
    if v.size < 2:
        return math.nan
    return float(np.mean(np.abs(np.diff(v)))) / d2(2)


def pooled_sigma(groups: list[np.ndarray]) -> float:
    """Pooled within-subgroup standard deviation."""
    num = sum(float(np.sum((g - g.mean()) ** 2)) for g in groups if g.size > 1)
    df = sum(g.size - 1 for g in groups if g.size > 1)
    return math.sqrt(num / df) if df > 0 else math.nan


# --------------------------------------------------------------------- params


def param_float(params: dict[str, Any], key: str) -> float | None:
    """A numeric request parameter, or None when absent, blank or not a finite number."""
    value = params.get(key)
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def param_int(params: dict[str, Any], key: str) -> int | None:
    f = param_float(params, key)
    return int(round(f)) if f is not None else None
