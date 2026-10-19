"""Numeric correctness checks against independent computations."""

from __future__ import annotations

import math

import numpy as np
import pytest
import statsmodels.api as sm
from scipy import optimize, stats
from scipy.special import expit
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.oneway import anova_oneway

from conftest import analyze, cat, cont, outline, plot, summary_values, table_rows

rng = np.random.default_rng(12345)
X = np.round(rng.normal(50, 10, 60), 2)
Y = np.round(3 + 0.8 * X + rng.normal(0, 6, 60), 2)
GROUPS = np.array(["b", "a", "c"] * 20)
YG = np.round(np.select([GROUPS == "a", GROUPS == "b"], [10.0, 12.0], 13.0) + rng.normal(0, 2, 60) * np.select([GROUPS == "a", GROUPS == "b"], [1.0, 2.0], 0.5), 3)


def approx(a, b, rel=1e-6, abs=1e-9):
    return a == pytest.approx(b, rel=rel, abs=abs)


# ------------------------------------------------------------------ distribution


def test_quantiles_use_n_plus_one_definition():
    res = analyze(cont("v", list(range(1, 11))))
    q = table_rows(res, "Quantiles")
    assert q["100.0% maximum"] == [10]
    assert q["75.0% quartile"] == [8.25]
    assert q["50.0% median"] == [5.5]
    assert q["25.0% quartile"] == [2.75]
    assert approx(q["10.0%"][0], 1.1)
    assert q["2.5%"] == [1]
    assert q["0.0% minimum"] == [1]


def test_summary_statistics_and_mean_ci():
    res = analyze(cont("x", list(X) + [None, None]))
    s = summary_values(res, "Summary Statistics")
    lo, hi = stats.t.interval(0.95, len(X) - 1, loc=X.mean(), scale=stats.sem(X))
    assert approx(s["Mean"], X.mean())
    assert approx(s["Std Dev"], X.std(ddof=1))
    assert approx(s["Std Err Mean"], stats.sem(X))
    assert approx(s["Lower 95% Mean"], lo) and approx(s["Upper 95% Mean"], hi)
    assert s["N"] == 60 and s["N Missing"] == 2
    assert approx(plot(res)["mean_ci"][0], lo)


def test_histogram_bins_cover_data():
    res = analyze(cont("x", list(X)))
    bins = plot(res)["bins"]
    assert bins["start"] <= X.min() and bins["end"] > X.max()
    n_bins = (bins["end"] - bins["start"]) / bins["size"]
    assert abs(n_bins - round(n_bins)) < 1e-9
    mantissa = bins["size"] / 10 ** math.floor(math.log10(bins["size"]))
    assert round(mantissa, 9) in (1.0, 2.0, 5.0)


def test_box_plot_whiskers():
    values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30]
    box = plot(analyze(cont("v", values)))["box"]
    q1, q3 = np.quantile(values, [0.25, 0.75], method="weibull")
    assert approx(box["q1"], q1) and approx(box["q3"], q3)
    assert box["upper_whisker"] == 9  # 30 is beyond q3 + 1.5 IQR
    assert box["lower_whisker"] == 1


def test_fit_normal():
    res = analyze(cont("x", list(X)), fit_normal=True)
    est = table_rows(res, "Parameter Estimates")
    n, s = len(X), X.std(ddof=1)
    # rows: [Type, Parameter, Estimate, Lower 95%, Upper 95%], keyed by Type
    assert approx(est["Location"][1], X.mean())
    assert approx(est["Dispersion"][1], s)
    assert approx(est["Dispersion"][2], math.sqrt((n - 1) * s**2 / stats.chi2.ppf(0.975, n - 1)))
    assert approx(est["Dispersion"][3], math.sqrt((n - 1) * s**2 / stats.chi2.ppf(0.025, n - 1)))
    w = table_rows(res, "Goodness-of-Fit Test")["Shapiro-Wilk"]
    expected = stats.shapiro(X)
    assert approx(w[0], expected.statistic) and approx(w[1], expected.pvalue)
    assert plot(res)["normal"] == pytest.approx({"mu": X.mean(), "sigma": s})


