"""Reference values for the TypeScript math library (frontend/src/engine/math).

Computes outputs of the scipy / statsmodels / numpy calls the analyses use, on a broad
grid of inputs, and writes them to frontend/src/engine/math/reference.json. Non-finite
numbers are written as the strings "Infinity", "-Infinity" and "NaN".

Run from backend/:  uv run python golden/math_reference.py
"""

from __future__ import annotations

import json
import math
import warnings
from pathlib import Path

import numpy as np
import statsmodels.api as sm
from scipy import integrate, special, stats
from statsmodels.miscmodels.ordinal_model import OrderedModel
from statsmodels.stats.diagnostic import lilliefors

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "engine" / "math" / "reference.json"


def enc(v):
    """JSON-safe copy: numpy to Python, non-finite floats to strings."""
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, np.ndarray):
        return enc(v.tolist())
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return f
    return v


def table(fn, *grids):
    """Rows [*args, fn(*args)] over the cartesian product of the argument grids."""
    rows = []
    for args in _product(grids):
        rows.append([*args, float(fn(*args))])
    return rows


def _product(grids):
    if not grids:
        yield ()
        return
    for head in grids[0]:
        for tail in _product(grids[1:]):
            yield (head, *tail)


# ------------------------------------------------------------------------- special


def special_reference():
    xs = [1e-300, 1e-8, 1e-3, 0.1, 0.5, 0.9, 1.0, 1.5, 2.0, 2.5, 3.0, 4.5, 7.3, 9.99, 10.0, 12.5, 30.0, 100.5, 1e3, 1e5, 1e10, 1e300]
    neg = [-0.5, -1.5, -2.3, -10.7]
    zs = [-30, -10, -6, -5, -3.2, -2, -1.4, -1, -0.7, -0.5, -0.3, -1e-3, 0, 1e-6, 0.2, 0.5, 0.6, 0.99, 1, 1.5, 2.2, 3, 4, 5.5, 6, 7.9, 8, 8.1, 10, 15, 20, 26, 27.5]
    ab = [0.5, 1, 2.5, 10, 37, 500, 5e4]
    bx = [1e-10, 1e-4, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.9999]
    ga = [0.5, 1, 1.7, 3, 9.5, 10, 25, 150, 5e3, 1e5]
    gx_rel = [1e-6, 0.01, 0.3, 0.8, 0.95, 1.0, 1.05, 1.3, 2, 5, 12]
    gamma_rows = []
    for a in ga:
        for r in gx_rel:
            x = a * r
            gamma_rows.append([a, x, float(special.gammainc(a, x)), float(special.gammaincc(a, x))])
    for a in ga:  # far tails relative to the spread sqrt(a)
        for dz in [-8, -4, 4, 8, 20]:
            x = a + dz * math.sqrt(a)
            if x > 0:
                gamma_rows.append([a, x, float(special.gammainc(a, x)), float(special.gammaincc(a, x))])
    beta_rows = []
    for a in ab:
        for b in ab:
            for x in bx:
                beta_rows.append([a, b, x, float(special.betainc(a, b, x)), float(special.betaincc(a, b, x))])
    for a in [10, 500, 5e4]:  # near the mean, where the large-parameter path matters
        m = a / (2 * a)
        for d in [-5e-3, -1e-3, 0, 1e-3, 5e-3]:
            x = m + d
            beta_rows.append([a, a, x, float(special.betainc(a, a, x)), float(special.betaincc(a, a, x))])
    inv_beta = []
    for a in [0.5, 2, 15, 400, 5e4]:
        for b in [0.5, 1, 7, 300]:
            for p in [1e-12, 1e-5, 0.025, 0.3, 0.5, 0.95, 0.999999]:
                inv_beta.append([a, b, p, float(special.betaincinv(a, b, p))])
    inv_gamma = []
    for a in [0.5, 1, 2.5, 40, 3000, 1e5]:
        for p in [1e-12, 1e-5, 0.025, 0.4, 0.5, 0.975, 0.999999]:
            inv_gamma.append([a, p, float(special.gammaincinv(a, p)), float(special.gammainccinv(a, p))])
    return {
        "gammaln": [[x, float(special.gammaln(x))] for x in xs + neg],
        "gamma": [[x, float(special.gamma(x))] for x in [0.1, 0.5, 1, 2.5, 5, 10.5, 33.3, 100, 170.5] + neg],
        "erf": [[z, float(special.erf(z))] for z in zs],
        "erfc": [[z, float(special.erfc(z))] for z in zs],
        "betainc": beta_rows,
        "betaincinv": inv_beta,
        "gammainc": gamma_rows,
        "gammaincinv": inv_gamma,
        "expit": [[z, float(special.expit(z))] for z in [-800, -40, -5, 0, 1e-9, 3, 40, 800]],
        "logsumexp": [[v, float(special.logsumexp(v))] for v in [[0.0, 0.0], [-1000.0, -1001.0, -999.5], [1.0, 2.0, 3.0, 700.0]]],
    }


