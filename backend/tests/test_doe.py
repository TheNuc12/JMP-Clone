"""Design of experiments: construction, aliasing, efficiencies, payload shape and validation."""

from __future__ import annotations

import itertools
import json
import math
from collections import Counter

import numpy as np
import pytest

from app import doe_designs as d
from app.doe import DoeError, make_design
from app.schemas import DoeFactor, DoeRequest, DoeResponse


def cont(name: str, low: float = -1, high: float = 1) -> DoeFactor:
    return DoeFactor(name=name, kind="continuous", low=low, high=high)


def cat(name: str, *levels: str) -> DoeFactor:
    return DoeFactor(name=name, kind="categorical", levels=list(levels))


def design(kind: str, factors: list[DoeFactor], **kw) -> tuple[dict, list[dict]]:
    """Make a design; return (table columns by name, report nodes) as JSON-shaped dicts."""
    res = make_design(DoeRequest(design=kind, factors=factors, seed=kw.pop("seed", 7), **kw))
    data = res.model_dump(mode="json")
    json.dumps(data, allow_nan=False)
    return data["table"], data["nodes"]


def columns(table: dict) -> dict[str, list]:
    return {c["name"]: c["values"] for c in table["columns"]}


def summary_value(nodes: list[dict], label: str):
    stack = list(nodes)
    while stack:
        node = stack.pop()
        if node["type"] == "summary":
            for item in node["items"]:
                if item["label"] == label:
                    return item["value"]
        stack.extend(node.get("children", []))
    raise KeyError(label)


def table_rows(nodes: list[dict], outline_title: str) -> list[list]:
    stack = list(nodes)
    while stack:
        node = stack.pop()
        if node["type"] == "outline" and node["title"] == outline_title:
            return next(c for c in node["children"] if c["type"] == "table")["rows"]
        stack.extend(node.get("children", []))
    raise KeyError(outline_title)


# -------------------------------------------------------------------- run counts


@pytest.mark.parametrize(
    ("kind", "factors", "kw", "runs"),
    [
        ("full_factorial", [cont("A"), cont("B"), cat("C", "x", "y", "z")], {}, 12),
        ("full_factorial", [cont("A"), cont("B")], {"replicates": 1, "center_points": 3}, 11),
        ("fractional_factorial", [cont(f"X{i}") for i in range(4)], {}, 8),
        ("fractional_factorial", [cont(f"X{i}") for i in range(5)], {}, 16),
        ("fractional_factorial", [cont(f"X{i}") for i in range(5)], {"resolution": 3}, 8),
        ("fractional_factorial", [cont(f"X{i}") for i in range(7)], {"resolution": 4}, 16),
        ("fractional_factorial", [cont(f"X{i}") for i in range(3)], {}, 8),
        ("fractional_factorial", [cont(f"X{i}") for i in range(14)], {"resolution": 3}, 16),
        ("response_surface", [cont(f"X{i}") for i in range(3)], {"center_points": 6}, 20),
        ("response_surface", [cont(f"X{i}") for i in range(5)], {"center_points": 6}, 16 + 10 + 6),
        ("response_surface", [cont(f"X{i}") for i in range(3)], {"rsm_type": "box_behnken", "center_points": 3}, 15),
        ("response_surface", [cont(f"X{i}") for i in range(4)], {"rsm_type": "box_behnken", "center_points": 3}, 27),
        ("response_surface", [cont(f"X{i}") for i in range(7)], {"rsm_type": "box_behnken", "center_points": 3}, 59),
        ("custom", [cont("A"), cont("B"), cont("C")], {}, 4 + 4),
        ("custom", [cont("A"), cont("B")], {"model": [["A"], ["B"], ["A", "B"]], "n_runs": 6}, 6),
    ],
)
def test_run_counts(kind, factors, kw, runs):
    table, _ = design(kind, factors, **kw)
    assert table["n_rows"] == runs
    assert all(len(c["values"]) == runs for c in table["columns"])


# ------------------------------------------------------------------ full factorial


def test_full_factorial_is_orthogonal_and_complete():
    factors = [d.Factor("A", "continuous"), d.Factor("B", "continuous"), d.Factor("C", "continuous")]
    runs = d.full_factorial(factors)
    effects = [(0,), (1,), (2,), (0, 1), (0, 2), (1, 2), (0, 1, 2)]
    x, _ = d.model_matrix(runs.coded, factors, effects)
    np.testing.assert_allclose(x.T @ x, 8 * np.eye(8))
    assert sorted(runs.patterns) == sorted("".join(p) for p in itertools.product("-+", repeat=3))


