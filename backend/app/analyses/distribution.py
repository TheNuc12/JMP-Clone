"""Distribution platform: univariate summaries of a continuous or categorical column."""

from __future__ import annotations

import math

import numpy as np
from scipy import stats
from statsmodels.stats.diagnostic import lilliefors

from .. import report as r
from ..schemas import (
    AnalysisColumn,
    AnalysisResult,
    BarPlot,
    HistogramBins,
    HistogramPlot,
    NormalCurve,
)
from .common import box_stats, label_values, levels_of, mean_ci, numeric_values, quantile

CONTINUOUS_OPTIONS = [
    ("fit_normal", "Fit Normal", False),
    ("outlier_box", "Outlier Box Plot", True),
]

QUANTILE_LABELS = [
    ("100.0% maximum", 1.0),
    ("99.5%", 0.995),
    ("97.5%", 0.975),
    ("90.0%", 0.90),
    ("75.0% quartile", 0.75),
    ("50.0% median", 0.50),
    ("25.0% quartile", 0.25),
    ("10.0%", 0.10),
    ("2.5%", 0.025),
    ("0.5%", 0.005),
    ("0.0% minimum", 0.0),
]


def nice_number(x: float) -> float:
    """Round a positive number up to 1, 2 or 5 times a power of ten."""
    if x <= 0 or not math.isfinite(x):
        return 1.0
    exp = math.floor(math.log10(x))
    frac = x / 10**exp
    for nice in (1.0, 2.0, 5.0, 10.0):
        if frac <= nice + 1e-9:
            return nice * 10**exp
    return 10.0 * 10**exp


def nearest_nice_number(x: float) -> float:
    """Round a positive number to the nearest 1, 2 or 5 times a power of ten."""
    if x <= 0 or not math.isfinite(x):
        return 1.0
    exp = math.floor(math.log10(x))
    frac = x / 10**exp
    nice = 1.0 if frac < 1.5 else 2.0 if frac < 3 else 5.0 if frac < 7 else 10.0
    return nice * 10**exp


def nice_bins(values: np.ndarray) -> HistogramBins:
    """Histogram bins with a 'nice' width; every value falls in [start, end)."""
    lo, hi = float(values.min()), float(values.max())
    if hi == lo:
        size = nice_number(abs(lo) * 0.1) if lo != 0 else 1.0
    else:
        target = max(5, min(50, math.ceil(math.log2(values.size) + 1)))
        size = nearest_nice_number((hi - lo) / target)
    start = math.floor(lo / size) * size
    n_bins = math.floor((hi - start) / size + 1e-9) + 1
    end = start + n_bins * size
    # Guard against floating point drift leaving the max on/over the right edge.
    while end <= hi:
        end += size
    return HistogramBins(start=_round(start, size), size=size, end=_round(end, size))


def _round(x: float, size: float) -> float:
    digits = max(0, -math.floor(math.log10(size)) + 2)
    return round(x, digits)


