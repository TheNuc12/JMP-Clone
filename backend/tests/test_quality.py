"""Control charts and process capability: constants, limits, tests and degenerate data."""

from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import pytest
from scipy import stats

from app.analyses import run_analysis
from app.analyses.control_chart import Chart, Point, _run_tests
from app.analyses.spc import a2, a3, b3, b4, c4, d2, d3, d3_lower, d4_upper
from app.schemas import AnalysisColumn, AnalyzeRequest

from conftest import cat, cont, outline, table_rows, walk, warnings_of


def run(platform: str, y: AnalysisColumn, roles: dict[str, list[AnalysisColumn]] | None = None, options: dict | None = None, **params: Any) -> dict:
    req = AnalyzeRequest(platform=platform, y=y, roles=roles or {}, params=params, options=options or {})
    result = run_analysis(req).model_dump(mode="json")
    json.dumps(result, allow_nan=False)  # never NaN / inf
    return result


def charts(result: dict) -> list[dict]:
    return [n["plot"] for n in walk(result["nodes"]) if n["type"] == "plot" and n["plot"]["kind"] == "control_chart"]


def limits(point: dict) -> tuple[float, float, float]:
    return point["lcl"], point["center"], point["ucl"]


# ------------------------------------------------------------------- constants


def test_constants_match_published_tables():
    assert d2(2) == pytest.approx(1.128, abs=5e-4)
    assert d2(5) == pytest.approx(2.326, abs=5e-4)
    assert d2(25) == pytest.approx(3.931, abs=5e-4)
    assert d3(2) == pytest.approx(0.853, abs=5e-4)
    assert d3(10) == pytest.approx(0.797, abs=5e-4)
    assert a2(5) == pytest.approx(0.577, abs=5e-4)
    assert a2(10) == pytest.approx(0.308, abs=5e-4)
    assert d3_lower(5) == 0
    assert d3_lower(7) == pytest.approx(0.076, abs=5e-4)
    assert d4_upper(2) == pytest.approx(3.267, abs=5e-4)
    assert d4_upper(5) == pytest.approx(2.114, abs=5e-4)
    assert c4(5) == pytest.approx(0.9400, abs=5e-5)
    assert c4(10) == pytest.approx(0.9727, abs=5e-5)
    assert a3(5) == pytest.approx(1.427, abs=5e-4)
    assert b3(6) == pytest.approx(0.030, abs=5e-4)
    assert b4(5) == pytest.approx(2.089, abs=5e-4)


# --------------------------------------------------------------- variables charts


def test_imr_limits_by_hand():
    y = cont("x", [1, 3, None, 2, 4, 3])
    result = run("control_chart", y, chart_type="imr")
    individual, moving_range = charts(result)
    sigma = 1.5 / d2(2)  # moving ranges 2, 1, 2, 1
    assert len(individual["points"]) == 5
    assert limits(individual["points"][0]) == pytest.approx((2.6 - 3 * sigma, 2.6, 2.6 + 3 * sigma))
    # Points remember the request positions they came from (the missing row is skipped).
    assert [p["indices"] for p in individual["points"]] == [[0], [1], [3], [4], [5]]
    assert [p["value"] for p in moving_range["points"]] == pytest.approx([2, 1, 2, 1])
    lcl, center, ucl = limits(moving_range["points"][0])
    assert (lcl, center) == (0, pytest.approx(1.5))
    assert ucl == pytest.approx(d4_upper(2) * 1.5)
    assert individual["x_label"] == "Sample"


def test_xbar_r_and_s_match_table_factors():
    rng = np.random.default_rng(1)
    values = rng.normal(50, 2, size=40)
    groups = values.reshape(8, 5)
    xbarbar = values.mean()
    rbar = np.ptp(groups, axis=1).mean()
    sbar = groups.std(axis=1, ddof=1).mean()

    xbar, rng_chart = charts(run("control_chart", cont("v", values.tolist()), chart_type="xbar_r", subgroup_size=5))
    assert limits(xbar["points"][0]) == pytest.approx((xbarbar - a2(5) * rbar, xbarbar, xbarbar + a2(5) * rbar))
    assert limits(rng_chart["points"][0]) == pytest.approx((0, rbar, d4_upper(5) * rbar))
    assert [p["value"] for p in xbar["points"]] == pytest.approx(groups.mean(axis=1))

    xbar, s_chart = charts(run("control_chart", cont("v", values.tolist()), chart_type="xbar_s", subgroup_size=5))
    assert limits(xbar["points"][0]) == pytest.approx((xbarbar - a3(5) * sbar, xbarbar, xbarbar + a3(5) * sbar))
    assert limits(s_chart["points"][0]) == pytest.approx((b3(5) * sbar, sbar, b4(5) * sbar))


