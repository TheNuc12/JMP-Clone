"""Helpers for building report nodes and sanitising numbers for JSON."""

from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

import numpy as np

from .schemas import (
    CellFormat,
    OptionItem,
    OutlineNode,
    PlotNode,
    RowNode,
    SummaryItem,
    SummaryNode,
    TableColumn,
    TableNode,
    TextNode,
)


def clean(value: Any) -> Any:
    """Recursively convert numpy scalars/arrays to Python types and NaN/inf to None."""
    if value is None:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, np.ndarray):
        return [clean(v) for v in value.tolist()]
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def outline(title: str, children: Iterable[Any], closed: bool = False) -> OutlineNode:
    return OutlineNode(title=title, children=[c for c in children if c is not None], closed=closed)


def row(*children: Any) -> RowNode:
    return RowNode(children=[c for c in children if c is not None])


def table(
    columns: Sequence[tuple[str, CellFormat] | str],
    rows: Iterable[Sequence[Any]],
    title: str | None = None,
) -> TableNode:
    """Build a table. Columns are names or (name, format) pairs; default format is number."""
    cols = [
        TableColumn(name=c) if isinstance(c, str) else TableColumn(name=c[0], format=c[1])
        for c in columns
    ]
    return TableNode(title=title, columns=cols, rows=[clean(list(r)) for r in rows])


def summary(
    items: Iterable[tuple[str, Any] | tuple[str, Any, CellFormat]],
    title: str | None = None,
) -> SummaryNode:
    """Build a label/value summary from (label, value[, format]) tuples."""
    out = []
    for item in items:
        if len(item) == 3:
            label, value, fmt = item  # type: ignore[misc]
        else:
            label, value = item  # type: ignore[misc]
            fmt = "number"
        out.append(SummaryItem(label=label, value=clean(value), format=fmt))
    return SummaryNode(title=title, items=out)


def text(message: str, tone: str = "info") -> TextNode:
    return TextNode(text=message, tone=tone)  # type: ignore[arg-type]


def warning(message: str) -> TextNode:
    return TextNode(text=message, tone="warning")


def plot(spec: Any) -> PlotNode:
    return PlotNode(plot=spec)


def resolve_options(
    defaults: Sequence[tuple[str, str, bool]],
    requested: dict[str, bool],
    disabled: Iterable[str] = (),
) -> tuple[dict[str, bool], list[OptionItem]]:
    """Merge requested option values over defaults.

    ``defaults`` is a list of (key, label, default). Disabled options are reported with
    ``enabled=False`` and always evaluate to False.
    """
    disabled = set(disabled)
    values: dict[str, bool] = {}
    items: list[OptionItem] = []
    for key, label, default in defaults:
        value = bool(requested.get(key, default))
        enabled = key not in disabled
        values[key] = value and enabled
        items.append(OptionItem(key=key, label=label, value=value, enabled=enabled))
    return values, items


def fmt_num(x: float, sig: int = 5) -> str:
    """Format a number with ``sig`` significant digits for equations and labels."""
    if x is None or not math.isfinite(x):
        return "."
    if x == 0:
        return "0"
    s = f"{x:.{sig}g}"
    if "e" in s:
        return s
    return s