def test_categorical_frequencies_and_level_order():
    res = analyze(cat("age", [12, 9, 10, 12, None, 9, 12]))
    freq = table_rows(res, "Frequencies")
    assert list(freq) == ["9", "10", "12", "Total"]  # numeric labels sort numerically
    assert freq["12"][0] == 3 and approx(freq["12"][1], 0.5)
    assert freq["Total"] == [6, 1.0]
    assert plot(res)["counts"] == [2, 1, 3]
    assert summary_values(res, "Frequencies") == {"N Missing": 1, "N Levels": 3}


# ---------------------------------------------------------------------- bivariate


def test_linear_fit_matches_linregress():
    res = analyze(cont("y", list(Y)), cont("x", list(X)))
    lr = stats.linregress(X, Y)
    fit = summary_values(res, "Summary of Fit")
    assert approx(fit["RSquare"], lr.rvalue**2)
    est = table_rows(res, "Parameter Estimates")
    assert approx(est["Intercept"][0], lr.intercept)
    assert approx(est["x"][0], lr.slope)
    assert approx(est["x"][1], lr.stderr)
    assert approx(est["x"][3], lr.pvalue, rel=1e-5)
    anova = table_rows(res, "Analysis of Variance")
    assert approx(anova["Model"][3], est["x"][2] ** 2)  # F = t^2
    assert anova["Error"][0] == 58 and anova["C. Total"][0] == 59
    sse = ((Y - (lr.intercept + lr.slope * X)) ** 2).sum()
    assert approx(anova["Error"][1], sse)
    assert approx(fit["Root Mean Square Error"], math.sqrt(sse / 58))


def test_linear_fit_confidence_band():
    res = analyze(cont("y", list(Y)), cont("x", list(X)))
    curve = plot(res)["curves"][0]
    gx = np.array(curve["x"])
    lr = stats.linregress(X, Y)
    rmse = summary_values(res, "Summary of Fit")["Root Mean Square Error"]
    n, xbar, sxx = len(X), X.mean(), ((X - X.mean()) ** 2).sum()
    half = stats.t.ppf(0.975, n - 2) * rmse * np.sqrt(1 / n + (gx - xbar) ** 2 / sxx)
    assert np.allclose(curve["y"], lr.intercept + lr.slope * gx)
    assert np.allclose(np.array(curve["upper"]) - np.array(curve["y"]), half)


def test_quadratic_fit_is_centered_polynomial():
    res = analyze(cont("y", list(Y)), cont("x", list(X)), fit_line=False, fit_quadratic=True)
    coefs = np.polyfit(X, Y, 2)
    curve = plot(res)["curves"][0]
    assert np.allclose(curve["y"], np.polyval(coefs, np.array(curve["x"])))
    est = table_rows(res, "Parameter Estimates")
    centre = f"(x-{X.mean():.6g})^2"
    assert approx(est[centre][0], coefs[0])
    pred = np.polyval(coefs, X)
    r2 = 1 - ((Y - pred) ** 2).sum() / ((Y - Y.mean()) ** 2).sum()
    assert approx(summary_values(res, "Summary of Fit")["RSquare"], r2)


def test_correlation():
    res = analyze(cont("y", list(Y)), cont("x", list(X)), correlation=True)
    s = summary_values(res, "Correlation")
    expected = stats.pearsonr(X, Y)
    assert approx(s["Correlation"], expected.statistic)
    assert approx(s["Signif. Prob"], expected.pvalue, rel=1e-5)
    assert approx(s["Covariance"], np.cov(X, Y)[0, 1])