def test_subgroup_column_groups_by_label_in_order_of_appearance():
    y = cont("v", [10, 20, 12, 22, 11, 21])
    g = cat("lot", ["B", "A", "B", "A", "B", "A"])
    xbar, _ = charts(run("control_chart", y, roles={"subgroup": [g]}, chart_type="xbar_r"))
    assert [p["label"] for p in xbar["points"]] == ["B", "A"]
    assert [p["indices"] for p in xbar["points"]] == [[0, 2, 4], [1, 3, 5]]
    assert [p["value"] for p in xbar["points"]] == pytest.approx([11, 21])
    assert xbar["x_label"] == "lot"


def test_varying_subgroup_sizes_give_per_point_limits():
    y = cont("v", [1, 2, 3, 4, 2, 3, 5, 4, 3])
    g = cat("g", ["a", "a", "a", "a", "b", "b", "c", "c", "c"])
    result = run("control_chart", y, roles={"subgroup": [g]}, chart_type="xbar_r")
    xbar, rchart = charts(result)
    sigma = np.mean([3 / d2(4), 1 / d2(2), 2 / d2(3)])
    grand = np.mean([1, 2, 3, 4, 2, 3, 5, 4, 3])
    for point, n in zip(xbar["points"], [4, 2, 3]):
        assert point["ucl"] == pytest.approx(grand + 3 * sigma / math.sqrt(n))
    assert rchart["points"][1]["center"] == pytest.approx(d2(2) * sigma)
    assert table_rows(result, "Limit Summaries")["XBar"][0] is None  # limits differ by point


# -------------------------------------------------------------- attribute charts


def test_p_chart_with_varying_sample_sizes():
    defectives = [3, 5, 2, 8]
    n = [50, 100, 40, 120]
    result = run("control_chart", cont("d", defectives), roles={"sample_size": [cont("n", n)]}, chart_type="p")
    (chart,) = charts(result)
    p_bar = sum(defectives) / sum(n)
    for point, d, size in zip(chart["points"], defectives, n):
        sd = math.sqrt(p_bar * (1 - p_bar) / size)
        assert point["value"] == pytest.approx(d / size)
        assert limits(point) == pytest.approx((max(0, p_bar - 3 * sd), p_bar, p_bar + 3 * sd))


def test_np_c_and_u_charts():
    (np_chart,) = charts(run("control_chart", cont("d", [2, 4, 3, 5]), chart_type="np", sample_size=50))
    p_bar = 14 / 200
    assert limits(np_chart["points"][0]) == pytest.approx(
        (max(0, 50 * p_bar - 3 * math.sqrt(50 * p_bar * (1 - p_bar))), 50 * p_bar, 50 * p_bar + 3 * math.sqrt(50 * p_bar * (1 - p_bar)))
    )

    (c_chart,) = charts(run("control_chart", cont("c", [4, 9, 6, 5]), chart_type="c"))
    assert limits(c_chart["points"][0]) == pytest.approx((0, 6, 6 + 3 * math.sqrt(6)))

    defects, units = [3, 6, 2], [2, 4, 1]
    (u_chart,) = charts(run("control_chart", cont("c", defects), roles={"sample_size": [cont("units", units)]}, chart_type="u"))
    u_bar = 11 / 7
    assert [p["value"] for p in u_chart["points"]] == pytest.approx([1.5, 1.5, 2])
    assert u_chart["points"][2]["ucl"] == pytest.approx(u_bar + 3 * math.sqrt(u_bar / 1))


def test_p_chart_of_categorical_column_counts_the_defect_level():
    y = cat("result", ["Pass", "Fail", "Pass", "Pass", "Fail", "Fail", None, "Pass"])
    (chart,) = charts(run("control_chart", y, chart_type="p", subgroup_size=4, defect_level="Fail"))
    # Missing rows are skipped before chunking: [P F P P] [F F P]
    assert [p["value"] for p in chart["points"]] == pytest.approx([1 / 4, 2 / 3])
    assert [p["indices"] for p in chart["points"]] == [[0, 1, 2, 3], [4, 5, 7]]
    assert chart["x_label"] == "Subgroup"
    (passes,) = charts(run("control_chart", y, chart_type="p", subgroup_size=4, defect_level="Pass"))
    assert passes["points"][0]["value"] == pytest.approx(3 / 4)


