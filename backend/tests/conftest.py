from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.analyses import run_analysis
from app.main import app
from app.schemas import AnalysisColumn, AnalyzeRequest


@pytest.fixture(scope="session")
def client() -> TestClient:
    return TestClient(app)


def cont(name: str, values: list[Any]) -> AnalysisColumn:
    return AnalysisColumn(name=name, modeling_type="continuous", values=values)


def cat(name: str, values: list[Any], modeling_type: str = "nominal") -> AnalysisColumn:
    return AnalysisColumn(
        name=name,
        modeling_type=modeling_type,
        values=[None if v is None else str(v) for v in values],
    )


def analyze(y: AnalysisColumn, x: AnalysisColumn | None = None, **options: bool) -> dict:
    """Run an analysis and return the JSON-shaped result."""
    platform = "distribution" if x is None else "fit_y_by_x"
    result = run_analysis(AnalyzeRequest(platform=platform, y=y, x=x, options=options))
    return result.model_dump(mode="json")


def walk(nodes: list[dict]) -> Iterator[dict]:
    for node in nodes:
        yield node
        yield from walk(node.get("children", []))


def outline(result: dict, title: str) -> dict:
    for node in walk(result["nodes"]):
        if node["type"] == "outline" and node["title"] == title:
            return node
    raise AssertionError(f"No outline titled {title!r}")


def first(node: dict, node_type: str) -> dict:
    for child in walk(node["children"]):
        if child["type"] == node_type:
            return child
    raise AssertionError(f"No {node_type} node under {node.get('title')!r}")


def summary_values(result: dict, title: str) -> dict[str, Any]:
    node = first(outline(result, title), "summary")
    return {item["label"]: item["value"] for item in node["items"]}


def table_rows(result: dict, title: str) -> dict[str, list[Any]]:
    """Rows of the first table under an outline, keyed by their first cell."""
    node = first(outline(result, title), "table")
    return {row[0]: row[1:] for row in node["rows"]}


def plot(result: dict) -> dict:
    for node in walk(result["nodes"]):
        if node["type"] == "plot":
            return node["plot"]
    raise AssertionError("No plot")


def warnings_of(result: dict) -> list[str]:
    return [n["text"] for n in walk(result["nodes"]) if n["type"] == "text" and n["tone"] == "warning"]