def test_fit_mean():
    res = analyze(cont("y", list(Y)), cont("x", list(X)), fit_line=False, fit_mean=True)
    s = summary_values(res, "Fit Mean")
    assert approx(s["Mean"], Y.mean())
    assert approx(s["SSE"], ((Y - Y.mean()) ** 2).sum())


# ------------------------------------------------------------------------- oneway


def _oneway(**opts):
    return analyze(cont("y", list(YG)), cat("g", list(GROUPS)), **opts)


def test_oneway_anova_matches_f_oneway():
    res = _oneway()
    samples = [YG[GROUPS == g] for g in "abc"]
    expected = stats.f_oneway(*samples)
    anova = table_rows(res, "Analysis of Variance")
    assert approx(anova["g"][3], expected.statistic)
    assert approx(anova["g"][4], expected.pvalue, rel=1e-5)
    assert anova["g"][0] == 2 and anova["Error"][0] == 57
    mse = anova["Error"][2]
    means = table_rows(res, "Means for Oneway Anova")
    assert list(means) == ["a", "b", "c"]
    assert approx(means["a"][2], math.sqrt(mse / 20))
    groups = plot(res)["groups"]
    half = stats.t.ppf(0.975, 57) * math.sqrt(mse / 20)
    assert approx(groups[0]["ci_upper"] - groups[0]["mean"], half)


def test_welch_t_test():
    a, b = YG[GROUPS == "a"], YG[GROUPS == "b"]
    mask = GROUPS != "c"
    res = analyze(cont("y", list(YG[mask])), cat("g", list(GROUPS[mask])), t_test=True)
    s = summary_values(res, "t Test")
    expected = stats.ttest_ind(b, a, equal_var=False)
    assert approx(s["Difference"], b.mean() - a.mean())
    assert approx(s["t Ratio"], expected.statistic)
    assert approx(s["Prob > |t|"], expected.pvalue, rel=1e-5)
    assert approx(s["DF"], expected.df)
    ci = expected.confidence_interval(0.95)
    assert approx(s["Lower CL Dif"], ci.low) and approx(s["Upper CL Dif"], ci.high)
    assert approx(s["Prob > t"] + s["Prob < t"], 1.0)


def test_t_test_disabled_with_three_levels():
    res = _oneway(t_test=True)
    option = next(o for o in res["options"] if o["key"] == "t_test")
    assert option["enabled"] is False
    with pytest.raises(AssertionError):
        outline(res, "t Test")


def test_unequal_variances_and_welch_anova():
    res = _oneway(unequal_variances=True)
    samples = [YG[GROUPS == g] for g in "abc"]
    tests = table_rows(res, "Tests that the Variances are Equal")
    assert approx(tests["Brown-Forsythe"][0], stats.levene(*samples, center="median").statistic)
    assert approx(tests["Levene"][0], stats.levene(*samples, center="mean").statistic)
    assert approx(tests["Bartlett"][0], stats.bartlett(*samples).statistic)
    welch = summary_values(res, "Welch's Test")
    expected = anova_oneway(samples, use_var="unequal")
    assert approx(welch["F Ratio"], expected.statistic)
    assert approx(welch["DFDen"], expected.df[1])
    assert approx(welch["Prob > F"], expected.pvalue, rel=1e-5)


def test_kruskal_wallis():
    res = _oneway(nonparametric=True)
    samples = [YG[GROUPS == g] for g in "abc"]
    expected = stats.kruskal(*samples)
    s = summary_values(res, "1-Way Test, ChiSquare Approximation")
    assert approx(s["ChiSquare"], expected.statistic)
    assert approx(s["Prob>ChiSq"], expected.pvalue, rel=1e-5)
    ranks = stats.rankdata(YG)
    scores = table_rows(res, "Wilcoxon / Kruskal-Wallis Tests (Rank Sums)")
    assert approx(scores["a"][1], ranks[GROUPS == "a"].sum())
    assert approx(scores["a"][2], 20 * 61 / 2)


