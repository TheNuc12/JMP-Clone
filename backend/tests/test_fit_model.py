"""Fit Model: least squares, stepwise and logistic personalities."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
import statsmodels.api as sm
import statsmodels.formula.api as smf
from statsmodels.miscmodels.ordinal_model import OrderedModel

from app.analyses import run_analysis
from app.samples import get_sample
from app.schemas import AnalyzeRequest

from conftest import cat, cont, outline, summary_values, table_rows, walk, warnings_of


def fit(y, factors, effects, options=None, **params) -> dict:
    req = AnalyzeRequest(
        platform="fit_model",
        y=y,
        roles={"factors": factors},
        params={"effects": effects, **params},
        options=options or {},
    )
    return run_analysis(req).model_dump(mode="json")


def plots(result: dict, kind: str) -> list[dict]:
    return [n["plot"] for n in walk(result["nodes"]) if n["type"] == "plot" and n["plot"]["kind"] == kind]


@pytest.fixture
def mixed_data() -> pd.DataFrame:
    rng = np.random.default_rng(7)
    n = 60
    g = rng.choice(["a", "b", "c"], size=n)
    x = rng.normal(10, 2, size=n)
    effect = {"a": 1.0, "b": -2.0, "c": 0.5}
    slope = {"a": 1.5, "b": 2.5, "c": 1.0}
    y = np.array([3 + effect[gi] + slope[gi] * xi for gi, xi in zip(g, x)]) + rng.normal(0, 1, n)
    return pd.DataFrame({"y": y, "x": x, "g": g})


def test_least_squares_matches_statsmodels(mixed_data):
    d = mixed_data
    res = fit(cont("y", list(d.y)), [cont("x", list(d.x)), cat("g", list(d.g))], [["x"], ["g"], ["x", "g"]])
    assert res["analysis"] == "fit_model_least_squares"
    xm = d.x.mean()
    d = d.assign(xc=d.x - xm)
    # Same model with x centered everywhere; only the intercept differs (by b_x * mean).
    ref = smf.ols("y ~ xc + C(g, Sum) + xc:C(g, Sum)", data=d).fit()
    xm_label = f"(x-{float(f'{xm:.6g}'):g})"
    names = {
        "x": "xc",
        "g[a]": "C(g, Sum)[S.a]",
        "g[b]": "C(g, Sum)[S.b]",
        f"{xm_label}*g[a]": "xc:C(g, Sum)[S.a]",
        f"{xm_label}*g[b]": "xc:C(g, Sum)[S.b]",
    }
    est = table_rows(res, "Parameter Estimates")
    assert set(est) == set(names) | {"Intercept"}
    assert est["Intercept"][0] + est["x"][0] * xm == pytest.approx(ref.params["Intercept"])
    for ours, theirs in names.items():
        assert est[ours][0] == pytest.approx(ref.params[theirs], rel=1e-8)
        assert est[ours][1] == pytest.approx(ref.bse[theirs], rel=1e-8)
        assert est[ours][3] == pytest.approx(ref.pvalues[theirs], rel=1e-6, abs=1e-12)

    fit_summary = summary_values(res, "Summary of Fit")
    assert fit_summary["RSquare"] == pytest.approx(ref.rsquared)
    assert fit_summary["RSquare Adj"] == pytest.approx(ref.rsquared_adj)
    assert fit_summary["Root Mean Square Error"] == pytest.approx(np.sqrt(ref.mse_resid))
    anova = table_rows(res, "Analysis of Variance")
    assert anova["Model"][3] == pytest.approx(ref.fvalue)

    type3 = sm.stats.anova_lm(ref, typ=3)
    tests = table_rows(res, "Effect Tests")
    assert tests["x"][2] == pytest.approx(type3.loc["xc", "sum_sq"], rel=1e-8)
    assert tests["g"][2] == pytest.approx(type3.loc["C(g, Sum)", "sum_sq"], rel=1e-8)
    assert tests["x*g"][2] == pytest.approx(type3.loc["xc:C(g, Sum)", "sum_sq"], rel=1e-8)
    assert tests["x*g"][4] == pytest.approx(type3.loc["xc:C(g, Sum)", "PR(>F)"], rel=1e-6)


def test_profiler_model_reproduces_predictions(mixed_data):
    d = mixed_data
    res = fit(cont("y", list(d.y)), [cont("x", list(d.x)), cat("g", list(d.g))], [["x"], ["g"], ["x", "g"], ["x", "x"]])
    (model,) = [p["model"] for p in plots(res, "profiler")]
    (actual,) = [p for p in plots(res, "indexed_scatter") if p["y_label"] == "y Actual"]
    levels = {f["name"]: f.get("levels") for f in model["factors"]}

    def part_value(part, i):
        if part["level"] is not None:
            lev = d.g[i]
            return 1.0 if lev == part["level"] else -1.0 if lev == levels["g"][-1] else 0.0
        return (d[part["factor"]][i] - part["center"]) ** part["power"]

    for k, i in enumerate(actual["indices"]):
        row = [np.prod([part_value(p, i) for p in t["parts"]]) for t in model["terms"]]
        assert np.dot(row, model["coef"]) == pytest.approx(actual["x"][k])
    assert model["df_error"] == len(d) - len(model["terms"])
    assert len(model["cov"]) == len(model["terms"])


def test_term_labels_and_centering():
    x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    y = [1.0, 4.2, 8.9, 16.1, 25.0, 36.2]
    centered = table_rows(fit(cont("y", y), [cont("x", x)], [["x"], ["x", "x"]]), "Parameter Estimates")
    assert list(centered) == ["Intercept", "x", "(x-3.5)*(x-3.5)"]
    raw = table_rows(fit(cont("y", y), [cont("x", x)], [["x"], ["x", "x"]], center_polynomials=False), "Parameter Estimates")
    assert list(raw) == ["Intercept", "x", "x*x"]
    # Same quadratic coefficient either way.
    assert centered["(x-3.5)*(x-3.5)"][0] == pytest.approx(raw["x*x"][0])


def test_lack_of_fit_on_replicated_design():
    x = [1, 1, 1, 2, 2, 2, 3, 3, 3]
    y = [1.0, 1.4, 0.8, 4.1, 3.7, 4.3, 9.2, 8.8, 9.0]
    res = fit(cont("y", y), [cont("x", x)], [["x"]])
    lof = table_rows(res, "Lack Of Fit")
    ya = np.array(y)
    groups = [ya[0:3], ya[3:6], ya[6:9]]
    ss_pe = sum(((g - g.mean()) ** 2).sum() for g in groups)
    assert lof["Pure Error"][0] == 6
    assert lof["Pure Error"][1] == pytest.approx(ss_pe)
    assert lof["Lack Of Fit"][0] == 1
    sse = table_rows(res, "Analysis of Variance")["Error"][1]
    assert lof["Lack Of Fit"][1] == pytest.approx(sse - ss_pe)
    # No replicates: no Lack Of Fit outline.
    plain = fit(cont("y", [1.0, 2.1, 2.9, 4.2]), [cont("x", [1, 2, 3, 4])], [["x"]])
    assert not any(n.get("title") == "Lack Of Fit" for n in walk(plain["nodes"]))


def test_aliased_terms_are_zeroed():
    # 2^(3-1) fractional factorial with C = A*B: the A*B interaction is aliased with C.
    a = [-1, 1, -1, 1, -1, 1, -1, 1]
    b = [-1, -1, 1, 1, -1, -1, 1, 1]
    c = [ai * bi for ai, bi in zip(a, b)]
    y = [10.0, 14.1, 11.9, 9.8, 10.4, 13.7, 12.2, 10.1]
    res = fit(cont("y", y), [cont("A", a), cont("B", b), cont("C", c)], [["A"], ["B"], ["C"], ["A", "B"]])
    est = table_rows(res, "Parameter Estimates")
    assert est["A*B (Zeroed)"][0] == 0
    assert "C (Biased)" in est
    assert any("Singularity details" in w and "A*B = " in w for w in warnings_of(res))
    tests = table_rows(res, "Effect Tests")
    assert tests["A*B"][1] == 0  # no estimable DF
    json.dumps(res, allow_nan=False)


def test_stepwise_selects_the_real_effects():
    rng = np.random.default_rng(3)
    n = 80
    x1, x2, x3, x4 = (rng.normal(size=n) for _ in range(4))
    y = 2 * x1 + 3 * x2 + rng.normal(0, 0.5, n)
    cols = [cont(name, list(v)) for name, v in [("x1", x1), ("x2", x2), ("x3", x3), ("x4", x4)]]
    res = fit(
        cont("y", list(y)),
        cols,
        [["x1"], ["x2"], ["x3"], ["x4"], ["x1", "x2"]],
        personality="stepwise",
        direction="forward",
        p_enter=0.01,
        p_leave=0.05,
    )
    assert res["analysis"] == "fit_model_stepwise"
    current = table_rows(res, "Current Estimates")
    assert current["x1"][0] == "Yes" and current["x2"][0] == "Yes"
    assert current["x3"][0] == "No" and current["x4"][0] == "No"
    assert current["x1"][1] == pytest.approx(2, abs=0.2)
    history = table_rows(res, "Step History")
    assert [row[0] for row in history.values()][:2] == ["x2", "x1"]  # strongest first
    # The final model gets a full least squares report.
    assert outline(res, "Response y (final model)")


def test_stepwise_backward_respects_heredity():
    rng = np.random.default_rng(11)
    n = 60
    x1, x2 = rng.normal(size=n), rng.normal(size=n)
    y = x1 + rng.normal(0, 1, n)
    res = fit(
        cont("y", list(y)),
        [cont("x1", list(x1)), cont("x2", list(x2))],
        [["x1"], ["x2"], ["x1", "x2"]],
        personality="stepwise",
        direction="backward",
        p_leave=0.001,
    )
    removed = [row[0] for row in table_rows(res, "Step History").values()]
    # The interaction must leave before its main effect x2.
    assert removed.index("x1*x2") < removed.index("x2")


def test_mixed_stepwise_honors_prob_to_leave():
    table = {c.name: c for c in get_sample("process").columns}

    def column(name):
        c = table[name]
        return cont(name, c.values) if c.modeling_type == "continuous" else cat(name, c.values)

    names = ["temperature", "pressure", "speed", "machine", "shift"]
    effects = [[n] for n in names] + [[a, b] for i, a in enumerate(names) for b in names[i + 1 :]]
    res = fit(column("yield_pct"), [column(n) for n in names], effects, personality="stepwise")
    current = table_rows(res, "Current Estimates")
    entered = [name for name, row in current.items() if name != "Intercept" and row[0] == "Yes"]
    for name in entered:
        contained_in_other = any(other != name and set(name.split("*")) < set(other.split("*")) for other in entered)
        assert current[name][5] <= 0.1 or contained_in_other, name
    actions = [row[1] for row in table_rows(res, "Step History").values()]
    assert "Removed" in actions  # borderline effects that entered at 0.25 leave again at 0.1


def test_binary_logistic_matches_statsmodels(mixed_data):
    d = mixed_data
    rng = np.random.default_rng(5)
    p = 1 / (1 + np.exp(-(d.x - 10) * 0.8))
    outcome = np.where(rng.uniform(size=len(d)) < p, "No", "Yes")
    res = fit(cat("out", list(outcome)), [cont("x", list(d.x)), cat("g", list(d.g))], [["x"], ["g"]])
    assert res["analysis"] == "fit_model_logistic"
    # Ours models log odds of the first level ("No") with effect-coded g.
    code = {lev: (d.g == lev).to_numpy(float) for lev in "abc"}
    X = np.column_stack([np.ones(len(d)), d.x, code["a"] - code["c"], code["b"] - code["c"]])
    ref = sm.Logit((outcome == "No").astype(float), X).fit(disp=0)
    est = table_rows(res, "Parameter Estimates")
    for term, b, se in zip(["Intercept", "x", "g[a]", "g[b]"], ref.params, ref.bse):
        assert est[term][0] == pytest.approx(b, rel=1e-5)
        assert est[term][1] == pytest.approx(se, rel=1e-4)
    whole = table_rows(res, "Whole Model Test")
    assert whole["Difference"][2] == pytest.approx(2 * (ref.llf - ref.llnull), rel=1e-6)
    assert whole["Difference"][1] == 3
    lr = table_rows(res, "Effect Likelihood Ratio Tests")
    reduced = sm.Logit((outcome == "No").astype(float), X[:, [0, 2, 3]]).fit(disp=0)
    assert lr["x"][2] == pytest.approx(2 * (ref.llf - reduced.llf), rel=1e-5)


def test_ordinal_logistic_uses_jmp_sign_convention():
    rng = np.random.default_rng(9)
    n = 150
    x = rng.normal(size=n)
    latent = 1.5 * x + rng.logistic(size=n)
    y = np.where(latent < -0.5, "1 low", np.where(latent < 1.0, "2 mid", "3 high"))
    res = fit(cat("y", list(y), "ordinal"), [cont("x", list(x))], [["x"]])
    est = table_rows(res, "Parameter Estimates")
    codes = np.array([{"1 low": 0, "2 mid": 1, "3 high": 2}[v] for v in y])
    ref = OrderedModel(codes, x[:, None], distr="logit").fit(method="bfgs", disp=0)
    # logit P(Y <= k) = Intercept[k] + slope * x, so the slope is the negative of statsmodels'.
    assert est["x"][0] == pytest.approx(-ref.params[0], rel=1e-4)
    assert est["x"][0] < 0  # higher x -> higher categories -> lower cumulative odds
    assert est["Intercept[1 low]"][0] < est["Intercept[2 mid]"][0]


def test_least_squares_means_on_balanced_data():
    g = ["a", "a", "b", "b", "c", "c"] * 2
    h = ["u"] * 6 + ["v"] * 6
    y = [1.0, 1.2, 2.0, 2.2, 3.1, 2.9, 1.5, 1.7, 2.5, 2.7, 3.6, 3.4]
    res = fit(cont("y", y), [cat("g", g), cat("h", h)], [["g"], ["h"]], options={"lsmeans": True})
    ls = table_rows(res, "Least Squares Means: g")
    for level in "abc":
        raw = np.mean([yi for gi, yi in zip(g, y) if gi == level])
        assert ls[level][0] == pytest.approx(raw)  # balanced: LS means equal raw means
        assert ls[level][2] == pytest.approx(raw)


@pytest.mark.parametrize(
    "y, factors, effects, message",
    [
        (cont("y", [1.0, 2.0, 3.0]), [cont("x", [1, 2, 3])], [], "at least one effect"),
        (cont("y", [None, None]), [cont("x", [1, 2])], [["x"]], "No rows"),
        (cont("y", [1.0, 2.0, 3.0]), [cat("g", ["a", "a", "a"])], [["g"]], "fewer than 2 levels"),
    ],
)
def test_degenerate_inputs_warn(y, factors, effects, message):
    res = fit(y, factors, effects)
    texts = [n["text"] for n in walk(res["nodes"]) if n["type"] == "text"]
    assert any(message in t for t in texts)
    json.dumps(res, allow_nan=False)


def test_saturated_and_constant_models_do_not_crash():
    saturated = fit(cont("y", [1.0, 3.0]), [cont("x", [1, 2])], [["x"]])
    assert any("no degrees of freedom" in w for w in warnings_of(saturated))
    json.dumps(saturated, allow_nan=False)
    constant = fit(cont("y", [2.0, 2.0, 2.0, 2.0]), [cont("x", [1, 2, 3, 4])], [["x"]])
    assert summary_values(constant, "Summary of Fit")["RSquare"] is None
    json.dumps(constant, allow_nan=False)
    separated = fit(cat("y", ["a", "a", "a", "b", "b", "b"]), [cont("x", [1, 2, 3, 4, 5, 6])], [["x"]])
    json.dumps(separated, allow_nan=False)


def test_api_round_trip(client):
    body = {
        "platform": "fit_model",
        "y": {"name": "y", "modeling_type": "continuous", "values": [1, 2.2, 2.9, None, 5.1, 6.2, 6.8]},
        "roles": {
            "factors": [
                {"name": "x", "modeling_type": "continuous", "values": [1, 2, 3, 4, 5, 6, 7]},
                {"name": "g", "modeling_type": "nominal", "values": ["p", "q", "p", "q", "p", "q", "p"]},
            ]
        },
        "params": {"effects": [["x"], ["g"]]},
    }
    res = client.post("/api/analyze", json=body)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["title"] == "Response y"
    assert any(n["type"] == "text" and "1 row(s) excluded" in n["text"] for n in walk(data["nodes"]))
    bad = client.post("/api/analyze", json={**body, "params": {"effects": [["nope"]]}})
    assert bad.status_code == 400
    assert "nope" in bad.json()["detail"]


def test_constant_response_has_no_spurious_tests():
    """An exact fit's rounding residue must not turn into F or t ratios."""
    y = cont("y", [5.0] * 8)
    x = cont("x", [float(i) for i in range(1, 9)])
    req = AnalyzeRequest(platform="fit_model", y=y, roles={"factors": [x]}, params={"effects": [["x"]]})
    data = run_analysis(req).model_dump(mode="json")
    model = table_rows(data, "Analysis of Variance")["Model"]
    assert model[3] is None and model[4] is None  # F Ratio, Prob > F
    for row in table_rows(data, "Parameter Estimates").values():
        assert row[2] is None and row[3] is None  # t Ratio, Prob>|t|
