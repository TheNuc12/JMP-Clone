from __future__ import annotations

import io
import json

import pandas as pd
import pytest

from app.samples import SAMPLES


def _strict_json(text: str) -> object:
    """Parse JSON rejecting NaN / Infinity, which browsers' JSON.parse cannot read."""

    def reject(token: str) -> None:
        raise AssertionError(f"Non-standard JSON constant {token}")

    return json.loads(text, parse_constant=reject)


def _as_request_column(column: dict) -> dict:
    """Mimic the frontend: categorical values become string labels."""
    values = column["values"]
    if column["modeling_type"] != "continuous":
        values = [None if v is None else str(v) for v in values]
    return {"name": column["name"], "modeling_type": column["modeling_type"], "values": values}


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_samples_list_and_fetch(client):
    listing = client.get("/api/samples").json()
    assert {s["id"] for s in listing} == set(SAMPLES)
    for info in listing:
        table = client.get(f"/api/samples/{info['id']}").json()
        assert table["n_rows"] == info["n_rows"]
        assert len(table["columns"]) == info["n_cols"]
        for col in table["columns"]:
            assert len(col["values"]) == table["n_rows"]


def test_samples_are_deterministic(client):
    a = client.get("/api/samples/process").text
    b = client.get("/api/samples/process").text
    assert a == b
    _strict_json(a)


def test_sample_modeling_types(client):
    students = {c["name"]: c for c in client.get("/api/samples/students").json()["columns"]}
    assert students["age"]["modeling_type"] == "ordinal"
    assert students["age"]["data_type"] == "numeric"
    assert students["sex"]["modeling_type"] == "nominal"
    assert students["height"]["modeling_type"] == "continuous"


def test_unknown_sample_404(client):
    assert client.get("/api/samples/nope").status_code == 404


def test_upload_csv(client):
    csv = "a,b,c,d\n1,x,1.5,true\n2, y ,,false\n3,,2.5,true\n"
    res = client.post("/api/upload", files={"file": ("my data.csv", csv, "text/csv")})
    assert res.status_code == 200, res.text
    table = res.json()
    assert table["name"] == "my data"
    assert table["n_rows"] == 3
    cols = {c["name"]: c for c in table["columns"]}
    assert {k: cols["a"][k] for k in ("name", "data_type", "modeling_type", "values")} == {
        "name": "a",
        "data_type": "numeric",
        "modeling_type": "continuous",
        "values": [1, 2, 3],
    }
    assert cols["b"]["data_type"] == "character"
    assert cols["b"]["values"] == ["x", "y", None]
    assert cols["c"]["values"] == [1.5, None, 2.5]
    assert cols["d"]["modeling_type"] == "nominal"
    assert cols["d"]["values"] == ["True", "False", "True"]


def test_upload_dot_is_missing(client):
    res = client.post("/api/upload", files={"file": ("d.csv", "v\n1\n.\n3\n", "text/csv")})
    assert res.json()["columns"][0]["values"] == [1, None, 3]


def test_upload_tsv_and_txt(client):
    tsv = "x\ty\n1\ta\n2\tb\n"
    assert client.post("/api/upload", files={"file": ("t.tsv", tsv)}).json()["columns"][1]["values"] == ["a", "b"]
    txt = "x;y\n1;a\n2;b\n"
    cols = client.post("/api/upload", files={"file": ("t.txt", txt)}).json()["columns"]
    assert [c["name"] for c in cols] == ["x", "y"]


def test_upload_xlsx_round_trip(client):
    df = pd.DataFrame(
        {
            "id": [1, 2, 3],
            "group": ["a", "b", None],
            "value": [0.5, None, 2.25],
            "when": pd.to_datetime(["2024-01-01", "2024-02-01", None]),
        }
    )
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    res = client.post("/api/upload", files={"file": ("book.xlsx", buf.getvalue())})
    assert res.status_code == 200, res.text
    cols = {c["name"]: c for c in res.json()["columns"]}
    assert cols["id"]["values"] == [1, 2, 3]
    assert cols["group"]["values"] == ["a", "b", None]
    assert cols["value"]["values"] == [0.5, None, 2.25]
    assert cols["when"]["data_type"] == "character"
    assert cols["when"]["values"] == ["2024-01-01", "2024-02-01", None]