# ----------------------------------------------------------------------- tests


def z_chart(zs: list[float], location: bool = True) -> Chart:
    points = [Point(str(i + 1), z, 0.0, -3.0, 3.0, 1.0, [i]) for i, z in enumerate(zs)]
    chart = Chart("t", "t", "t", points, location, 1.0, 1.0)
    _run_tests(chart, beyond=True, nelson=True)
    return chart


def flagged(chart: Chart, test: int) -> list[int]:
    return [i for i, p in enumerate(chart.points) if test in p.tests]


@pytest.mark.parametrize(
    ("test", "zs", "expected"),
    [
        (1, [0, 0, 3.5, 0, -3.2], [2, 4]),
        (2, [0.5] * 9, [8]),
        (3, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [5]),
        (4, [0.5, -0.5] * 7, [13]),
        (5, [0, 2.5, 0, 2.5], [3]),
        (6, [1.5, 1.5, 0, 1.5, 1.5], [4]),
        (7, [0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1], [14]),
        (8, [1.5, -1.5, 1.5, 1.5, -1.5, -1.5, 1.5, -1.5], [7]),
    ],
)
def test_each_nelson_test_flags_the_completing_point(test, zs, expected):
    assert flagged(z_chart(zs), test) == expected


def test_nelson_tests_only_on_location_charts_and_when_enabled():
    chart = z_chart([0.5] * 9, location=False)
    assert all(p.tests == [] for p in chart.points)
    y = cont("x", [10, 10.5, 9.5, 10, 10.2, 9.8, 30, 10, 10.1])
    result = run("control_chart", y, chart_type="imr")
    assert 1 in charts(result)[0]["points"][6]["tests"]
    assert table_rows(result, "Test Failures")["Individual"][0] == 7
    quiet = run("control_chart", y, chart_type="imr", options={"test_beyond_limits": False})
    assert all(not p["tests"] for c in charts(quiet) for p in c["points"])


# -------------------------------------------------------------------- capability


def test_capability_indices_and_nonconformance():
    rng = np.random.default_rng(7)
    values = rng.normal(10, 1, size=60)
    lsl, target, usl = 7.0, 10.0, 12.5
    result = run("capability", cont("w", values.tolist()), lsl=lsl, target=target, usl=usl)
    mean, s = values.mean(), values.std(ddof=1)
    within = np.abs(np.diff(values)).mean() / d2(2)

    indices = outline(result, "Capability Indices")
    within_table, overall_table = [n for n in walk(indices["children"]) if n["type"] == "table"]
    w = {row[0]: row[1:] for row in within_table["rows"]}
    o = {row[0]: row[1:] for row in overall_table["rows"]}
    assert w["Cp"][0] == pytest.approx((usl - lsl) / (6 * within))
    assert w["Cpk"][0] == pytest.approx(min(mean - lsl, usl - mean) / (3 * within))
    assert o["Pp"][0] == pytest.approx((usl - lsl) / (6 * s))
    assert o["Ppu"][0] == pytest.approx((usl - mean) / (3 * s))
    assert o["Cpm"][0] == pytest.approx(min(target - lsl, usl - target) / (3 * math.sqrt(s**2 + (mean - target) ** 2)))
    df = len(values) - 1
    assert o["Pp"][1] == pytest.approx(o["Pp"][0] * math.sqrt(stats.chi2.ppf(0.025, df) / df))
    ppk = o["Ppk"][0]
    assert o["Ppk"][2] == pytest.approx(ppk + 1.959964 * math.sqrt(1 / (9 * 60) + ppk**2 / (2 * 59)), rel=1e-5)

    rows = table_rows(result, "Nonconformance")
    assert rows["Below LSL"][0] == pytest.approx(np.mean(values < lsl))
    assert rows["Above USL"][1] == pytest.approx(stats.norm.sf((usl - mean) / within))
    assert rows["Total Outside"][2] == pytest.approx(stats.norm.cdf((lsl - mean) / s) + stats.norm.sf((usl - mean) / s))

    hist = next(n["plot"] for n in walk(result["nodes"]) if n["type"] == "plot")
    assert [ref["label"] for ref in hist["reference_lines"]] == ["LSL", "Target", "USL"]


