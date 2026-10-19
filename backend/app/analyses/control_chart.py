"""Control charts: I-MR, Xbar-R, Xbar-S, P, NP, C and U, with Nelson tests."""

from __future__ import annotations

from .. import report as r
from ..schemas import AnalysisResult, AnalyzeRequest


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    return AnalysisResult(
        analysis="control_chart",
        title="Control Chart",
        options=[],
        nodes=[r.warning("Control Chart is not implemented yet.")],
    )
