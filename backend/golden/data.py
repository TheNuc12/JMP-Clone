"""Datasets shared by the golden cases: the app's samples plus synthetic edge cases."""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from app.samples import SAMPLES, get_sample

Value = float | int | str | None


def _clean(values: np.ndarray | list) -> list[Value]:
    out: list[Value] = []
    for v in values:
        if v is None or (isinstance(v, float) and np.isnan(v)):
            out.append(None)
        elif isinstance(v, (np.integer, int)) and not isinstance(v, bool):
            out.append(int(v))
        elif isinstance(v, (np.floating, float)):
            out.append(round(float(v), 4))
        else:
            out.append(str(v))
    return out


def _synthetic() -> dict[str, list[Value]]:
    rng = np.random.default_rng(20261020)
    n = 60
    x1 = rng.normal(10, 2, n)
    x2 = rng.uniform(0, 5, n)
    g3 = rng.choice(["A", "B", "C"], n)
    g2 = rng.choice(["L", "H"], n)
    effect = {"A": 0.0, "B": 1.5, "C": -1.0}
    y = 2 + 1.5 * x1 - x2 + np.array([effect[g] for g in g3]) + (g2 == "H") * 0.8 + rng.normal(0, 1, n)
    y = y.astype(object)
    for i in (4, 17, 33):
        y[i] = None
    g3 = g3.astype(object)
    g3[8] = None
    p = 1 / (1 + np.exp(-(x1 - 10) * 1.2))
    yb = np.where(rng.uniform(size=n) < p, "Yes", "No")
    latent = 0.8 * (x1 - 10) + rng.logistic(size=n)
    yo = np.where(latent < -1, "Low", np.where(latent < 1, "Mid", "High"))
    sizes = rng.integers(40, 80, n)
    defectives = rng.binomial(sizes, 0.08)
    defects = rng.poisson(4, n)
    return {
        "x1": _clean(x1),
        "x2": _clean(x2),
        "g3": _clean(list(g3)),
        "g2": _clean(g2),
        "y": _clean(list(y)),
        "yb": _clean(yb),
        "yo": _clean(yo),
        "batch": _clean(np.repeat(np.arange(1, 13), 5)),
        "sizes": _clean(sizes),
        "defectives": _clean(defectives),
        "defects": _clean(defects),
    }


def _tiny() -> dict[str, list[Value]]:
    """Degenerate inputs (8 rows)."""
    return {
        "const": [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
        "one": [3.5, None, None, None, None, None, None, None],
        "two": [1.0, 2.0, None, None, None, None, None, None],
        "allna": [None] * 8,
        "x": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
        "sep_y": ["a", "a", "a", "a", "b", "b", "b", "b"],
        "cat_one": ["k"] * 8,
        "cat_na": [None] * 8,
        "pair": ["p", "q", "p", "q", "p", "q", "p", "q"],
        "pair_y": [1.0, 2.0, 1.5, 2.5, 1.2, 2.2, 1.1, 2.4],
    }


def _factorial() -> dict[str, list[Value]]:
    """2^3 factorial, replicated, with center points: lack of fit and pure error."""
    rng = np.random.default_rng(7)
    base = np.array([[a, b, c] for a in (-1, 1) for b in (-1, 1) for c in (-1, 1)], dtype=float)
    pts = np.vstack([base, base, np.zeros((3, 3))])
    a, b, c = pts.T
    resp = 50 + 4 * a - 3 * b + 2 * a * b + 1.5 * a * a + rng.normal(0, 0.5, len(pts))
    cat = np.where(c > 0, "hi", np.where(c < 0, "lo", "mid"))
    return {"A": _clean(a), "B": _clean(b), "C": _clean(c), "Cat": _clean(cat), "Resp": _clean(resp)}


def _screening() -> dict[str, list[Value]]:
    """2^(4-1) fraction with D = ABC, so two-factor interactions are aliased in pairs."""
    rows = [[a, b, c, a * b * c] for a in (-1, 1) for b in (-1, 1) for c in (-1, 1)]
    a, b, c, d = np.array(rows, dtype=float).T
    rng = np.random.default_rng(11)
    resp = 20 + 3 * a + 2 * d + a * b + rng.normal(0, 0.3, 8)
    return {"A": _clean(a), "B": _clean(b), "C": _clean(c), "D": _clean(d), "Resp": _clean(resp)}


def _big() -> dict[str, list[Value]]:
    rng = np.random.default_rng(5)
    return {"z": _clean(rng.normal(0, 1, 6000))}


@lru_cache
def datasets() -> dict[str, dict[str, list[Value]]]:
    out = {sid: {c.name: list(c.values) for c in get_sample(sid).columns} for sid in SAMPLES}
    out.update(syn=_synthetic(), tiny=_tiny(), factorial=_factorial(), screening=_screening(), big=_big())
    return out