def test_capability_one_sided_and_subgroup_sigma():
    values = [5.0, 6, 7, 6, 5, 7, 8, 6]
    g = cat("g", ["a", "a", "b", "b", "c", "c", "d", "d"])
    result = run("capability", cont("w", values), roles={"subgroup": [g]}, usl=10)
    pooled = math.sqrt(sum((a - b) ** 2 / 2 for a, b in zip(values[::2], values[1::2])) / 4)
    within = {n["rows"][i][0]: n["rows"][i][1] for n in walk(outline(result, "Capability Indices")["children"]) if n["type"] == "table" for i in range(len(n["rows"]))}
    assert within["Cp"] is None
    assert within["Cpl"] is None
    assert within["Cpu"] == pytest.approx((10 - np.mean(values)) / (3 * pooled))
    assert within["Cpk"] == within["Cpu"]
    assert list(table_rows(result, "Nonconformance")) == ["Above USL", "Total Outside"]


def test_control_chart_adds_capability_with_chart_sigma():
    values = [10.0, 11, 9, 10, 12, 10, 9, 11]
    result = run("control_chart", cont("x", values), chart_type="imr", lsl=6, usl=14)
    sigma = np.abs(np.diff(values)).mean() / d2(2)
    rows = {r_[0]: r_[1] for n in walk(outline(result, "Capability Indices")["children"]) if n["type"] == "table" for r_ in n["rows"]}
    assert rows["Cp"] == pytest.approx(8 / (6 * sigma))


# -------------------------------------------------------------------- degenerate


@pytest.mark.parametrize(
    ("platform", "y", "params"),
    [
        ("control_chart", cont("x", [None, None]), {"chart_type": "imr"}),
        ("control_chart", cont("x", [5]), {"chart_type": "imr"}),
        ("control_chart", cont("x", [5, 5, 5, 5, 5, 5]), {"chart_type": "xbar_r", "subgroup_size": 3}),
        ("control_chart", cont("x", [1, 2, 3]), {"chart_type": "xbar_s", "subgroup_size": 1}),
        ("control_chart", cont("x", [0, 0, 0]), {"chart_type": "p", "sample_size": 10}),
        ("control_chart", cont("x", [1, 2]), {"chart_type": "u"}),
        ("control_chart", cat("x", ["a", "b"]), {"chart_type": "imr"}),
        ("control_chart", cat("x", ["a", "b"]), {"chart_type": "p"}),
        ("control_chart", cont("x", [1, 2]), {"chart_type": "bogus"}),
        ("capability", cont("x", [1, 2, 3]), {}),
        ("capability", cont("x", [4, 4, 4]), {"lsl": 1, "usl": 9}),
        ("capability", cont("x", [None]), {"lsl": 1}),
        ("capability", cont("x", [3]), {"usl": 9}),
        ("capability", cont("x", [1, 2, 3]), {"lsl": 9, "usl": 1}),
    ],
)
def test_degenerate_inputs_warn_instead_of_failing(platform, y, params):
    result = run(platform, y, **params)
    assert warnings_of(result)


def test_constant_imr_runs_with_collapsed_limits():
    result = run("control_chart", cont("x", [3, 3, 3, 3]), chart_type="imr")
    individual, _ = charts(result)
    assert limits(individual["points"][0]) == pytest.approx((3, 3, 3))
    assert warnings_of(result)
    assert not any(p["tests"] for p in individual["points"])


def test_endpoint_round_trip(client):
    body = {
        "platform": "control_chart",
        "y": {"name": "x", "modeling_type": "continuous", "values": [1, 2, 3, 2, 1, 2]},
        "params": {"chart_type": "imr", "lsl": None, "usl": "5"},
        "options": {"show_zones": True},
    }
    res = client.post("/api/analyze", json=body)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["analysis"] == "control_chart"
    plots = [n["plot"] for n in walk(data["nodes"]) if n["type"] == "plot" and n["plot"]["kind"] == "control_chart"]
    assert [p["show_zones"] for p in plots] == [True, False]
    assert any(n["type"] == "outline" and n["title"] == "Process Capability of x" for n in walk(data["nodes"]))