def test_full_factorial_efficiencies_are_100_with_categorical_factor():
    _, nodes = design("full_factorial", [cont("A"), cat("C", "x", "y", "z")])
    for label in ("D Efficiency", "A Efficiency", "G Efficiency"):
        assert summary_value(nodes, label) == pytest.approx(100)


def test_average_variance_of_2x2_main_effects():
    factors = [d.Factor("A", "continuous"), d.Factor("B", "continuous")]
    diag = d.diagnose(d.full_factorial(factors).coded, factors, [(0,), (1,)])
    # trace(M (X'X)^-1) with M = diag(1, 1/3, 1/3), X'X = 4I.
    assert diag.average_variance == pytest.approx((1 + 2 / 3) / 4)


# -------------------------------------------------------------- fractional factorial


@pytest.mark.parametrize("k", range(3, 16))
def test_fractions_realize_their_defining_relation(k):
    factors = [d.Factor(f"F{i}", "continuous") for i in range(k)]
    for fraction in d.fractions_for(k):
        if fraction.runs > 512:
            continue
        runs = d.fraction_runs(fraction, factors)
        x = runs.coded
        assert len(x) == fraction.runs
        # Every word of the defining relation is a constant column (the identity).
        for word in fraction.defining_words:
            product = np.prod(x[:, [i for i in range(k) if word >> i & 1]], axis=1)
            assert np.all(product == 1)
        # Main effects are balanced and mutually orthogonal.
        np.testing.assert_allclose(x.T @ x, fraction.runs * np.eye(k))
        if fraction.generators:
            assert fraction.resolution == min(bin(w).count("1") for w in fraction.defining_words)


@pytest.mark.parametrize(
    ("k", "runs", "resolution"),
    [(3, 4, 3), (4, 8, 4), (5, 16, 5), (6, 16, 4), (6, 32, 6), (7, 16, 4), (8, 64, 5), (9, 128, 6), (10, 128, 5), (11, 128, 5), (12, 32, 4)],
)
def test_known_resolutions(k, runs, resolution):
    by_runs = {f.runs: f for f in d.fractions_for(k)}
    assert by_runs[runs].resolution == resolution


def test_half_fraction_alias_structure():
    _, nodes = design("fractional_factorial", [cont(n) for n in "ABCD"], resolution=4)
    stack = list(nodes)
    texts = []
    while stack:
        node = stack.pop()
        if node["type"] == "outline" and node["title"] == "Design Generators":
            texts = [c["text"] for c in node["children"]]
        stack.extend(node.get("children", []))
    assert texts == ["D = A*B*C"]
    rows = dict(table_rows(nodes, "Alias Structure"))
    assert rows["A"] == "—"
    assert rows["A*B"] == "C*D"
    assert rows["A*C"] == "B*D"
    assert rows["A*D"] == "B*C"
    assert summary_value(nodes, "Resolution") == "IV"


def test_resolution_iii_aliases_main_effects_with_interactions():
    _, nodes = design("fractional_factorial", [cont(n) for n in "ABC"], resolution=3)
    rows = dict(table_rows(nodes, "Alias Structure"))
    assert rows == {"A": "B*C", "B": "A*C", "C": "A*B"}


def test_two_level_categorical_factors_in_screening():
    table, _ = design("fractional_factorial", [cont("A"), cont("B"), cat("C", "lo", "hi"), cont("D")], randomize=False)
    cols = columns(table)
    assert set(cols["C"]) == {"lo", "hi"}
    assert all(p[2] in "12" for p in cols["Pattern"])


def test_screening_rejects_multilevel_factor():
    with pytest.raises(DoeError, match="2-level"):
        design("fractional_factorial", [cont("A"), cont("B"), cat("C", "x", "y", "z")])


# ------------------------------------------------------------------ response surface


