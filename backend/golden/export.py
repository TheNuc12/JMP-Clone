"""Export golden cases: requests run through the Python engine, with their exact results.

The TypeScript engine (frontend/src/engine) must reproduce every case. Run with
``uv run python -m golden.export`` from backend/. Case modules live in golden/cases/ and
define ``AREA`` and ``cases()``; each area is written to frontend/src/engine/golden/<area>.json.

Column references keep the files small: ``{"$col": "dataset.column", "modeling_type": ...,
"levels": [...]}`` stands for an AnalysisColumn built like the frontend's toAnalysisColumn
(categorical values become labels, continuous values numbers or null). A case's optional
``rows`` lists the dataset rows sent (the rest are excluded).
"""

from __future__ import annotations

import base64
import importlib
import json
import math
import pkgutil
from pathlib import Path
from typing import Any

from app.analyses import AnalysisRequestError, run_analysis
from app.doe import DoeError, make_design
from app.io import UploadError, parse_upload
from app.samples import SAMPLES, get_sample, list_samples
from app.schemas import AnalyzeRequest, DoeRequest

from . import cases as cases_pkg
from .data import datasets

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "engine" / "golden"
SAMPLES_OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "engine" / "samples.json"


def _label(v: Any) -> str | None:
    """The frontend's labelOf: numbers print like JavaScript's String(number)."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def _number(v: Any) -> float | int | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def resolve_column(ref: dict[str, Any], rows: list[int] | None, used: set[str]) -> dict[str, Any]:
    dataset, column = ref["$col"].split(".", 1)
    used.add(dataset)
    values = datasets()[dataset][column]
    if rows is not None:
        values = [values[i] for i in rows]
    categorical = ref["modeling_type"] != "continuous"
    return {
        "name": ref.get("name", column),
        "modeling_type": ref["modeling_type"],
        "values": [_label(v) if categorical else _number(v) for v in values],
        "levels": ref.get("levels"),
    }


def resolve_request(request: dict[str, Any], rows: list[int] | None, used: set[str]) -> dict[str, Any]:
    out = dict(request)
    out["y"] = resolve_column(request["y"], rows, used)
    if request.get("x"):
        out["x"] = resolve_column(request["x"], rows, used)
    if request.get("roles"):
        out["roles"] = {k: [resolve_column(c, rows, used) for c in v] for k, v in request["roles"].items()}
    return out


def run_case(case: dict[str, Any], used: set[str]) -> Any:
    kind = case.get("kind", "analyze")
    try:
        if kind == "analyze":
            req = AnalyzeRequest.model_validate(resolve_request(case["request"], case.get("rows"), used))
            return run_analysis(req).model_dump(mode="json")
        if kind == "doe":
            return make_design(DoeRequest.model_validate(case["request"])).model_dump(mode="json")
        if kind == "upload":
            content = base64.b64decode(case["request"]["content_b64"])
            return parse_upload(case["request"]["filename"], content).model_dump(mode="json")
    except (AnalysisRequestError, DoeError, UploadError) as exc:
        return {"error": str(exc)}
    raise ValueError(f"unknown case kind {kind!r}")


def export_area(module: Any) -> Path:
    used: set[str] = set()
    out_cases = []
    names = set()
    for case in module.cases():
        if case["name"] in names:
            raise ValueError(f"duplicate case name {case['name']!r} in {module.AREA}")
        names.add(case["name"])
        out_cases.append({**case, "expected": run_case(case, used)})
    payload = {"area": module.AREA, "datasets": {d: datasets()[d] for d in sorted(used)}, "cases": out_cases}
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{module.AREA}.json"
    path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    return path


def export_samples() -> None:
    payload = {
        "info": [s.model_dump(mode="json") for s in list_samples()],
        "tables": {sid: get_sample(sid).model_dump(mode="json") for sid in SAMPLES},
    }
    SAMPLES_OUT.write_text(json.dumps(payload, separators=(",", ":")))


def main() -> None:
    export_samples()
    for info in pkgutil.iter_modules(cases_pkg.__path__):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{cases_pkg.__name__}.{info.name}")
        path = export_area(module)
        print(f"{path.relative_to(OUT.parents[3])}: {len(module.cases())} cases, {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