@pytest.mark.parametrize(
    ("filename", "content"),
    [("data.json", b"{}"), ("empty.csv", b""), ("old.xls", b"\xd0\xcf\x11\xe0"), ("bad.xlsx", b"not a zip")],
)
def test_upload_rejects_bad_files(client, filename, content):
    res = client.post("/api/upload", files={"file": (filename, content)})
    assert res.status_code == 400
    assert res.json()["detail"]


ANALYSIS_CASES = [
    ("students", "distribution", "height", None, {"fit_normal": True}, "distribution_continuous"),
    ("students", "distribution", "sex", None, {}, "distribution_categorical"),
    ("students", "fit_y_by_x", "weight", "height", {"fit_mean": True, "fit_quadratic": True, "correlation": True}, "bivariate"),
    ("process", "fit_y_by_x", "yield_pct", "machine", {k: True for k in ["means_std", "box_plots", "unequal_variances", "nonparametric", "tukey"]}, "oneway"),
    ("students", "fit_y_by_x", "height", "sex", {"t_test": True}, "oneway"),
    ("trial", "fit_y_by_x", "response", "treatment", {}, "contingency"),
    ("process", "fit_y_by_x", "defect", "shift", {}, "contingency"),
    ("process", "fit_y_by_x", "defect", "temperature", {"odds_ratios": True}, "logistic"),
    ("trial", "fit_y_by_x", "response", "bp_change", {"odds_ratios": True}, "logistic"),
]


@pytest.mark.parametrize(("sample", "platform", "y", "x", "options", "kind"), ANALYSIS_CASES)
def test_analyze_endpoint(client, sample, platform, y, x, options, kind):
    columns = {c["name"]: c for c in client.get(f"/api/samples/{sample}").json()["columns"]}
    body = {"platform": platform, "y": _as_request_column(columns[y]), "options": options}
    if x:
        body["x"] = _as_request_column(columns[x])
    res = client.post("/api/analyze", json=body)
    assert res.status_code == 200, res.text
    result = _strict_json(res.text)
    assert result["analysis"] == kind
    assert result["nodes"]
    for key, value in options.items():
        option = next(o for o in result["options"] if o["key"] == key)
        assert option["value"] is value


def test_analyze_requires_x_for_fit_y_by_x(client):
    body = {"platform": "fit_y_by_x", "y": {"name": "y", "modeling_type": "continuous", "values": [1, 2]}}
    res = client.post("/api/analyze", json=body)
    assert res.status_code == 400


def test_analyze_length_mismatch(client):
    body = {
        "platform": "fit_y_by_x",
        "y": {"name": "y", "modeling_type": "continuous", "values": [1, 2, 3]},
        "x": {"name": "x", "modeling_type": "continuous", "values": [1, 2]},
    }
    assert client.post("/api/analyze", json=body).status_code == 400


def test_options_defaults_reported(client):
    body = {"platform": "fit_y_by_x", "y": {"name": "y", "modeling_type": "continuous", "values": [1, 2, 4, 3]},
            "x": {"name": "x", "modeling_type": "continuous", "values": [1, 2, 3, 4]}}
    options = {o["key"]: o["value"] for o in client.post("/api/analyze", json=body).json()["options"]}
    assert options == {"fit_mean": False, "fit_line": True, "fit_quadratic": False, "correlation": False}


def _plots(nodes):
    for node in nodes:
        if node["type"] == "plot":
            yield node["plot"]
        yield from _plots(node.get("children", []))


def test_value_order_controls_levels(client):
    y = {
        "name": "response",
        "modeling_type": "ordinal",
        "values": ["Same", "Worse", "Improved", "Same", "Other"],
        "levels": ["Worse", "Same", "Improved", "Not present"],
    }
    res = client.post("/api/analyze", json={"platform": "distribution", "y": y})
    assert res.status_code == 200, res.text
    (bar,) = [p for p in _plots(res.json()["nodes"]) if p["kind"] == "bar"]
    # Listed levels first in the given order; unlisted ones after; absent ones dropped.
    assert bar["levels"] == ["Worse", "Same", "Improved", "Other"]
