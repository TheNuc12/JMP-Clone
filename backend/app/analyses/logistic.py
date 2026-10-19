"""Logistic platform: categorical Y by continuous X.

Binary and nominal responses use (multinomial) logistic regression with the last level as
the reference. Ordinal responses with more than two levels use a cumulative logit model,
reported as ``logit P(Y <= k) = Intercept[k] + slope * x``.
"""

from __future__ import annotations

import math
import warnings

import numpy as np
import statsmodels.api as sm
from scipy import stats
from scipy.special import expit
from statsmodels.miscmodels.ordinal_model import OrderedModel

from .. import report as r
from ..schemas import AnalysisColumn, AnalysisResult, LogisticPlot
from .common import grid, label_values, levels_of, numeric_values

OPTIONS = [("odds_ratios", "Odds Ratios", False)]


class FitResult:
    """Model-independent summary of a fitted logistic model."""

    def __init__(self, terms, estimates, std_errors, slopes, neg_llf, n_params, cum_probs, notes):
        self.terms: list[str] = terms
        self.estimates = np.asarray(estimates, dtype=float)
        self.std_errors = np.asarray(std_errors, dtype=float)
        self.slopes: list[int] = slopes  # indices of slope terms (for odds ratios)
        self.neg_llf: float = neg_llf
        self.n_params: int = n_params
        self.cum_probs = cum_probs  # callable: x grid -> (L-1, len(x)) cumulative probabilities
        self.notes: list[str] = notes


def fit_binary(x: np.ndarray, y_idx: np.ndarray, levels: list[str], xname: str) -> FitResult:
    """logit P(Y = levels[0]) = b0 + b1 * x."""
    endog = (y_idx == 0).astype(float)
    res = sm.Logit(endog, sm.add_constant(x, has_constant="add")).fit(disp=0, maxiter=200)
    b = res.params

    def cum(gx):
        return np.array([expit(b[0] + b[1] * gx)])

    return FitResult(
        ["Intercept", xname], b, res.bse, [1], -float(res.llf), 2, cum,
        [f"For log odds of {levels[0]}/{levels[1]}"],
    )


def fit_nominal(x: np.ndarray, y_idx: np.ndarray, levels: list[str], xname: str) -> FitResult:
    """Multinomial logit; log odds of each level versus the last level."""
    L = len(levels)
    # statsmodels uses code 0 as the reference, so map the last level to 0.
    codes = np.where(y_idx == L - 1, 0, y_idx + 1)
    res = sm.MNLogit(codes, sm.add_constant(x, has_constant="add")).fit(disp=0, maxiter=200)
    params, bse = np.asarray(res.params), np.asarray(res.bse)  # shape (2, L-1); column c -> level c
    terms, est, se, slopes = [], [], [], []
    for c in range(L - 1):
        terms += [f"Intercept[{levels[c]}]", f"{xname}[{levels[c]}]"]
        est += [params[0, c], params[1, c]]
        se += [bse[0, c], bse[1, c]]
        slopes.append(len(terms) - 1)

    def cum(gx):
        pred = np.asarray(res.predict(sm.add_constant(gx, has_constant="add")))
        probs = np.column_stack([pred[:, 1:], pred[:, :1]])  # back to level order
        return np.cumsum(probs, axis=1)[:, : L - 1].T

    notes = [f"For log odds of {lev}/{levels[-1]}" for lev in levels[:-1]]
    return FitResult(terms, est, se, slopes, -float(res.llf), 2 * (L - 1), cum, notes)


def fit_ordinal(x: np.ndarray, y_idx: np.ndarray, levels: list[str], xname: str) -> FitResult:
    """Cumulative logit with a common slope: logit P(Y <= k) = a_k + b * x."""
    L = len(levels)
    model = OrderedModel(y_idx, x[:, None], distr="logit")
    res = model.fit(method="bfgs", disp=0, maxiter=1000)
    p = np.asarray(res.params)
    cov = np.asarray(res.cov_params())
    # params = [beta, thr0, log(thr1 - thr0), ...]; P(Y <= k) = F(thr_k - beta * x)
    thresholds = np.asarray(model.transform_threshold_params(p))[1:-1]
    # Delta method for the thresholds: d thr_k / d thr0 = 1, d thr_k / d delta_i = exp(delta_i), i <= k.
    jac = np.zeros((L - 1, L))
    jac[:, 1] = 1.0
    for k in range(1, L - 1):
        for i in range(1, k + 1):
            jac[k, 1 + i] = math.exp(p[1 + i])
    thr_se = np.sqrt(np.diag(jac @ cov @ jac.T))
    slope, slope_se = -p[0], math.sqrt(cov[0, 0])

    terms = [f"Intercept[{levels[k]}]" for k in range(L - 1)] + [xname]
    est = list(thresholds) + [slope]
    se = list(thr_se) + [slope_se]

    def cum(gx):
        return np.array([expit(thresholds[k] + slope * gx) for k in range(L - 1)])

    notes = ["Cumulative logit: log odds of P(Y <= level) for each Intercept[level]"]
    return FitResult(terms, est, se, [len(terms) - 1], -float(res.llf), L, cum, notes)