def test_tukey_hsd_matches_statsmodels():
    res = _oneway(tukey=True)
    node = outline(res, "Ordered Differences Report")["children"][0]
    expected = pairwise_tukeyhsd(YG, GROUPS)
    by_pair = {}
    for g1, g2, diff, p, lo, hi in zip(
        expected.groupsunique[expected._multicomp.pairindices[0]],
        expected.groupsunique[expected._multicomp.pairindices[1]],
        expected.meandiffs, expected.pvalues, expected.confint[:, 0], expected.confint[:, 1],
    ):
        by_pair[(g2, g1)] = (diff, p, lo, hi)  # statsmodels reports mean(g2) - mean(g1)
        by_pair[(g1, g2)] = (-diff, p, -hi, -lo)
    diffs = [row[2] for row in node["rows"]]
    assert diffs == sorted(diffs, reverse=True) and all(d >= 0 for d in diffs)
    for level, minus, diff, _se, lo, hi, p in node["rows"]:
        e = by_pair[(level, minus)]
        assert approx(diff, e[0]) and approx(lo, e[2], rel=1e-4) and approx(hi, e[3], rel=1e-4)
        assert approx(p, e[1], rel=1e-3, abs=1e-3)


# -------------------------------------------------------------------- contingency

TABLE = np.array([[20, 15, 5], [10, 25, 15]])


def _expand(table):
    xs, ys = [], []
    for i, row in enumerate(table):
        for j, count in enumerate(row):
            xs += [f"x{i}"] * int(count)
            ys += [f"y{j}"] * int(count)
    return cat("Y", ys), cat("X", xs)


def test_chi_square_tests():
    res = analyze(*_expand(TABLE))
    tests = table_rows(res, "Tests")
    pearson = stats.chi2_contingency(TABLE, correction=False)
    lr = stats.chi2_contingency(TABLE, correction=False, lambda_="log-likelihood")
    assert approx(tests["Pearson"][0], pearson.statistic)
    assert approx(tests["Pearson"][1], pearson.pvalue, rel=1e-5)
    assert approx(tests["Likelihood Ratio"][0], lr.statistic)
    s = summary_values(res, "Tests")
    n = TABLE.sum()
    col = TABLE.sum(axis=0)
    reduced = -(col * np.log(col / n)).sum()
    assert s["N"] == 90 and s["DF"] == 2
    assert approx(s["-LogLike"], lr.statistic / 2)
    assert approx(s["RSquare (U)"], lr.statistic / 2 / reduced)
    mosaic = plot(res)
    assert mosaic["x_levels"] == ["x0", "x1"] and mosaic["counts"] == TABLE.tolist()


def test_fisher_exact_tea_tasting():
    res = analyze(*_expand(np.array([[3, 1], [1, 3]])))
    fisher = table_rows(res, "Fisher's Exact Test")
    assert approx(fisher["2-Tail"][0], 0.4857142857, rel=1e-6)
    assert approx(fisher["Right"][0], 0.2428571429, rel=1e-6)
    assert approx(fisher["Left"][0], 0.9857142857, rel=1e-6)
    assert any("expected count less than 5" in n["text"] for n in outline(res, "Tests")["children"] if n["type"] == "text")


# ----------------------------------------------------------------------- logistic


def _binary_data():
    x = rng.normal(0, 1, 150)
    y = np.where(rng.random(150) < expit(0.4 + 1.3 * x), "Yes", "No")
    return x, y  # levels sort as ["No", "Yes"]


