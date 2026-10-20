"""Degenerate inputs must produce a report with a warning, never an exception or NaN."""

from __future__ import annotations

import json

import pytest

from conftest import analyze, cat, cont, warnings_of

ALL_OPTIONS = {
    "fit_normal": True,
    "fit_mean": True,
    "fit_quadratic": True,
    "correlation": True,
    "means_std": True,
    "t_test": True,
    "box_plots": True,
    "unequal_variances": True,
    "nonparametric": True,
    "tukey": True,
    "odds_ratios": True,
}

CASES = {
    "distribution all missing": (cont("v", [None, None]), None, True),
    "distribution n=1": (cont("v", [3.0, None]), None, True),
    "distribution constant": (cont("v", [2.0] * 5), None, True),
    "distribution empty": (cont("v", []), None, True),
    "categorical all missing": (cat("c", [None, None]), None, True),
    "bivariate n=1": (cont("y", [1, None]), cont("x", [1, 2]), True),
    "bivariate x constant": (cont("y", [1, 2, 3]), cont("x", [5, 5, 5]), True),
    "bivariate y constant": (cont("y", [4, 4, 4, 4]), cont("x", [1, 2, 3, 4]), True),
    "bivariate n=2 exact fit": (cont("y", [1, 3]), cont("x", [0, 1]), True),
    "oneway all missing": (cont("y", [None, None]), cat("g", ["a", "b"]), True),
    "oneway single group": (cont("y", [1, 2, 3]), cat("g", ["a", "a", "a"]), True),
    "oneway one obs per level": (cont("y", [1, 2]), cat("g", ["a", "b"]), True),
    "oneway constant response": (cont("y", [5, 5, 5, 5]), cat("g", ["a", "a", "b", "b"]), True),
    "contingency all missing": (cat("y", [None, "a"]), cat("x", ["u", None]), True),
    "contingency single level": (cat("y", ["a", "b", "a"]), cat("x", ["u", "u", "u"]), True),
    "logistic single level": (cat("y", ["a", "a", "a"]), cont("x", [1, 2, 3]), True),
    "logistic x constant": (cat("y", ["a", "b", "a"]), cont("x", [1, 1, 1]), True),
    "logistic too few rows": (cat("y", ["a", "b"]), cont("x", [1, 2]), True),
    "logistic perfect separation": (cat("y", ["a"] * 5 + ["b"] * 5), cont("x", list(range(10))), True),
    "ordinal logistic separation": (
        cat("y", ["a"] * 4 + ["b"] * 4 + ["c"] * 4, "ordinal"),
        cont("x", list(range(12))),
        True,
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_degenerate_inputs(name):
    y, x, expect_warning = CASES[name]
    result = analyze(y, x, **ALL_OPTIONS)
    json.dumps(result, allow_nan=False)  # raises if any NaN / inf slipped through
    assert result["nodes"]
    if expect_warning:
        assert warnings_of(result), f"{name}: expected a warning"


def test_fit_normal_with_two_values(client):
    y = {"name": "y", "modeling_type": "continuous", "values": [1.0, 2.0, None]}
    res = client.post("/api/analyze", json={"platform": "distribution", "y": y, "options": {"fit_normal": True}})
    assert res.status_code == 200, res.text
    assert "at least 3 observations" in res.text