def analyze(y_col: AnalysisColumn, x_col: AnalysisColumn, options: dict[str, bool]) -> AnalysisResult:
    opts, items = r.resolve_options(OPTIONS, options)
    yname, xname = y_col.name, x_col.name
    title = f"Logistic Fit of {yname} By {xname}"
    y_all, x_all = label_values(y_col), numeric_values(x_col)
    keep = [i for i, (yv, xv) in enumerate(zip(y_all, x_all)) if yv is not None and math.isfinite(xv)]
    x = x_all[keep]
    y = [y_all[i] for i in keep]
    levels = levels_of(y)
    n, L = len(keep), len(levels)

    def result(children):
        if n < len(y_all):
            children.append(r.text(f"{len(y_all) - n} row(s) excluded for missing values."))
        return AnalysisResult(analysis="logistic", title=title, options=items, nodes=[r.outline(title, children)])

    if L < 2:
        return result([r.warning(f"{yname} needs at least 2 levels with data for a logistic fit.")])
    if n < 3 or np.all(x == x[0]):
        return result([r.warning(f"{xname} must vary across at least 3 rows for a logistic fit.")])

    index = {lev: i for i, lev in enumerate(levels)}
    y_idx = np.array([index[v] for v in y])
    ordinal = y_col.modeling_type == "ordinal" and L > 2

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            if L == 2:
                fit = fit_binary(x, y_idx, levels, xname)
            elif ordinal:
                fit = fit_ordinal(x, y_idx, levels, xname)
            else:
                fit = fit_nominal(x, y_idx, levels, xname)
        except Exception as exc:  # singular matrices, separation, etc.
            return result([r.warning(f"The logistic model could not be fit: {exc}")])
    unstable = (
        any(
            type(w.message).__name__ in {"PerfectSeparationWarning", "ConvergenceWarning", "HessianInversionWarning"}
            for w in caught
        )
        or fit.neg_llf < 1e-6  # fitted probabilities are all 0 or 1: complete separation
        or not np.all(np.isfinite(fit.std_errors))
        or bool(np.any(fit.std_errors > 100 * (np.abs(fit.estimates) + 1)))
    )

    counts = np.bincount(y_idx, minlength=L)
    reduced = -float((counts * np.log(counts / n)).sum())
    full = fit.neg_llf
    diff = reduced - full
    df = len(fit.slopes)
    chisq = 2 * diff
    k = fit.n_params
    aicc = 2 * full + 2 * k + (2 * k * (k + 1) / (n - k - 1) if n - k - 1 > 0 else math.nan)
    bic = 2 * full + k * math.log(n)

    gx = grid(float(x.min()), float(x.max()))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cum = np.clip(np.asarray(fit.cum_probs(gx), dtype=float), 0.0, 1.0)

    children: list = []
    if unstable:
        children.append(
            r.warning("Unstable fit: the model did not converge cleanly (possibly quasi-complete separation). Estimates may be unreliable.")
        )
    children.append(
        r.plot(LogisticPlot(x=xname, y=yname, y_levels=levels, curve_x=r.clean(gx), cum_probs=r.clean(cum)))
    )
    children.append(
        r.outline(
            "Whole Model Test",
            [
                r.table(
                    [("Model", "text"), "-LogLikelihood", ("DF", "integer"), "ChiSquare", ("Prob>ChiSq", "pvalue")],
                    [
                        ["Difference", diff, df, chisq, float(stats.chi2.sf(chisq, df))],
                        ["Full", full, None, None, None],
                        ["Reduced", reduced, None, None, None],
                    ],
                ),
                r.summary(
                    [
                        ("RSquare (U)", diff / reduced if reduced > 0 else None),
                        ("AICc", aicc),
                        ("BIC", bic),
                        ("Observations (or Sum Wgts)", n, "integer"),
                    ]
                ),
            ],
        )
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        wald = (fit.estimates / fit.std_errors) ** 2
    param_rows = [
        [term, est, se, w, float(stats.chi2.sf(w, 1)) if math.isfinite(w) else None]
        for term, est, se, w in zip(fit.terms, fit.estimates, fit.std_errors, wald)
    ]
    children.append(
        r.outline(
            "Parameter Estimates",
            [
                r.table(
                    [("Term", "text"), "Estimate", "Std Error", "ChiSquare", ("Prob>ChiSq", "pvalue")],
                    param_rows,
                ),
                *[r.text(note) for note in fit.notes],
            ],
        )
    )
    if opts["odds_ratios"]:
        z = float(stats.norm.ppf(0.975))
        rows = []
        with np.errstate(over="ignore"):
            for i in fit.slopes:
                b, se = fit.estimates[i], fit.std_errors[i]
                rows.append([fit.terms[i], np.exp(b), np.exp(b - z * se), np.exp(b + z * se)])
        children.append(
            r.outline(
                "Odds Ratios",
                [
                    r.table([("Term", "text"), "Odds Ratio (per unit)", "Lower 95%", "Upper 95%"], rows),
                    r.text(f"Odds ratio for a one unit change in {xname}"),
                ],
            )
        )
    return result(children)