@pytest.mark.parametrize(
    ("k", "kind", "centers", "alpha"),
    [(2, "rotatable", 5, math.sqrt(2)), (3, "rotatable", 6, 8**0.25), (5, "rotatable", 6, 2.0), (2, "orthogonal", 1, 1.0), (3, "face_centered", 6, 1.0)],
)
def test_ccd_alpha_axial_and_center_points(k, kind, centers, alpha):
    names = [f"X{i}" for i in range(k)]
    table, nodes = design("response_surface", [cont(n) for n in names], ccd_alpha=kind, center_points=centers, randomize=False)
    assert summary_value(nodes, "Axial value (alpha)") == pytest.approx(alpha, abs=1e-4)
    cols = columns(table)
    patterns = cols["Pattern"]
    axial = [p for p in patterns if "a" in p or "A" in p]
    assert len(axial) == 2 * k
    assert patterns.count("0" * k) == centers
    values = np.array([cols[n] for n in names]).T
    assert np.max(np.abs(values)) == pytest.approx(alpha, abs=1e-4)


def test_ccd_orthogonal_alpha_matches_formula():
    # k = 3, 8 cube points, 6 axial + 4 center: alpha = ((sqrt(18) - sqrt(8))^2 * 8 / 4) ** 0.25
    expected = ((math.sqrt(18) - math.sqrt(8)) ** 2 * 8 / 4) ** 0.25
    assert d.ccd_alpha("orthogonal", 3, 8, 4) == pytest.approx(expected)


def test_box_behnken_three_factor_structure():
    factors = [d.Factor(f"X{i}", "continuous") for i in range(3)]
    runs = d.box_behnken(factors)
    assert len(runs) == 12
    zeros = (runs.coded == 0).sum(axis=1)
    assert np.all(zeros == 1)
    pairs = Counter(tuple(np.flatnonzero(r)) for r in runs.coded)
    assert pairs == {(0, 1): 4, (0, 2): 4, (1, 2): 4}


def test_box_behnken_balanced_blocks_for_seven_factors():
    factors = [d.Factor(f"X{i}", "continuous") for i in range(7)]
    runs = d.box_behnken(factors)
    assert len(runs) == 56
    # Every factor appears at +/-1 equally often and the design is balanced.
    np.testing.assert_allclose(runs.coded.sum(axis=0), 0)
    assert len({int((runs.coded[:, j] != 0).sum()) for j in range(7)}) == 1


def test_response_surface_model_is_estimable():
    table, nodes = design("response_surface", [cont("A"), cont("B"), cont("C")], rsm_type="box_behnken", center_points=3)
    assert summary_value(nodes, "D Efficiency") > 0
    effects = table["model"]["effects"]
    assert ["A", "A"] in effects and ["A", "B"] in effects and ["C"] in effects


def test_response_surface_rejects_categorical():
    with pytest.raises(DoeError, match="continuous"):
        design("response_surface", [cont("A"), cat("B", "x", "y")])


# ---------------------------------------------------------------------- custom


def test_d_optimal_main_effects_in_four_runs_is_the_full_factorial():
    table, nodes = design("custom", [cont("A"), cont("B")], n_runs=4)
    assert sorted(columns(table)["Pattern"]) == ["++", "+-", "-+", "--"]
    assert summary_value(nodes, "D Efficiency") == pytest.approx(100)


def test_d_optimal_beats_random_design():
    factors = [d.Factor(n, "continuous") for n in "ABC"]
    effects = [(0,), (1,), (2,), (0, 1), (0, 0), (1, 1)]
    n = 12
    rng = np.random.default_rng(1)
    best = d.coordinate_exchange(factors, effects, n, rng)

    def logdet(design_):
        x, _ = d.model_matrix(design_, factors, effects)
        return np.linalg.slogdet(x.T @ x)[1]

    random_design = rng.choice([-1.0, 0.0, 1.0], size=(n, 3))
    assert logdet(best) >= logdet(random_design)
    # Quadratic terms need the middle level.
    assert set(np.unique(best[:, 0])) == {-1.0, 0.0, 1.0}
    assert set(np.unique(best[:, 2])) <= {-1.0, 1.0}


def test_custom_with_categorical_factor_and_model_names():
    table, nodes = design(
        "custom",
        [cont("Temp", 150, 200), cat("Catalyst", "A", "B", "C")],
        model=[["Temp"], ["Catalyst"], ["Temp", "Catalyst"]],
    )
    assert table["n_rows"] == 6 + 4
    assert table["model"]["effects"] == [["Temp"], ["Catalyst"], ["Temp", "Catalyst"]]
    assert set(columns(table)["Temp"]) <= {150.0, 200.0}
    assert table_rows(nodes, "Correlations of Model Terms")


def test_custom_needs_enough_runs():
    with pytest.raises(DoeError, match="at least 4 runs"):
        design("custom", [cont("A"), cont("B"), cont("C")], n_runs=3)