def continuous(col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    opts, items = r.resolve_options(CONTINUOUS_OPTIONS, options)
    raw = numeric_values(col)
    v = raw[np.isfinite(raw)]
    n, n_missing = v.size, raw.size - v.size
    title = f"Distribution of {col.name}"

    if n == 0:
        nodes = [
            r.outline(
                col.name,
                [
                    r.warning("No nonmissing values; nothing to analyze."),
                    r.summary([("N", 0, "integer"), ("N Missing", n_missing, "integer")]),
                ],
            )
        ]
        return AnalysisResult(analysis="distribution_continuous", title=title, options=items, nodes=nodes)

    mean = float(v.mean())
    sd = float(v.std(ddof=1)) if n > 1 else math.nan
    se = sd / math.sqrt(n) if n > 1 else math.nan
    ci = mean_ci(v)
    fit_normal = opts["fit_normal"] and n > 1 and sd > 0

    children = []
    if n == 1:
        children.append(r.warning("Only one nonmissing value; statistics that need a variance are unavailable."))
    elif sd == 0:
        children.append(r.warning("All values are identical; the standard deviation is zero."))

    children.append(
        r.plot(
            HistogramPlot(
                column=col.name,
                bins=nice_bins(v),
                box=box_stats(v) if opts["outlier_box"] else None,
                mean_ci=r.clean(ci) if ci is not None else None,
                normal=NormalCurve(mu=mean, sigma=sd) if fit_normal else None,
            )
        )
    )

    qs = quantile(v, [q for _, q in QUANTILE_LABELS])
    quantiles = r.outline(
        "Quantiles",
        [r.table([("Quantile", "text"), "Value"], [[label, q] for (label, _), q in zip(QUANTILE_LABELS, qs)])],
    )
    summary_stats = r.outline(
        "Summary Statistics",
        [
            r.summary(
                [
                    ("Mean", mean),
                    ("Std Dev", sd),
                    ("Std Err Mean", se),
                    ("Upper 95% Mean", ci[1] if ci else None),
                    ("Lower 95% Mean", ci[0] if ci else None),
                    ("N", n, "integer"),
                    ("N Missing", n_missing, "integer"),
                ]
            )
        ],
    )
    children.append(r.row(quantiles, summary_stats))

    if opts["fit_normal"]:
        if fit_normal:
            children.append(_fitted_normal(v, mean, sd))
        else:
            children.append(r.warning("Fit Normal needs at least two distinct values."))

    nodes = [r.outline(col.name, children)]
    return AnalysisResult(analysis="distribution_continuous", title=title, options=items, nodes=nodes)


def _fitted_normal(v: np.ndarray, mean: float, sd: float):
    n = v.size
    t = stats.t.ppf(0.975, n - 1)
    se = sd / math.sqrt(n)
    ss = (n - 1) * sd**2
    sigma_lo = math.sqrt(ss / stats.chi2.ppf(0.975, n - 1))
    sigma_hi = math.sqrt(ss / stats.chi2.ppf(0.025, n - 1))
    params = r.outline(
        "Parameter Estimates",
        [
            r.table(
                [("Type", "text"), ("Parameter", "text"), "Estimate", "Lower 95%", "Upper 95%"],
                [
                    ["Location", "μ", mean, mean - t * se, mean + t * se],
                    ["Dispersion", "σ", sd, sigma_lo, sigma_hi],
                ],
            )
        ],
    )
    if 3 <= n <= 5000:
        w, p = stats.shapiro(v)
        gof = r.table([("Test", "text"), "W", ("Prob<W", "pvalue")], [["Shapiro-Wilk", w, p]])
    else:
        d, p = lilliefors(v, dist="norm")
        gof = r.table(
            [("Test", "text"), "D", ("Prob>D", "pvalue")], [["Kolmogorov-Smirnov-Lilliefors", d, p]]
        )
    goodness = r.outline(
        "Goodness-of-Fit Test",
        [gof, r.text("Note: Ho = The data is from the Normal distribution. Small p-values reject Ho.")],
    )
    return r.outline("Fitted Normal Distribution", [params, goodness])


def categorical(col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    labels = label_values(col)
    present = [lab for lab in labels if lab is not None]
    levels = levels_of(present, col.levels)
    n, n_missing = len(present), len(labels) - len(present)
    title = f"Distribution of {col.name}"

    if n == 0:
        nodes = [
            r.outline(
                col.name,
                [
                    r.warning("No nonmissing values; nothing to analyze."),
                    r.summary([("N Missing", n_missing, "integer"), ("N Levels", 0, "integer")]),
                ],
            )
        ]
        return AnalysisResult(analysis="distribution_categorical", title=title, options=[], nodes=nodes)

    counts = {level: 0 for level in levels}
    for lab in present:
        counts[lab] += 1
    count_list = [counts[level] for level in levels]

    freq_rows = [[level, c, c / n] for level, c in zip(levels, count_list)]
    freq_rows.append(["Total", n, 1.0])
    children = [
        r.plot(BarPlot(column=col.name, levels=levels, counts=count_list)),
        r.outline(
            "Frequencies",
            [
                r.table([("Level", "text"), ("Count", "integer"), "Prob"], freq_rows),
                r.summary([("N Missing", n_missing, "integer"), ("N Levels", len(levels), "integer")]),
            ],
        ),
    ]
    nodes = [r.outline(col.name, children)]
    return AnalysisResult(analysis="distribution_categorical", title=title, options=[], nodes=nodes)