def test_binary_logistic_matches_glm():
    x, y = _binary_data()
    res = analyze(cat("y", list(y)), cont("x", list(x)), odds_ratios=True)
    glm = sm.GLM((y == "No").astype(float), sm.add_constant(x), family=sm.families.Binomial()).fit()
    est = table_rows(res, "Parameter Estimates")
    assert approx(est["Intercept"][0], glm.params[0], rel=1e-4)
    assert approx(est["x"][0], glm.params[1], rel=1e-4)
    assert approx(est["x"][1], glm.bse[1], rel=1e-4)
    assert approx(est["x"][2], (glm.params[1] / glm.bse[1]) ** 2, rel=1e-4)
    whole = table_rows(res, "Whole Model Test")
    null = sm.GLM((y == "No").astype(float), np.ones((x.size, 1)), family=sm.families.Binomial()).fit()
    assert approx(whole["Full"][0], -glm.llf, rel=1e-6)
    assert approx(whole["Reduced"][0], -null.llf, rel=1e-6)
    assert approx(whole["Difference"][2], 2 * (glm.llf - null.llf), rel=1e-5)
    lp = plot(res)
    assert lp["y_levels"] == ["No", "Yes"] and len(lp["cum_probs"]) == 1
    gx = np.array(lp["curve_x"])
    assert np.allclose(lp["cum_probs"][0], expit(glm.params[0] + glm.params[1] * gx), atol=1e-5)
    odds = table_rows(res, "Odds Ratios")
    assert approx(odds["x"][0], math.exp(glm.params[1]), rel=1e-4)


def _ordinal_data():
    x = rng.normal(0, 1, 300)
    latent = 1.2 * x + rng.logistic(size=300)
    y = np.array(["1 low", "2 mid", "3 high"])[np.digitize(latent, [-0.7, 0.9])]
    return x, y


def test_ordinal_logistic_matches_direct_mle():
    x, y = _ordinal_data()
    res = analyze(cat("y", list(y), "ordinal"), cont("x", list(x)))
    codes = np.searchsorted(["1 low", "2 mid", "3 high"], y)

    def nll(theta):
        a1, gap, b = theta
        a2 = a1 + math.exp(gap)
        c1, c2 = expit(a1 + b * x), expit(a2 + b * x)
        p = np.choose(codes, [c1, c2 - c1, 1 - c2])
        return -np.log(np.clip(p, 1e-300, None)).sum()

    opt = optimize.minimize(nll, [0.0, 0.0, 0.0], method="Nelder-Mead", options={"xatol": 1e-9, "fatol": 1e-10, "maxiter": 20000})
    a1, gap, b = opt.x
    est = table_rows(res, "Parameter Estimates")
    assert approx(est["Intercept[1 low]"][0], a1, rel=1e-3)
    assert approx(est["Intercept[2 mid]"][0], a1 + math.exp(gap), rel=1e-3)
    assert approx(est["x"][0], b, rel=1e-3)  # JMP sign convention: P(Y <= k) falls as x rises
    assert est["x"][0] < 0
    whole = table_rows(res, "Whole Model Test")
    assert approx(whole["Full"][0], opt.fun, rel=1e-6)
    lp = plot(res)
    cp = np.array(lp["cum_probs"])
    assert cp.shape == (2, len(lp["curve_x"])) and np.all(cp[0] <= cp[1] + 1e-12)


def test_nominal_multilevel_logistic():
    x, y = _ordinal_data()
    res = analyze(cat("y", list(y), "nominal"), cont("x", list(x)))
    codes = np.searchsorted(["1 low", "2 mid", "3 high"], y)
    # Reference = last level: refit independently with statsmodels using reversed codes.
    mn = sm.MNLogit(np.where(codes == 2, 0, codes + 1), sm.add_constant(x)).fit(disp=0)
    whole = table_rows(res, "Whole Model Test")
    assert approx(whole["Full"][0], -mn.llf, rel=1e-6)
    assert whole["Difference"][1] == 2
    est = table_rows(res, "Parameter Estimates")
    assert approx(est["x[1 low]"][0], mn.params[1, 0], rel=1e-5)
    cp = np.array(plot(res)["cum_probs"])
    assert np.all((cp >= 0) & (cp <= 1)) and np.all(cp[0] <= cp[1] + 1e-12)
