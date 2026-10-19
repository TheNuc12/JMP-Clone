"""Parse uploaded files and data frames into DataTablePayload."""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import pandas as pd
from pandas.api import types as ptypes

from .schemas import ColumnData, DataTablePayload, ModelingType

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
TEXT_EXTENSIONS = {".csv", ".tsv", ".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xlsm"}
NA_VALUES = ["."]  # JMP-style missing value marker, in addition to pandas defaults


class UploadError(ValueError):
    """The uploaded file cannot be parsed."""


def parse_upload(filename: str, content: bytes) -> DataTablePayload:
    path = Path(filename or "data")
    ext = path.suffix.lower()
    if len(content) > MAX_UPLOAD_BYTES:
        raise UploadError(f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    if not content:
        raise UploadError("File is empty.")

    if ext in TEXT_EXTENSIONS:
        df = _read_text(content, ext)
    elif ext in EXCEL_EXTENSIONS:
        try:
            df = pd.read_excel(io.BytesIO(content), sheet_name=0, engine="openpyxl", na_values=NA_VALUES)
        except Exception as exc:
            raise UploadError(f"Could not read Excel file: {exc}") from exc
    elif ext == ".xls":
        raise UploadError("Legacy .xls files are not supported; save the sheet as .xlsx or CSV.")
    else:
        raise UploadError(f"Unsupported file type '{ext or path.name}'. Use CSV, TSV, TXT or XLSX.")

    if df.shape[1] == 0:
        raise UploadError("No columns found in file.")
    return dataframe_to_payload(path.stem or "data", df)


def _read_text(content: bytes, ext: str) -> pd.DataFrame:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    kwargs: dict[str, Any] = {"na_values": NA_VALUES}
    if ext == ".tsv":
        kwargs["sep"] = "\t"
    elif ext == ".txt":
        kwargs.update(sep=None, engine="python")
    try:
        return pd.read_csv(io.StringIO(text), **kwargs)
    except Exception as exc:
        raise UploadError(f"Could not parse file: {exc}") from exc


def dataframe_to_payload(
    name: str,
    df: pd.DataFrame,
    modeling_overrides: Mapping[str, ModelingType] | None = None,
) -> DataTablePayload:
    """Convert a data frame to the wire format, inferring data and modeling types."""
    overrides = modeling_overrides or {}
    columns = []
    for raw_name in df.columns:
        col_name = str(raw_name)
        series = df[raw_name]
        if ptypes.is_bool_dtype(series):
            column = _character(col_name, series)
        elif ptypes.is_numeric_dtype(series):
            column = _numeric(col_name, series)
        elif ptypes.is_datetime64_any_dtype(series):
            column = _character(col_name, _datetime_strings(series))
        else:
            column = _character(col_name, series)
        if col_name in overrides:
            column.modeling_type = overrides[col_name]
        columns.append(column)
    return DataTablePayload(name=name, n_rows=int(len(df)), columns=columns)


def _numeric(name: str, series: pd.Series) -> ColumnData:
    arr = series.astype("float64").to_numpy()
    finite = np.isfinite(arr)
    all_int = bool(np.all(np.mod(arr[finite], 1) == 0)) if finite.any() else False
    values: list[float | int | None] = []
    for v, ok in zip(arr.tolist(), finite.tolist()):
        if not ok:
            values.append(None)
        elif all_int and abs(v) < 2**53:
            values.append(int(v))
        else:
            values.append(float(v))
    return ColumnData(name=name, data_type="numeric", modeling_type="continuous", values=values)


def _character(name: str, series: pd.Series) -> ColumnData:
    values: list[str | None] = []
    for v in series.tolist():
        if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA or v is pd.NaT:
            values.append(None)
            continue
        if isinstance(v, (bool, np.bool_)):
            label = "True" if v else "False"
        elif isinstance(v, float) and v.is_integer():
            label = str(int(v))
        elif isinstance(v, pd.Timestamp):
            label = v.isoformat()
        else:
            label = str(v).strip()
        values.append(label if label != "" else None)
    return ColumnData(name=name, data_type="character", modeling_type="nominal", values=values)


def _datetime_strings(series: pd.Series) -> pd.Series:
    valid = series.dropna()
    date_only = bool(len(valid)) and bool((valid == valid.dt.normalize()).all())
    fmt = "%Y-%m-%d" if date_only else "%Y-%m-%dT%H:%M:%S"
    return series.dt.strftime(fmt).astype(object).where(series.notna(), None)
