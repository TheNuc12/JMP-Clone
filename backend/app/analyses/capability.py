"""Process capability: Cp, Cpk, Pp, Ppk and nonconformance against spec limits."""

from __future__ import annotations

from .. import report as r
from ..schemas import AnalysisResult, AnalyzeRequest


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    return AnalysisResult(
        analysis="capability",
        title="Process Capability",
        options=[],
        nodes=[r.warning("Process Capability is not implemented yet.")],
    )
