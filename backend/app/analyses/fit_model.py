"""Fit Model: standard least squares, stepwise and logistic models with several effects."""

from __future__ import annotations

from .. import report as r
from ..schemas import AnalysisResult, AnalyzeRequest


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    return AnalysisResult(
        analysis="fit_model_least_squares",
        title="Fit Model",
        options=[],
        nodes=[r.warning("Fit Model is not implemented yet.")],
    )
