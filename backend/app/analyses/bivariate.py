"""Bivariate platform: continuous Y by continuous X (scatter plot with fits)."""

from __future__ import annotations

import math
import warnings

import numpy as np
import statsmodels.api as sm
from scipy import stats

from .. import report as r
from ..schemas import AnalysisColumn, AnalysisResult, Curve, ScatterPlot
from .common import grid, numeric_values

OPTIONS = [
    ("fit_mean", "Fit Mean", False),
    ("fit_line", "Fit Line", True),
    ("fit_quadratic", "Fit Polynomial (Quadratic)", False),
    ("correlation", "Correlation", False),
]


def analyze(y_col: AnalysisColumn, x_col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    opts, items = r.resolve_options(OPTIONS, options)
    yname, xname = y_col.name, x_col.name
    y_all, x_all = numeric_values(y_col), numeric_values(x_col)
    keep = np.isfinite(y_all) & np.isfinite(x_all)
    x, y = x_all[keep], y_all[keep]
    n = x.size
    title = f"Bivariate Fit of {yname} By {xname}"

    nodes: list = []
    curves: list[Curve] = []
    reports: list = []

    if n < 2:
        nodes.append(r.warning(f"Only {n} row(s) with both {yname} and {xname} nonmissing; at least 2 are needed."))
    else:
        x_constant = bool(np.all(x == x[0]))
        if opts["fit_mean"]:
            curve, rep = _fit_mean(x, y)
            curves.append(curve)
            reports.append(rep)
        if opts["fit_line"] or opts["fit_quadratic"]:
            if x_constant:
                reports.append(r.warning(f"{xname} is constant; a regression line cannot be fit."))
            else:
                if opts["fit_line"]:
                    curve, rep = _poly_fit(x, y, 1, xname, yname)
                    curves.append(curve)
                    reports.append(rep)
                if opts["fit_quadratic"]:
                    if np.unique(x).size < 3:
                        reports.append(r.warning("A quadratic fit needs at least 3 distinct X values."))
                    else:
                        curve, rep = _poly_fit(x, y, 2, xname, yname)
                        curves.append(curve)
                        reports.append(rep)
        if opts["correlation"]:
            reports.append(_correlation(x, y, xname, yname))

    nodes.insert(0, r.plot(ScatterPlot(x=xname, y=yname, curves=curves)))
    nodes.extend(reports)
    if n < keep.size:
        nodes.append(r.text(f"{keep.size - n} row(s) excluded for missing values."))
    return AnalysisResult(
        analysis="bivariate", title=title, options=items, nodes=[r.outline(title, nodes)]
    )


def _fit_mean(x: np.ndarray, y: np.ndarray):
    n = y.size
    mean = float(y.mean())
    sd = float(y.std(ddof=1))
    xs = [float(x.min()), float(x.max())]
    curve = Curve(label="Fit Mean", x=xs, y=[mean, mean])
    rep = r.outline(
        "Fit Mean",
        [
            r.summary(
                [
                    ("Mean", mean),
                    ("Std Dev [RMSE]", sd),
                    ("Std Error", sd / math.sqrt(n)),
                    ("SSE", float(((y - mean) ** 2).sum())),
                ]
            )
        ],
    )
    return curve, rep


def _signed(coef: float) -> str:
    return f"- {r.fmt_num(-coef, 6)}" if coef < 0 else f"+ {r.fmt_num(coef, 6)}"


def _poly_fit(x: np.ndarray, y: np.ndarray, degree: int, xname: str, yname: str):
    """OLS linear (degree 1) or centered quadratic (degree 2) fit."""
    xbar = float(x.mean())
    if degree == 1:
        design = lambda xv: np.column_stack([np.ones_like(xv), xv])  # noqa: E731
        terms = ["Intercept", xname]
        heading = "Linear Fit"
    else:
        design = lambda xv: np.column_stack([np.ones_like(xv), xv, (xv - xbar) ** 2])  # noqa: E731
        centre = f"{xname}-{r.fmt_num(xbar, 6)}" if xbar >= 0 else f"{xname}+{r.fmt_num(-xbar, 6)}"
        terms = ["Intercept", xname, f"({centre})^2"]
        heading = "Polynomial Fit Degree=2"

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = sm.OLS(y, design(x)).fit()
        gx = grid(float(x.min()), float(x.max()))
        frame = fit.get_prediction(design(gx)).summary_frame(alpha=0.05)

    b = fit.params
    equation = f"{yname} = {r.fmt_num(b[0], 6)} {_signed(b[1])}*{xname}"
    if degree == 2:
        equation += f" {_signed(b[2])}*{terms[2]}"

    n = y.size
    df_model, df_error = int(fit.df_model), int(fit.df_resid)
    ss_model, ss_error, ss_total = float(fit.ess), float(fit.ssr), float(fit.centered_tss)
    ms_model = ss_model / df_model if df_model else None
    ms_error = ss_error / df_error if df_error else None
    f_ratio = ms_model / ms_error if ms_model is not None and ms_error else None
    p_f = float(stats.f.sf(f_ratio, df_model, df_error)) if f_ratio is not None else None

    children = [r.text(equation, "equation")]
    if df_error == 0:
        children.append(r.warning("No degrees of freedom for error; the fit is exact."))
    children += [
        r.outline(
            "Summary of Fit",
            [
                r.summary(
                    [
                        ("RSquare", fit.rsquared if ss_total > 0 else None),
                        ("RSquare Adj", fit.rsquared_adj if ss_total > 0 and df_error else None),
                        ("Root Mean Square Error", math.sqrt(ms_error) if ms_error is not None else None),
                        ("Mean of Response", float(y.mean())),
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
                        ["Model", df_model, ss_model, ms_model, f_ratio, p_f],
                        ["Error", df_error, ss_error, ms_error, None, None],
                        ["C. Total", n - 1, ss_total, None, None, None],
                    ],
                )
            ],
        ),
        r.outline(
            "Parameter Estimates",
            [
                r.table(
                    [("Term", "text"), "Estimate", "Std Error", "t Ratio", ("Prob>|t|", "pvalue")],
                    [
                        [term, est, se, t, p] if df_error else [term, est, None, None, None]
                        for term, est, se, t, p in zip(terms, b, fit.bse, fit.tvalues, fit.pvalues)
                    ],
                )
            ],
        ),
    ]
    has_band = df_error > 0
    curve = Curve(
        label=heading,
        x=r.clean(gx),
        y=r.clean(frame["mean"].to_numpy()),
        lower=r.clean(frame["mean_ci_lower"].to_numpy()) if has_band else None,
        upper=r.clean(frame["mean_ci_upper"].to_numpy()) if has_band else None,
    )
    return curve, r.outline(heading, children)


def _correlation(x: np.ndarray, y: np.ndarray, xname: str, yname: str):
    n = x.size
    if n < 3 or np.all(x == x[0]) or np.all(y == y[0]):
        corr = cov = p = None
        note = [r.warning("Correlation needs at least 3 rows and nonconstant variables.")]
    else:
        res = stats.pearsonr(x, y)
        corr, p = float(res.statistic), float(res.pvalue)
        cov = float(np.cov(x, y, ddof=1)[0, 1])
        note = []
    sd = lambda v: float(v.std(ddof=1)) if v.size > 1 else None  # noqa: E731
    return r.outline(
        "Correlation",
        note
        + [
            r.table(
                [("Variable", "text"), "Mean", "Std Dev"],
                [[xname, float(x.mean()), sd(x)], [yname, float(y.mean()), sd(y)]],
            ),
            r.summary(
                [
                    ("Correlation", corr),
                    ("Covariance", cov),
                    ("Signif. Prob", p, "pvalue"),
                    ("Number", n, "integer"),
                ]
            ),
        ],
    )