# ---------------------------------------------------------------- payload & order


def test_payload_shape_and_decoding():
    req = dict(
        factors=[cont("Temp", 100, 200), cat("Mix", "slow", "fast")],
        responses=[DoeResponse(name="Yield"), DoeResponse(name="Cost", goal="minimize")],
        center_points=2,
        randomize=False,
    )
    table, nodes = design("full_factorial", **req)
    names = [c["name"] for c in table["columns"]]
    assert names == ["Pattern", "Temp", "Mix", "Yield", "Cost"]
    by_name = {c["name"]: c for c in table["columns"]}
    assert by_name["Pattern"]["data_type"] == "character"
    assert by_name["Temp"]["modeling_type"] == "continuous"
    assert by_name["Mix"]["modeling_type"] == "nominal"
    assert by_name["Mix"]["value_order"] == ["slow", "fast"]
    assert by_name["Yield"]["values"] == [None] * table["n_rows"]
    assert set(by_name["Temp"]["values"]) == {100.0, 150.0, 200.0}
    assert by_name["Pattern"]["values"][:4] == ["-1", "-2", "+1", "+2"]
    assert by_name["Pattern"]["values"][-2:] == ["01", "02"]
    assert table["model"] == {"responses": ["Yield", "Cost"], "effects": [["Temp"], ["Mix"], ["Temp", "Mix"]]}
    assert table["name"] == "DOE Full Factorial"
    assert dict(table_rows(nodes, "Responses")) == {"Yield": "Maximize", "Cost": "Minimize"}


def test_randomization_respects_seed():
    factors = [cont(n) for n in "ABCD"]
    first = columns(design("full_factorial", factors, seed=11)[0])["Pattern"]
    again = columns(design("full_factorial", factors, seed=11)[0])["Pattern"]
    other = columns(design("full_factorial", factors, seed=12)[0])["Pattern"]
    standard = columns(design("full_factorial", factors, randomize=False)[0])["Pattern"]
    assert first == again
    assert first != other
    assert sorted(first) == sorted(standard)
    assert standard[0] == "----" and standard[-1] == "++++"


def test_replicates_repeat_design_but_not_center_points():
    table, _ = design("full_factorial", [cont("A"), cont("B")], replicates=2, center_points=1, randomize=False)
    patterns = columns(table)["Pattern"]
    assert Counter(patterns) == {"--": 3, "-+": 3, "+-": 3, "++": 3, "00": 1}


# ------------------------------------------------------------------------ errors


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"design": "full_factorial", "factors": []}, "at least one factor"),
        ({"design": "full_factorial", "factors": [{"name": "A", "kind": "continuous"}, {"name": "a", "kind": "continuous"}]}, "unique"),
        ({"design": "full_factorial", "factors": [{"name": "A", "kind": "continuous", "low": 5, "high": 1}]}, "below the high"),
        ({"design": "full_factorial", "factors": [{"name": "A", "kind": "categorical", "levels": ["x"]}]}, "at least 2 levels"),
        ({"design": "full_factorial", "factors": [{"name": "Y", "kind": "continuous"}]}, "already used"),
        ({"design": "full_factorial", "factors": [{"name": f"F{i}", "kind": "continuous"} for i in range(13)]}, "up to 12"),
        ({"design": "response_surface", "factors": [{"name": "A", "kind": "continuous"}], "rsm_type": "box_behnken"}, "3 to 7"),
        ({"design": "custom", "factors": [{"name": "A", "kind": "continuous"}], "model": [["A"], ["Z"]]}, "unknown factor"),
        ({"design": "custom", "factors": [{"name": "C", "kind": "categorical", "levels": ["x", "y"]}], "model": [["C", "C"]]}, "twice"),
        ({"design": "full_factorial", "factors": [{"name": "C", "kind": "categorical", "levels": ["x", "y"]}], "center_points": 2}, "continuous"),
    ],
)
def test_invalid_requests_are_400(client, body, message):
    res = client.post("/api/doe", json=body)
    assert res.status_code == 400, res.text
    assert message in res.json()["detail"]


def test_doe_endpoint_returns_table_and_report(client):
    res = client.post(
        "/api/doe",
        json={"design": "response_surface", "factors": [{"name": "A", "kind": "continuous"}, {"name": "B", "kind": "continuous"}], "center_points": 5},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["table"]["n_rows"] == 13
    assert body["nodes"][0]["title"] == "DOE Response Surface"