# --------------------------------------------------------------------- distributions


def distribution_reference():
    xs = [-40, -9, -5, -2.5, -1.96, -1, -0.3, 0, 0.4, 1, 1.96, 3, 6, 9, 38]
    ps = [1e-300, 1e-100, 1e-15, 1e-8, 1e-3, 0.025, 0.1, 0.3, 0.5, 0.7, 0.9, 0.975, 0.999, 1 - 1e-9, 1 - 2**-52]
    dfs = [1, 2, 3, 4.5, 5, 10, 29, 30, 100, 1000, 1e5, 1e7]
    tq = [-60, -12.7, -4, -2.1, -1, -0.2, 0, 0.1, 0.7, 1.5, 2.2, 3.5, 8, 25, 400]
    cps = [1e-14, 1e-6, 0.001, 0.025, 0.05, 0.3, 0.5, 0.8, 0.95, 0.975, 0.995, 1 - 1e-7]
    chx = [1e-6, 0.01, 0.5, 1, 2.5, 3.84, 7, 12, 30, 80, 300, 1e4, 1e5 + 300]
    chdf = [1, 2, 3, 7, 30, 250, 1e5]
    fx = [1e-4, 0.05, 0.3, 1, 2.2, 4.1, 9, 40, 300, 1e4]
    fdf = [(1, 1), (1, 10), (2, 5), (3, 28), (5, 2), (10, 10), (4, 196), (30, 1000), (150, 7)]
    srange = []
    srange_grid = [
        (2, 2), (2, 10), (2, 1000), (3, 3), (3, 12), (3, 193), (4, 20), (5, 5), (5, 60), (8, 30), (10, 110), (3, 2e5),
    ]
    for k, df in srange_grid:
        for q in [0.05, 0.6, 1.5, 2.8, 3.6, 4.5, 6.0, 9.0, 16.0]:
            c = float(stats.studentized_range.cdf(q, k, df))
            srange.append([q, k, df, c, float(stats.studentized_range.sf(q, k, df))])
    srange_ppf = []
    for k, df in srange_grid[:-1]:
        for p in [0.5, 0.95, 0.99]:
            srange_ppf.append([p, k, df, float(stats.studentized_range.ppf(p, k, df))])
    hyper = []
    for M, n, N in [(10, 4, 5), (20, 7, 12), (60, 30, 25), (300, 120, 40)]:
        for k in sorted({0, 1, 2, n // 2, min(n, N) - 1, min(n, N)}):
            hyper.append([k, M, n, N, float(stats.hypergeom.pmf(k, M, n, N)), float(stats.hypergeom.cdf(k, M, n, N)), float(stats.hypergeom.sf(k, M, n, N))])
    return {
        "norm": [[x, float(stats.norm.pdf(x)), float(stats.norm.cdf(x)), float(stats.norm.sf(x))] for x in xs],
        "norm_loc_scale": [[x, 2.5, 3.0, float(stats.norm.pdf(x, 2.5, 3.0)), float(stats.norm.cdf(x, 2.5, 3.0)), float(stats.norm.sf(x, 2.5, 3.0))] for x in [-4, 0, 2.5, 9]],
        "norm_ppf": [[p, float(stats.norm.ppf(p)), float(stats.norm.isf(p))] for p in ps],
        "t": [[x, df, float(stats.t.pdf(x, df)), float(stats.t.cdf(x, df)), float(stats.t.sf(x, df))] for df in dfs for x in tq],
        "t_ppf": [[p, df, float(stats.t.ppf(p, df)), float(stats.t.isf(p, df))] for df in dfs for p in cps],
        "chi2": [[x, df, float(stats.chi2.pdf(x, df)), float(stats.chi2.cdf(x, df)), float(stats.chi2.sf(x, df))] for df in chdf for x in chx],
        "chi2_ppf": [[p, df, float(stats.chi2.ppf(p, df)), float(stats.chi2.isf(p, df))] for df in chdf for p in cps],
        "f": [[x, d1, d2, float(stats.f.pdf(x, d1, d2)), float(stats.f.cdf(x, d1, d2)), float(stats.f.sf(x, d1, d2))] for d1, d2 in fdf for x in fx],
        "f_ppf": [[p, d1, d2, float(stats.f.ppf(p, d1, d2)), float(stats.f.isf(p, d1, d2))] for d1, d2 in fdf for p in cps],
        "studentized_range": srange,
        "studentized_range_ppf": srange_ppf,
        "hypergeom": hyper,
    }


# --------------------------------------------------------------------------- linalg


def linalg_reference():
    rng = np.random.default_rng(11)
    cases = []
    for n, p in [(3, 3), (6, 4), (25, 7), (4, 6)]:
        a = rng.normal(size=(n, p)).round(3)
        s = np.linalg.svd(a, compute_uv=False)
        q, rmat = np.linalg.qr(a)
        entry = {"a": a, "singular_values": s, "rank": int(np.linalg.matrix_rank(a)), "pinv": np.linalg.pinv(a), "q": q, "r": rmat}
        if n == p:
            sign, logdet = np.linalg.slogdet(a)
            entry.update(inv=np.linalg.inv(a), det_sign=float(sign), logdet=float(logdet), solve_b=a[:, 0] + 1, solve_x=np.linalg.solve(a, a[:, 0] + 1))
        b = rng.normal(size=n).round(3)
        x, *_ = np.linalg.lstsq(a, b, rcond=None)
        entry.update(lstsq_b=b, lstsq_x=x)
        cases.append(entry)
    # Rank-deficient: a duplicated column and a column that is a combination of others.
    a = rng.normal(size=(9, 3)).round(2)
    a = np.column_stack([a, a[:, 0] - 2 * a[:, 2], a[:, 1]])
    b = rng.normal(size=9).round(2)
    x, *_ = np.linalg.lstsq(a, b, rcond=None)
    cases.append({"a": a, "singular_values": np.linalg.svd(a, compute_uv=False), "rank": int(np.linalg.matrix_rank(a)), "pinv": np.linalg.pinv(a), "lstsq_b": b, "lstsq_x": x})
    # DOE contrast matrices: Q of a QR factorization is used directly, so signs matter.
    contrasts = []
    for levels in range(2, 7):
        effect = np.vstack([np.eye(levels - 1), -np.ones(levels - 1)])
        centered = effect - effect.mean(axis=0)
        q, rmat = np.linalg.qr(centered)
        contrasts.append({"a": centered, "q": q, "r": rmat})
    sym = rng.normal(size=(5, 5))
    sym = (sym + sym.T).round(3)
    return {
        "cases": cases,
        "contrasts": contrasts,
        "eigh": {"a": sym, "values": np.linalg.eigh(sym)[0]},
        "singular_inv": [[1.0, 2.0], [2.0, 4.0]],
        "corrcoef": {"x": rng.normal(size=(12, 4)).round(2)},
    }


def corrcoef_reference(entry):
    entry["corrcoef"]["r"] = np.corrcoef(np.asarray(entry["corrcoef"]["x"]), rowvar=False)


# --------------------------------------------------------------------------- models


def ols_case(y, x, xnew):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = sm.OLS(y, x).fit()
        frame = fit.get_prediction(xnew).summary_frame(alpha=0.05)
    return {
        "y": y, "x": x, "xnew": xnew,
        "params": fit.params, "bse": fit.bse, "tvalues": fit.tvalues, "pvalues": fit.pvalues,
        "df_model": fit.df_model, "df_resid": fit.df_resid, "ess": fit.ess, "ssr": fit.ssr,
        "centered_tss": fit.centered_tss, "rsquared": fit.rsquared, "rsquared_adj": fit.rsquared_adj,
        "pred_mean": frame["mean"].to_numpy(), "pred_se": frame["mean_se"].to_numpy(),
        "pred_lower": frame["mean_ci_lower"].to_numpy(), "pred_upper": frame["mean_ci_upper"].to_numpy(),
    }


def fit_quietly(fit, **kwargs):
    """Run a statsmodels fit; return the result and the names of the warnings it raised."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        res = fit(**kwargs)
    return res, sorted({type(w.message).__name__ for w in caught})


def models_reference():
    rng = np.random.default_rng(5)
    ols = []
    x = rng.uniform(50, 70, 40).round(1)
    y = (-120 + 3.7 * x + rng.normal(0, 9, 40)).round(1)
    one = np.ones_like(x)
    gx = np.linspace(x.min(), x.max(), 7)
    ols.append(ols_case(y, np.column_stack([one, x]), np.column_stack([np.ones(7), gx])))
    xbar = x.mean()
    ols.append(ols_case(y, np.column_stack([one, x, (x - xbar) ** 2]), np.column_stack([np.ones(7), gx, (gx - xbar) ** 2])))
    ols.append(ols_case(y[:3], np.column_stack([one[:3], x[:3], (x[:3] - xbar) ** 2]), np.column_stack([np.ones(2), gx[:2], gx[:2] ** 2])))
    xd = np.column_stack([one, x, 2 * x])  # rank deficient
    ols.append(ols_case(y, xd, xd[:5]))
    ols.append(ols_case(y, x[:, None], x[:5, None]))  # no constant

    logit = []
    for n, slope, maxiter in [(60, 0.8, 200), (300, -0.15, 300), (25, 3.0, 200)]:
        xv = rng.normal(0, 2, n).round(2)
        p = 1 / (1 + np.exp(-(0.3 + slope * xv)))
        yv = (rng.uniform(size=n) < p).astype(float)
        X = sm.add_constant(xv, has_constant="add")
        res, warns = fit_quietly(sm.Logit(yv, X).fit, disp=0, maxiter=maxiter)
        logit.append({"y": yv, "x": X, "maxiter": maxiter, "params": res.params, "bse": res.bse, "llf": res.llf,
                      "converged": bool(res.mle_retvals["converged"]), "iterations": res.mle_retvals["iterations"], "warnings": warns})
    xs = np.arange(10.0)
    ys = (xs > 4.5).astype(float)  # perfectly separated
    X = sm.add_constant(xs, has_constant="add")
    res, warns = fit_quietly(sm.Logit(ys, X).fit, disp=0, maxiter=200)
    logit.append({"y": ys, "x": X, "maxiter": 200, "params": res.params, "bse": res.bse, "llf": res.llf,
                  "converged": bool(res.mle_retvals["converged"]), "iterations": res.mle_retvals["iterations"], "warnings": warns})
    # Multiple regressors, as Fit Model uses it.
    Xm = np.column_stack([np.ones(80), rng.normal(size=80).round(2), rng.integers(0, 2, 80) * 2 - 1.0])
    pm = 1 / (1 + np.exp(-(Xm @ np.array([0.2, 1.1, -0.7]))))
    ym = (rng.uniform(size=80) < pm).astype(float)
    res, warns = fit_quietly(sm.Logit(ym, Xm).fit, disp=0, maxiter=300)
    logit.append({"y": ym, "x": Xm, "maxiter": 300, "params": res.params, "bse": res.bse, "llf": res.llf,
                  "converged": bool(res.mle_retvals["converged"]), "iterations": res.mle_retvals["iterations"], "warnings": warns})

    mnlogit = []
    for n, levels in [(90, 3), (150, 4)]:
        xv = rng.normal(0, 1.5, n).round(2)
        eta = np.column_stack([np.zeros(n)] + [0.3 * j + (0.8 - 0.5 * j) * xv for j in range(1, levels)])
        prob = np.exp(eta) / np.exp(eta).sum(axis=1, keepdims=True)
        codes = np.array([rng.choice(levels, p=pr) for pr in prob])
        X = sm.add_constant(xv, has_constant="add")
        res, warns = fit_quietly(sm.MNLogit(codes, X).fit, disp=0, maxiter=200)
        xnew = sm.add_constant(np.array([-2.0, 0.0, 1.7]), has_constant="add")
        mnlogit.append({"codes": codes, "x": X, "maxiter": 200, "params": np.asarray(res.params), "bse": np.asarray(res.bse),
                        "llf": res.llf, "cov": np.asarray(res.cov_params()), "predict_x": xnew, "predict": np.asarray(res.predict(xnew)),
                        "converged": bool(res.mle_retvals["converged"]), "warnings": warns})

    ordered = []
    for n, levels, k in [(120, 3, 1), (200, 5, 1), (150, 4, 3)]:
        xv = rng.normal(0, 1, (n, k)).round(2)
        latent = xv @ np.linspace(0.9, -0.4, k) + rng.logistic(size=n)
        cuts = np.quantile(latent, np.linspace(0, 1, levels + 1)[1:-1])
        yv = np.searchsorted(cuts, latent)
        model = OrderedModel(yv, xv, distr="logit")
        res, warns = fit_quietly(model.fit, method="bfgs", disp=0, maxiter=1000)
        ordered.append({"y": yv, "x": xv, "params": res.params, "cov": np.asarray(res.cov_params()), "llf": res.llf, "warnings": warns,
                        "thresholds": model.transform_threshold_params(res.params)[1:-1]})
    return {"ols": ols, "logit": logit, "mnlogit": mnlogit, "ordered": ordered}


# ---------------------------------------------------------------------------- stats


def stats_reference():
    rng = np.random.default_rng(23)
    shapiro_rows = []
    for n in [3, 4, 5, 6, 7, 11, 12, 20, 50, 199, 1000, 5000]:
        v = rng.normal(10, 2, n).round(3)
        w, p = stats.shapiro(v)
        shapiro_rows.append({"x": v, "w": w, "p": p})
    skewed = rng.exponential(1, 40).round(3)
    w, p = stats.shapiro(skewed)
    shapiro_rows.append({"x": skewed, "w": w, "p": p})
    ties = np.array([1.0, 1, 1, 2, 2, 3, 3, 3, 3, 4, 5, 5])
    w, p = stats.shapiro(ties)
    shapiro_rows.append({"x": ties, "w": w, "p": p})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w, p = stats.shapiro(np.full(6, 2.5))
    shapiro_rows.append({"x": np.full(6, 2.5), "w": w, "p": p})

    lill = []
    for gen in [lambda: rng.normal(0, 1, 6000), lambda: rng.exponential(1, 5200), lambda: rng.uniform(0, 1, 9000)]:
        v = gen().round(4)
        d, p = lilliefors(v, dist="norm")
        lill.append({"x": v, "d": d, "p": p})

    groups_sets = [
        [rng.normal(10, 1, 8).round(2), rng.normal(11, 1, 8).round(2), rng.normal(9.5, 2, 8).round(2)],
        [rng.normal(5, 1, 6).round(1), rng.normal(5.5, 1.5, 11).round(1), rng.normal(7, 1, 4).round(1), rng.normal(5, 0.5, 9).round(1)],
        [np.array([1.0, 2, 2, 3, 3, 3]), np.array([2.0, 3, 3, 4, 4, 5, 6])],
        [np.array([3.0, 3, 3]), np.array([3.0, 3, 3, 3])],
        [np.array([1.0, 2, 3]), np.array([4.0, 4, 4]), np.array([5.0, 7, 9, 11])],
    ]
    group_tests = []
    for groups in groups_sets:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tests = {
                "levene_median": stats.levene(*groups, center="median"),
                "levene_mean": stats.levene(*groups, center="mean"),
                "bartlett": stats.bartlett(*groups),
                "kruskal": stats.kruskal(*groups),
            }
            tukey = stats.tukey_hsd(*groups)
            ci = tukey.confidence_interval(confidence_level=0.95)
        group_tests.append({
            "groups": groups,
            **{key: [res.statistic, res.pvalue] for key, res in tests.items()},
            "tukey": {"statistic": tukey.statistic, "pvalue": tukey.pvalue, "low": ci.low, "high": ci.high},
        })

    fisher = []
    for table_ in [[[8, 2], [1, 5]], [[3, 1], [1, 3]], [[0, 5], [6, 4]], [[10, 10], [10, 10]], [[1, 9], [11, 3]], [[0, 0], [3, 4]], [[25, 14], [9, 30]], [[2, 7], [8, 2]], [[120, 80], [95, 140]]]:
        fisher.append({"table": table_, **{alt: stats.fisher_exact(table_, alternative=alt).pvalue for alt in ["less", "greater", "two-sided"]}})

    pearson = []
    for n in [3, 4, 10, 200]:
        xv = rng.normal(size=n).round(2)
        yv = (0.6 * xv + rng.normal(size=n)).round(2)
        res = stats.pearsonr(xv, yv)
        pearson.append({"x": xv, "y": yv, "r": res.statistic, "p": res.pvalue})
    res = stats.pearsonr([1.0, 2, 3, 4], [2.0, 4, 6, 8.0001])
    pearson.append({"x": [1.0, 2, 3, 4], "y": [2.0, 4, 6, 8.0001], "r": res.statistic, "p": res.pvalue})

    rank_inputs = [[3.0, 1, 2], [1.0, 1, 1, 2, 5, 5, 0], [2.5, -1, 2.5, 2.5, 7, -1]]
    # Wide magnitude ranges so that numpy's pairwise summation order shows in the last bits.
    reductions = []
    for n in [7, 9, 16, 17, 129, 300]:
        v = rng.normal(size=n) * 10 ** rng.uniform(-3, 3, size=n)
        reductions.append({"x": v, "sum": np.sum(v), "mean": np.mean(v), "var": np.var(v), "var1": np.var(v, ddof=1), "median": np.median(v)})
    return {
        "reductions": reductions,
        "shapiro": shapiro_rows,
        "lilliefors": lill,
        "groups": group_tests,
        "fisher": fisher,
        "pearson": pearson,
        "rankdata": [{"x": v, "ranks": stats.rankdata(v)} for v in rank_inputs],
    }


# ------------------------------------------------------------------------ integrate


def spc_integrals(n):
    """The range-distribution integrals of app/analyses/spc.py for subgroup size n."""
    d2 = integrate.quad(lambda x: 1 - stats.norm.cdf(x) ** n - stats.norm.sf(x) ** n, -np.inf, np.inf)[0]

    def cdf(r):
        g = lambda x: stats.norm.pdf(x) * (stats.norm.cdf(x + r) - stats.norm.cdf(x)) ** (n - 1)
        return n * integrate.quad(g, -12, 12, limit=400)[0]

    er2 = 2 * integrate.quad(lambda r: r * (1 - cdf(r)), 0, 20, limit=400)[0]
    return {"n": n, "d2": d2, "range_cdf_1_5": cdf(1.5), "er2": er2}


def integrate_reference():
    rows = [spc_integrals(n) for n in [2, 3, 5, 10, 25]]
    generic = [
        {"name": "gauss", "value": integrate.quad(lambda x: math.exp(-x * x), -np.inf, np.inf)[0]},
        {"name": "inv_sq", "value": integrate.quad(lambda x: 1 / (1 + x * x), 0, np.inf)[0]},
        {"name": "sqrt", "value": integrate.quad(lambda x: math.sqrt(x), 0, 1)[0]},
        {"name": "log", "value": integrate.quad(lambda x: math.log(x), 0, 1)[0]},
        {"name": "lower_tail", "value": integrate.quad(lambda x: math.exp(x), -np.inf, 0)[0]},
    ]
    return {"spc": rows, "generic": generic}


# --------------------------------------------------------------------------- random


def random_reference():
    seeds = []
    for entropy, key in [(0, ()), (12345, ()), (2**40 + 7, ()), (987654321987654321, ()), (42, (0,)), (42, (1,)), (7, (3, 5))]:
        seq = np.random.SeedSequence(entropy, spawn_key=key)
        seeds.append({"entropy": str(entropy), "spawn_key": list(key), "pool": seq.pool, "state": seq.generate_state(8)})
    streams = []
    for seed in [0, 1, 2024]:
        rng = np.random.default_rng(seed)
        streams.append({
            "seed": seed,
            "uniform": rng.uniform(-1, 1, 500),
            "integers": rng.integers(0, 7, 500),
            "wide_integers": rng.integers(-5, 3_000_000_000, 50),
            "choice": rng.choice([0.5, 1.5, 2.5], size=50),
            "permutation": rng.permutation(37),
            "random": rng.random(20),
        })
    # The DOE pattern: one seed spawns the design and run-order generators.
    design_rng, order_rng = (np.random.default_rng(s) for s in np.random.SeedSequence(2718).spawn(2))
    doe = {"seed": 2718, "design_uniform": design_rng.uniform(-1, 1, 10), "order": order_rng.permutation(16)}
    return {"seeds": seeds, "streams": streams, "doe": doe}


def main():
    lin = linalg_reference()
    corrcoef_reference(lin)
    data = {
        "special": special_reference(),
        "distributions": distribution_reference(),
        "linalg": lin,
        "models": models_reference(),
        "stats": stats_reference(),
        "integrate": integrate_reference(),
        "random": random_reference(),
    }
    OUT.write_text(json.dumps(enc(data), separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
