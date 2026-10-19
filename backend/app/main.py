"""Sift API: sample data, file upload and statistical analyses."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .analyses import AnalysisRequestError, run_analysis
from .doe import DoeError, make_design
from .io import MAX_UPLOAD_BYTES, UploadError, parse_upload
from .samples import SAMPLES, get_sample, list_samples
from .schemas import AnalysisResult, AnalyzeRequest, DataTablePayload, DoeRequest, DoeResult, SampleInfo

logger = logging.getLogger("sift")

app = FastAPI(title="Sift API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/samples", response_model=list[SampleInfo])
def samples() -> list[SampleInfo]:
    return list_samples()


@app.get("/api/samples/{sample_id}", response_model=DataTablePayload)
def sample(sample_id: str) -> DataTablePayload:
    if sample_id not in SAMPLES:
        raise HTTPException(status_code=404, detail=f"Unknown sample '{sample_id}'.")
    return get_sample(sample_id)


@app.post("/api/upload", response_model=DataTablePayload)
async def upload(file: UploadFile = File(...)) -> DataTablePayload:
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        return parse_upload(file.filename or "data", content)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/analyze", response_model=AnalysisResult)
def analyze(req: AnalyzeRequest) -> AnalysisResult:
    try:
        return run_analysis(req)
    except AnalysisRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - safety net, analyses handle bad data themselves
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


@app.post("/api/doe", response_model=DoeResult)
def doe(req: DoeRequest) -> DoeResult:
    try:
        return make_design(req)
    except DoeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Serve the built frontend (single-process deployment). Must come after the API routes.
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
