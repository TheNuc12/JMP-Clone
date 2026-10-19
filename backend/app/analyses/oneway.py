"""Oneway platform: continuous Y by categorical X (ANOVA, t test, nonparametric tests)."""

from __future__ import annotations

import math
import warnings

import numpy as np
from scipy import stats

from .. import report as r
from ..schemas import AnalysisColumn, AnalysisResult, GroupSummary, OnewayPlot
from .common import box_stats, label_values, levels_of, numeric_values

OPTIONS = [
    ("means_anova", "Means/Anova", True),
    ("means_std", "Means and Std Dev", False),
    ("t_test", "t Test", False),
    ("box_plots", "Box Plots", False),
    ("unequal_variances", "Unequal Variances", False),
    ("nonparametric", "Nonparametric (Wilcoxon / Kruskal-Wallis)", False),
    ("tukey", "Compare Means: All Pairs, Tukey HSD", False),
]


def analyze(y_col: AnalysisColumn, x_col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    yname, xname = y_col.name, x_col.name
    y_all = numeric_values(y_col)
    x_all = label_values(x_col)
    keep = [i for i, (yv, xv) in enumerate(zip(y_all, x_all)) if xv is not None and math.isfinite(yv)]
    y = y_all[keep]
    xl = [x_all[i] for i in keep]
    levels = levels_of(xl, x_col.levels)
    groups = [y[[lab == level for lab in xl]] for level in levels] if keep else []
    n, k = y.size, len(levels)

    opts, items = r.resolve_options(OPTIONS, options, disabled=[] if k == 2 else ["t_test"])
    title = f"Oneway Analysis of {yname} By {xname}"

    if n == 0:
        nodes = [r.outline(title, [r.warning(f"No rows with both {yname} and {xname} nonmissing.")])]
        return AnalysisResult(analysis="oneway", title=title, options=items, nodes=nodes)

    grand = float(y.mean())
    ss_total = float(((y - grand) ** 2).sum())
    ss_error = float(sum(((g - g.mean()) ** 2).sum() for g in groups))
    ss_model = ss_total - ss_error
    df_model, df_error = k - 1, n - k
    mse = ss_error / df_error if df_error > 0 else math.nan
    t_crit = float(stats.t.ppf(0.975, df_error)) if df_error > 0 else math.nan

    summaries = []
    for level, g in zip(levels, groups):
        m = float(g.mean())
        half = t_crit * math.sqrt(mse / g.size) if df_error > 0 else math.nan
        summaries.append(
            GroupSummary(
                level=level,
                n=int(g.size),
                mean=m,
                ci_lower=r.clean(m - half),
                ci_upper=r.clean(m + half),
                box=box_stats(g),
            )
        )

    children: list = [
        r.plot(
            OnewayPlot(
                x=xname,
                y=yname,
                levels=levels,
                groups=summaries,
                grand_mean=grand,
                show_diamonds=opts["means_anova"],
                show_boxes=opts["box_plots"],
            )
        )
    ]

    if k < 2:
        children.append(r.warning(f"{xname} has only one level with data; at least 2 are needed to compare means."))
    elif df_error <= 0:
        children.append(r.warning("No degrees of freedom for error; each level has a single observation."))

    can_compare = k >= 2 and df_error > 0
    if opts["means_anova"] and can_compare:
        children.append(_anova(levels, groups, xname, n, ss_model, ss_error, ss_total, df_model, df_error, mse, grand, summaries))
    if opts["means_std"]:
        children.append(_means_std(levels, groups))
    if opts["t_test"]:
        children.append(_welch_t(levels, groups))
    if opts["unequal_variances"] and k >= 2:
        children.append(_unequal_variances(groups, n, k))
    if opts["nonparametric"] and k >= 2:
        children.append(_kruskal(levels, groups, y))
    if opts["tukey"] and can_compare:
        children.append(_tukey(levels, groups, mse))

    if n < len(y_all):
        children.append(r.text(f"{len(y_all) - n} row(s) excluded for missing values."))
    return AnalysisResult(analysis="oneway", title=title, options=items, nodes=[r.outline(title, children)])


def _anova(levels, groups, xname, n, ss_model, ss_error, ss_total, df_model, df_error, mse, grand, summaries):
    ms_model = ss_model / df_model
    f_ratio = ms_model / mse if mse > 0 else math.nan
    p = float(stats.f.sf(f_ratio, df_model, df_error)) if math.isfinite(f_ratio) else None
    rsq = ss_model / ss_total if ss_total > 0 else None
    adj = 1 - mse / (ss_total / (n - 1)) if ss_total > 0 else None
    means_rows = [
        [s.level, s.n, s.mean, math.sqrt(mse / s.n), s.ci_lower, s.ci_upper] for s in summaries
    ]
    return r.outline(
        "Oneway Anova",
        [
            r.outline(
                "Summary of Fit",
                [
                    r.summary(
                        [
                            ("Rsquare", rsq),
                            ("Adj Rsquare", adj),
                            ("Root Mean Square Error", math.sqrt(mse)),
                            ("Mean of Response", grand),
                            ("Observations (or Sum Wgts)", n, "integer"),
                        ]
                    )
                ],
            ),
            r.outline(
                "Analysis of Variance",
                [
                    r.table(
                        [("Source", "text"), ("DF", "integer"), "Sum of Squares", "Mean Square", "F Ratio", ("Prob > F", "pvalue")],
                        [
                            [xname, df_model, ss_model, ms_model, f_ratio, p],
                            ["Error", df_error, ss_error, mse, None, None],
                            ["C. Total", n - 1, ss_total, None, None, None],
                        ],
                    )
                ],
            ),
            r.outline(
                "Means for Oneway Anova",
                [
                    r.table(
                        [("Level", "text"), ("Number", "integer"), "Mean", "Std Error", "Lower 95%", "Upper 95%"],
                        means_rows,
                    ),
                    r.text("Std Error uses a pooled estimate of error variance"),
                ],
            ),
        ],
    )


def _means_std(levels, groups):
    rows = []
    for level, g in zip(levels, groups):
        m = float(g.mean())
        if g.size > 1:
            sd = float(g.std(ddof=1))
            sem = sd / math.sqrt(g.size)
            half = float(stats.t.ppf(0.975, g.size - 1)) * sem
            rows.append([level, g.size, m, sd, sem, m - half, m + half])
        else:
            rows.append([level, g.size, m, None, None, None, None])
    return r.outline(
        "Means and Std Deviations",
        [
            r.table(
                [("Level", "text"), ("Number", "integer"), "Mean", "Std Dev", "Std Err Mean", "Lower 95%", "Upper 95%"],
                rows,
            )
        ],
    )


def welch_t(a: np.ndarray, b: np.ndarray) -> dict[str, float]:
    """Welch two-sample t test of mean(b) - mean(a)."""
    va, vb = a.var(ddof=1) / a.size, b.var(ddof=1) / b.size
    diff = float(b.mean() - a.mean())
    se = math.sqrt(va + vb)
    df = (va + vb) ** 2 / (va**2 / (a.size - 1) + vb**2 / (b.size - 1))
    t = diff / se
    half = float(stats.t.ppf(0.975, df)) * se
    return {
        "diff": diff,
        "se": se,
        "upper": diff + half,
        "lower": diff - half,
        "t": t,
        "df": df,
        "p_two": float(2 * stats.t.sf(abs(t), df)),
        "p_gt": float(stats.t.sf(t, df)),
        "p_lt": float(stats.t.cdf(t, df)),
    }


def _welch_t(levels, groups):
    a, b = groups
    title = "t Test"
    if a.size < 2 or b.size < 2 or (a.var() == 0 and b.var() == 0):
        return r.outline(title, [r.warning("The t test needs at least 2 rows per level and nonzero variance.")])
    w = welch_t(a, b)
    return r.outline(
        title,
        [
            r.text(f"{levels[1]}-{levels[0]}"),
            r.text("Assuming unequal variances"),
            r.summary(
                [
                    ("Difference", w["diff"]),
                    ("Std Err Dif", w["se"]),
                    ("Upper CL Dif", w["upper"]),
                    ("Lower CL Dif", w["lower"]),
                    ("Confidence", 0.95),
                    ("t Ratio", w["t"]),
                    ("DF", w["df"]),
                    ("Prob > |t|", w["p_two"], "pvalue"),
                    ("Prob > t", w["p_gt"], "pvalue"),
                    ("Prob < t", w["p_lt"], "pvalue"),
                ]
            ),
        ],
    )


def welch_anova(groups: list[np.ndarray]) -> tuple[float, float, float, float]:
    """Welch's ANOVA allowing unequal variances: (F, df_num, df_den, p)."""
    k = len(groups)
    n = np.array([g.size for g in groups], dtype=float)
    means = np.array([g.mean() for g in groups])
    var = np.array([g.var(ddof=1) for g in groups])
    w = n / var
    sw = w.sum()
    mw = (w * means).sum() / sw
    a = (w * (means - mw) ** 2).sum() / (k - 1)
    tmp = (((1 - w / sw) ** 2) / (n - 1)).sum()
    b = 1 + 2 * (k - 2) / (k**2 - 1) * tmp
    f = a / b
    df2 = (k**2 - 1) / (3 * tmp)
    return float(f), float(k - 1), float(df2), float(stats.f.sf(f, k - 1, df2))


def _unequal_variances(groups, n, k):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        bf = stats.levene(*groups, center="median")
        lev = stats.levene(*groups, center="mean")
        bart = stats.bartlett(*groups) if all(g.size > 1 for g in groups) else None
    rows = [
        ["Brown-Forsythe", bf.statistic, k - 1, n - k, bf.pvalue],
        ["Levene", lev.statistic, k - 1, n - k, lev.pvalue],
    ]
    if bart is not None:
        rows.append(["Bartlett", bart.statistic, k - 1, None, bart.pvalue])
    children = [
        r.table(
            [("Test", "text"), "F Ratio", ("DFNum", "integer"), ("DFDen", "integer"), ("p-Value", "pvalue")],
            rows,
        )
    ]
    if all(g.size > 1 for g in groups) and all(g.var() > 0 for g in groups):
        f, d1, d2, p = welch_anova(groups)
        children.append(
            r.outline(
                "Welch's Test",
                [
                    r.text("Welch Anova testing Means Equal, allowing Std Devs Not Equal"),
                    r.summary([("F Ratio", f), ("DFNum", int(d1), "integer"), ("DFDen", d2), ("Prob > F", p, "pvalue")]),
                ],
            )
        )
    else:
        children.append(r.warning("Welch's test needs at least 2 rows and nonzero variance in every level."))
    return r.outline("Tests that the Variances are Equal", children)


def _kruskal(levels, groups, y):
    n = y.size
    rows = []
    for level, g, gr in zip(levels, groups, _group_ranks(groups)):
        score_sum = float(gr.sum())
        rows.append([level, g.size, score_sum, g.size * (n + 1) / 2, score_sum / g.size])
    if np.all(y == y[0]):
        test = [r.warning("All responses are tied; the Kruskal-Wallis test is undefined.")]
    else:
        h, p = stats.kruskal(*groups)
        test = [r.summary([("ChiSquare", h), ("DF", len(groups) - 1, "integer"), ("Prob>ChiSq", p, "pvalue")])]
    return r.outline(
        "Wilcoxon / Kruskal-Wallis Tests (Rank Sums)",
        [
            r.table(
                [("Level", "text"), ("Count", "integer"), "Score Sum", "Expected Score", "Score Mean"],
                rows,
            ),
            r.outline("1-Way Test, ChiSquare Approximation", test),
        ],
    )


def _group_ranks(groups):
    """Midranks of the pooled data, split back into the groups."""
    pooled = np.concatenate(groups)
    pooled_ranks = stats.rankdata(pooled)
    out, start = [], 0
    for g in groups:
        out.append(pooled_ranks[start : start + g.size])
        start += g.size
    return out


def _tukey(levels, groups, mse):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = stats.tukey_hsd(*groups)
        ci = res.confidence_interval(confidence_level=0.95)
    rows = []
    k = len(levels)
    for i in range(k):
        for j in range(i + 1, k):
            diff = float(res.statistic[i, j])
            a, b = (i, j) if diff >= 0 else (j, i)
            se = math.sqrt(mse * (1 / groups[a].size + 1 / groups[b].size))
            rows.append(
                [
                    levels[a],
                    levels[b],
                    float(res.statistic[a, b]),
                    se,
                    float(ci.low[a, b]),
                    float(ci.high[a, b]),
                    float(res.pvalue[a, b]),
                ]
            )
    rows.sort(key=lambda row: row[2], reverse=True)
    return r.outline(
        "Means Comparisons: Tukey HSD",
        [
            r.outline(
                "Ordered Differences Report",
                [
                    r.table(
                        [("Level", "text"), ("- Level", "text"), "Difference", "Std Err Dif", "Lower CL", "Upper CL", ("p-Value", "pvalue")],
                        rows,
                    )
                ],
            )
        ],
    )
