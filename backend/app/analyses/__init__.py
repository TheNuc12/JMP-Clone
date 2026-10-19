"""Analysis dispatch: picks the platform analysis from the request and modeling types."""

from __future__ import annotations

from ..schemas import AnalysisResult, AnalyzeRequest
from . import bivariate, capability, contingency, control_chart, distribution, fit_model, logistic, oneway


class AnalysisRequestError(ValueError):
    """The request is malformed (as opposed to the data being degenerate)."""


def run_analysis(req: AnalyzeRequest) -> AnalysisResult:
    y_cont = req.y.modeling_type == "continuous"
    if req.platform == "fit_model":
        return fit_model.analyze(req)
    if req.platform == "control_chart":
        return control_chart.analyze(req)
    if req.platform == "capability":
        return capability.analyze(req)
    if req.platform == "distribution":
        if y_cont:
            return distribution.continuous(req.y, req.options)
        return distribution.categorical(req.y, req.options)

    if req.x is None:
        raise AnalysisRequestError("Fit Y by X needs an X column.")
    if len(req.x.values) != len(req.y.values):
        raise AnalysisRequestError("X and Y must have the same number of values.")
    x_cont = req.x.modeling_type == "continuous"
    if y_cont and x_cont:
        return bivariate.analyze(req.y, req.x, req.options)
    if y_cont:
        return oneway.analyze(req.y, req.x, req.options)
    if x_cont:
        return logistic.analyze(req.y, req.x, req.options)
    return contingency.analyze(req.y, req.x, req.options)
