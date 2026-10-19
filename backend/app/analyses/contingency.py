"""Contingency platform: categorical Y by categorical X (mosaic, crosstab, chi-square tests)."""

from __future__ import annotations

import numpy as np
from scipy import stats

from .. import report as r
from ..schemas import AnalysisColumn, AnalysisResult, CrosstabNode, MosaicPlot
from .common import label_values, levels_of

OPTIONS = [
    ("contingency_table", "Contingency Table", True),
    ("tests", "Tests", True),
]


def crosstab(y_col: AnalysisColumn, x_col: AnalysisColumn):
    """Counts table (x levels by y levels) over rows where both are nonmissing."""
    pairs = [
        (xv, yv)
        for xv, yv in zip(label_values(x_col), label_values(y_col))
        if xv is not None and yv is not None
    ]
    x_levels = levels_of([p[0] for p in pairs])
    y_levels = levels_of([p[1] for p in pairs])
    xi = {lev: i for i, lev in enumerate(x_levels)}
    yi = {lev: j for j, lev in enumerate(y_levels)}
    counts = np.zeros((len(x_levels), len(y_levels)), dtype=int)
    for xv, yv in pairs:
        counts[xi[xv], yi[yv]] += 1
    return x_levels, y_levels, counts


def chi_square_tests(counts: np.ndarray) -> dict[str, float]:
    """Likelihood ratio and Pearson chi-square tests of independence."""
    n = counts.sum()
    expected = np.outer(counts.sum(axis=1), counts.sum(axis=0)) / n
    obs = counts.astype(float)
    nz = obs > 0
    g2 = 2.0 * float((obs[nz] * np.log(obs[nz] / expected[nz])).sum())
    pearson = float(((obs - expected) ** 2 / expected).sum())
    df = (counts.shape[0] - 1) * (counts.shape[1] - 1)
    col = counts.sum(axis=0)
    col = col[col > 0]
    reduced = -float((col * np.log(col / n)).sum())  # -LogLike of the Y-margin-only model
    return {
        "n": int(n),
        "df": int(df),
        "neg_loglike": g2 / 2.0,
        "rsquare_u": (g2 / 2.0) / reduced if reduced > 0 else float("nan"),
        "g2": g2,
        "p_g2": float(stats.chi2.sf(g2, df)),
        "pearson": pearson,
        "p_pearson": float(stats.chi2.sf(pearson, df)),
        "small_expected": float((expected < 5).mean()),
    }


def analyze(y_col: AnalysisColumn, x_col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    opts, items = r.resolve_options(OPTIONS, options)
    yname, xname = y_col.name, x_col.name
    title = f"Contingency Analysis of {yname} By {xname}"
    x_levels, y_levels, counts = crosstab(y_col, x_col)
    n = int(counts.sum())

    if n == 0:
        nodes = [r.outline(title, [r.warning(f"No rows with both {yname} and {xname} nonmissing.")])]
        return AnalysisResult(analysis="contingency", title=title, options=items, nodes=nodes)

    children: list = [
        r.outline(
            "Mosaic Plot",
            [r.plot(MosaicPlot(x=xname, y=yname, x_levels=x_levels, y_levels=y_levels, counts=counts.tolist()))],
        )
    ]
    if opts["contingency_table"]:
        children.append(
            r.outline(
                "Contingency Table",
                [
                    CrosstabNode(
                        row_title=xname,
                        col_title=yname,
                        row_levels=x_levels,
                        col_levels=y_levels,
                        counts=counts.tolist(),
                    )
                ],
            )
        )
    if opts["tests"]:
        children.append(_tests(counts, yname, xname))

    total = max(len(y_col.values), len(x_col.values))
    if n < total:
        children.append(r.text(f"{total - n} row(s) excluded for missing values."))
    return AnalysisResult(analysis="contingency", title=title, options=items, nodes=[r.outline(title, children)])


def _tests(counts: np.ndarray, yname: str, xname: str):
    if counts.shape[0] < 2 or counts.shape[1] < 2:
        return r.outline(
            "Tests",
            [r.warning(f"Tests need at least 2 levels of both {xname} and {yname}.")],
        )
    t = chi_square_tests(counts)
    children: list = [
        r.summary(
            [
                ("N", t["n"], "integer"),
                ("DF", t["df"], "integer"),
                ("-LogLike", t["neg_loglike"]),
                ("RSquare (U)", t["rsquare_u"]),
            ]
        ),
        r.table(
            [("Test", "text"), "ChiSquare", ("Prob>ChiSq", "pvalue")],
            [["Likelihood Ratio", t["g2"], t["p_g2"]], ["Pearson", t["pearson"], t["p_pearson"]]],
        ),
    ]
    if t["small_expected"] > 0.2:
        children.append(r.warning("Warning: 20% of cells have expected count less than 5, ChiSquare suspect."))
    if counts.shape == (2, 2):
        left = stats.fisher_exact(counts, alternative="less").pvalue
        right = stats.fisher_exact(counts, alternative="greater").pvalue
        two = stats.fisher_exact(counts, alternative="two-sided").pvalue
        children.append(
            r.outline(
                "Fisher's Exact Test",
                [
                    r.table(
                        [("Test", "text"), ("Prob", "pvalue"), ("Alternative Hypothesis", "text")],
                        [
                            ["Left", left, "Odds ratio is less than 1"],
                            ["Right", right, "Odds ratio is greater than 1"],
                            ["2-Tail", two, "Odds ratio is not equal to 1"],
                        ],
                    )
                ],
            )
        )
    return r.outline("Tests", children)
