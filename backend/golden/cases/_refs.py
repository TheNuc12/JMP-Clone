"""Shorthands for building golden requests."""

from __future__ import annotations

from itertools import product
from typing import Any


def col(ref: str, modeling_type: str = "continuous", levels: list[str] | None = None, name: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"$col": ref, "modeling_type": modeling_type}
    if levels is not None:
        out["levels"] = levels
    if name is not None:
        out["name"] = name
    return out


def cont(ref: str, **kw: Any) -> dict[str, Any]:
    return col(ref, "continuous", **kw)


def nom(ref: str, **kw: Any) -> dict[str, Any]:
    return col(ref, "nominal", **kw)


def ordi(ref: str, **kw: Any) -> dict[str, Any]:
    return col(ref, "ordinal", **kw)


def analyze(name: str, platform: str, y: dict, x: dict | None = None, *, roles: dict | None = None,
            params: dict | None = None, options: dict | None = None, rows: list[int] | None = None,
            tol: dict | None = None) -> dict[str, Any]:
    request: dict[str, Any] = {"platform": platform, "y": y, "options": options or {}}
    if x is not None:
        request["x"] = x
    if roles:
        request["roles"] = roles
    if params:
        request["params"] = params
    case: dict[str, Any] = {"name": name, "kind": "analyze", "request": request}
    if rows is not None:
        case["rows"] = rows
    if tol:
        case["tol"] = tol
    return case


def all_on(keys: list[str]) -> dict[str, bool]:
    return {k: True for k in keys}


def all_off(keys: list[str]) -> dict[str, bool]:
    return {k: False for k in keys}


def option_grid(keys: list[str]) -> list[dict[str, bool]]:
    """Defaults, everything on, everything off, and each option alone."""
    grids = [{}, all_on(keys), all_off(keys)]
    grids += [{**all_off(keys), k: True} for k in keys]
    return grids


def every(values: list[Any], n: int) -> list[Any]:
    return values[::n]


__all__ = ["col", "cont", "nom", "ordi", "analyze", "option_grid", "all_on", "all_off", "product", "every"]
