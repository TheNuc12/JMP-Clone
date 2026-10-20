"""Fit Model: standard least squares, stepwise and logistic models with several effects.

Effects are lists of factor names; a repeated name is a power (``["x", "x"]`` is x squared).
The design matrix follows JMP: an intercept, continuous factors (centered at their mean
inside crossed or polynomial effects), and effect-coded categorical factors (+1 at a level,
-1 at the last level, crossing multiplies codes). Columns that are linear combinations of
earlier columns are zeroed instead of failing the fit, as happens with aliased terms in
screening designs.
"""

from __future__ import annotations

import itertools
import math
import warnings
from dataclasses import dataclass, field

import numpy as np
import statsmodels.api as sm
from scipy import stats
from statsmodels.miscmodels.ordinal_model import OrderedModel

from .. import report as r
from ..schemas import (
    AnalysisColumn,
    AnalysisResult,
    AnalyzeRequest,
    Curve,
    IndexedScatterPlot,
    LinearModelSpec,
    ModelFactor,
    ModelTerm,
    ProfilerPlot,
    ReferenceLine,
    TermPart,
)
from .common import label_values, levels_of, numeric_values

OPTIONS = [
    ("effect_tests", "Effect Tests", True),
    ("lack_of_fit", "Lack of Fit", True),
    ("residual_plot", "Residual by Predicted Plot", True),
    ("profiler", "Prediction Profiler", True),
    ("sorted_estimates", "Sorted Parameter Estimates", False),
    ("lsmeans", "Least Squares Means", False),
]

# A column is dependent when its residual on earlier columns is this small relative to it.
SINGULAR_TOL = 1e-9


# ---------------------------------------------------------------------- design matrix


@dataclass
class Factor:
    name: str
    categorical: bool
    numbers: np.ndarray | None = None  # continuous values (used rows)
    labels: list[str] | None = None  # categorical labels (used rows)
    levels: list[str] = field(default_factory=list)

    @property
    def mean(self) -> float:
        return float(self.numbers.mean()) if self.numbers is not None and self.numbers.size else 0.0

    def part_values(self, part: TermPart) -> np.ndarray:
        """Values of one TermPart for every used row."""
        if not self.categorical:
            return (self.numbers - part.center) ** part.power
        last = self.levels[-1]
        return np.array([1.0 if v == part.level else -1.0 if v == last else 0.0 for v in self.labels])

    def spec(self) -> ModelFactor:
        if self.categorical:
            return ModelFactor(name=self.name, kind="categorical", levels=self.levels)
        return ModelFactor(
            name=self.name, kind="continuous", min=float(self.numbers.min()), max=float(self.numbers.max()), mean=self.mean
        )


@dataclass
class Term:
    label: str
    parts: list[TermPart]
    effect: int  # index into Design.effects


@dataclass
class Design:
    factors: dict[str, Factor]
    effects: list[list[str]]
    effect_names: list[str]
    terms: list[Term]  # excluding the intercept
    X: np.ndarray  # column 0 is the intercept, column j + 1 is terms[j]

    def effect_columns(self, effect: int) -> list[int]:
        return [j + 1 for j, t in enumerate(self.terms) if t.effect == effect]

    def term_label(self, col: int) -> str:
        return "Intercept" if col == 0 else self.terms[col - 1].label


def _center_label(name: str, center: float) -> str:
    if center == 0:
        return name
    sign = "-" if center > 0 else "+"
    return f"({name}{sign}{r.fmt_num(abs(center), 6)})"


def effect_name(effect: list[str]) -> str:
    return "*".join(effect)


def build_design(factors: dict[str, Factor], effects: list[list[str]], center_polynomials: bool, n: int) -> Design:
    """Expand effects into design-matrix terms (JMP's parameterization)."""
    terms: list[Term] = []
    for e, effect in enumerate(effects):
        counts: dict[str, int] = {}
        for name in effect:
            counts[name] = counts.get(name, 0) + 1
        crossed = len(effect) > 1
        # Each factor contributes one part (continuous) or one of L-1 coded parts (categorical).
        choices: list[list[TermPart]] = []
        for name, power in counts.items():
            f = factors[name]
            if f.categorical:
                choices.append([TermPart(factor=name, level=lev) for lev in f.levels[:-1]])
            else:
                center = f.mean if (crossed and center_polynomials) else 0.0
                choices.append([TermPart(factor=name, center=center, power=power)])
        for parts in itertools.product(*choices):
            labels = []
            for p in parts:
                if p.level is not None:
                    labels.append(f"{p.factor}[{p.level}]")
                else:
                    labels += [_center_label(p.factor, p.center)] * p.power
            terms.append(Term(label="*".join(labels), parts=list(parts), effect=e))
    X = np.ones((n, len(terms) + 1))
    for j, t in enumerate(terms):
        col = np.ones(n)
        for p in t.parts:
            col = col * factors[p.factor].part_values(p)
        X[:, j + 1] = col
    return Design(factors, effects, [effect_name(e) for e in effects], terms, X)


# ----------------------------------------------------------------------- least squares


@dataclass
class OLSFit:
    cols: list[int]  # columns of X used, in order
    kept: list[int]  # estimable columns (subset of cols)
    zeroed: dict[int, list[tuple[int, float]]]  # dependent column -> combination of kept columns
    beta: np.ndarray  # estimates for kept columns
    cov: np.ndarray  # covariance of beta (zeros when there is no error DF)
    pred: np.ndarray
    resid: np.ndarray
    sse: float
    dfe: int

    @property
    def mse(self) -> float:
        return self.sse / self.dfe if self.dfe > 0 else math.nan

    def estimate(self, col: int) -> float:
        return float(self.beta[self.kept.index(col)]) if col in self.kept else 0.0


def independent_columns(X: np.ndarray, cols: list[int]) -> tuple[list[int], dict[int, list[tuple[int, float]]]]:
    """Keep columns in order unless they are linear combinations of earlier kept ones."""
    kept: list[int] = []
    zeroed: dict[int, list[tuple[int, float]]] = {}
    for c in cols:
        v = X[:, c]
        norm = float(np.linalg.norm(v))
        if norm == 0:
            zeroed[c] = []
            continue
        if kept:
            K = X[:, kept]
            coef, *_ = np.linalg.lstsq(K, v, rcond=None)
            if np.linalg.norm(v - K @ coef) <= SINGULAR_TOL * norm * math.sqrt(len(v)):
                zeroed[c] = [(k, float(b)) for k, b in zip(kept, coef) if abs(b) > 1e-8]
                continue
        kept.append(c)
    return kept, zeroed


def exact_fit_zero(sse: float, y: np.ndarray) -> float:
    """An SSE at the level of floating point rounding means an exact fit: report it as 0.

    Otherwise the rounding residue of an exact fit (e.g. a constant response) turns into
    meaningless F and t ratios.
    """
    return 0.0 if sse <= (y.size * np.finfo(float).eps * float(np.linalg.norm(y))) ** 2 else sse


def ols(X: np.ndarray, y: np.ndarray, cols: list[int] | None = None) -> OLSFit:
    cols = list(range(X.shape[1])) if cols is None else cols
    kept, zeroed = independent_columns(X, cols)
    K = X[:, kept]
    beta, *_ = np.linalg.lstsq(K, y, rcond=None)
    pred = K @ beta
    resid = y - pred
    sse = exact_fit_zero(float(resid @ resid), y)
    dfe = y.size - len(kept)
    if dfe > 0:
        cov = (sse / dfe) * np.linalg.inv(K.T @ K)
    else:
        cov = np.zeros((len(kept), len(kept)))
    return OLSFit(cols, kept, zeroed, beta, cov, pred, resid, sse, dfe)


def sse_of(X: np.ndarray, y: np.ndarray, cols: list[int]) -> tuple[float, int]:
    """Residual sum of squares and number of estimable columns for a sub-model."""
    kept, _ = independent_columns(X, cols)
    if not kept:
        return float(y @ y), 0
    beta, *_ = np.linalg.lstsq(X[:, kept], y, rcond=None)
    resid = y - X[:, kept] @ beta
    return exact_fit_zero(float(resid @ resid), y), len(kept)


def _p_f(f: float, df1: int, df2: int) -> float | None:
    if not (math.isfinite(f) and df1 > 0 and df2 > 0):
        return None
    return float(stats.f.sf(f, df1, df2))


def _p_t(t: float, df: int) -> float | None:
    if not (math.isfinite(t) and df > 0):
        return None
    return float(2 * stats.t.sf(abs(t), df))


# ------------------------------------------------------------------------------ inputs


@dataclass
class Inputs:
    """Parsed request: used rows, response, factors and effects."""

    yname: str
    y_numbers: np.ndarray | None
    y_labels: list[str] | None
    factors: dict[str, Factor]
    effects: list[list[str]]
    used: np.ndarray  # positions in the request arrays
    n_missing: int


def parse_inputs(req: AnalyzeRequest) -> Inputs:
    from . import AnalysisRequestError  # imported late: the package imports this module

    columns: dict[str, AnalysisColumn] = {c.name: c for c in req.roles.get("factors", [])}
    raw_effects = req.params.get("effects") or []
    if not isinstance(raw_effects, list) or not all(isinstance(e, list) and e for e in raw_effects):
        raise AnalysisRequestError("params.effects must be a list of non-empty lists of factor names.")
    effects: list[list[str]] = []
    for effect in raw_effects:
        names = [str(n) for n in effect]
        unknown = [n for n in names if n not in columns]
        if unknown:
            raise AnalysisRequestError(f"Effect uses unknown factor(s): {', '.join(unknown)}.")
        # A categorical factor can appear once per effect; repeats only make sense as powers.
        dedup: list[str] = []
        for n in names:
            if columns[n].modeling_type != "continuous" and n in dedup:
                continue
            dedup.append(n)
        if dedup not in effects:
            effects.append(dedup)
    for c in columns.values():
        if len(c.values) != len(req.y.values):
            raise AnalysisRequestError("Every column must have the same number of values.")

    used_names = list(dict.fromkeys(n for e in effects for n in e))
    y_cont = req.y.modeling_type == "continuous"
    y_num = numeric_values(req.y) if y_cont else None
    y_lab = None if y_cont else label_values(req.y)
    ok = np.isfinite(y_num) if y_cont else np.array([v is not None for v in y_lab], dtype=bool)
    raw: dict[str, tuple[bool, object]] = {}
    for name in used_names:
        c = columns[name]
        if c.modeling_type == "continuous":
            vals = numeric_values(c)
            ok &= np.isfinite(vals)
            raw[name] = (False, vals)
        else:
            labs = label_values(c)
            ok &= np.array([v is not None for v in labs], dtype=bool)
            raw[name] = (True, labs)
    used = np.flatnonzero(ok)
    factors: dict[str, Factor] = {}
    for name in used_names:
        categorical, vals = raw[name]
        if categorical:
            labs = [vals[i] for i in used]  # type: ignore[index]
            factors[name] = Factor(name, True, labels=labs, levels=levels_of(labs, columns[name].levels))
        else:
            factors[name] = Factor(name, False, numbers=np.asarray(vals)[used])
    return Inputs(
        yname=req.y.name,
        y_numbers=None if y_num is None else y_num[used],
        y_labels=None if y_lab is None else [y_lab[i] for i in used],
        factors=factors,
        effects=effects,
        used=used,
        n_missing=len(req.y.values) - used.size,
    )


# ------------------------------------------------------------------------ entry point


def analyze(req: AnalyzeRequest) -> AnalysisResult:
    inputs = parse_inputs(req)
    center = bool(req.params.get("center_polynomials", True))
    if req.y.modeling_type != "continuous":
        return logistic_fit(inputs, req.y, center)
    opts, items = r.resolve_options(OPTIONS, req.options)
    if req.params.get("personality") == "stepwise":
        return stepwise_fit(inputs, opts, items, req.params, center)
    title = f"Response {inputs.yname}"
    children = least_squares_report(inputs, inputs.effects, opts, center)
    return AnalysisResult(analysis="fit_model_least_squares", title=title, options=items, nodes=[r.outline(title, children)])


def _missing_note(inputs: Inputs):
    if inputs.n_missing:
        return r.text(f"{inputs.n_missing} row(s) excluded for missing values.")
    return None


def _degenerate(inputs: Inputs, effects: list[list[str]]) -> str | None:
    n = inputs.used.size
    if not effects:
        return "Add at least one effect to the model."
    if n == 0:
        return "No rows have the response and every factor nonmissing."
    for f in inputs.factors.values():
        if f.categorical and len(f.levels) < 2:
            return f"{f.name} has fewer than 2 levels in the rows used; it cannot be an effect."
    return None


# ----------------------------------------------------------------- least squares report


def least_squares_report(inputs: Inputs, effects: list[list[str]], opts: dict[str, bool], center: bool) -> list:
    problem = _degenerate(inputs, effects)
    if problem:
        return [r.warning(problem), _missing_note(inputs)]
    factors = {n: inputs.factors[n] for n in dict.fromkeys(x for e in effects for x in e)}
    design = build_design(factors, effects, center, inputs.used.size)
    y = inputs.y_numbers
    X = design.X
    n = y.size
    fit = ols(X, y)
    sst = float(((y - y.mean()) ** 2).sum())
    df_model = len(fit.kept) - 1
    mse = fit.mse
    children: list = []

    if fit.dfe <= 0:
        children.append(r.warning("There are no degrees of freedom for error: the model has as many estimable parameters as rows. Tests are unavailable."))
    if sst == 0:
        children.append(r.warning(f"{inputs.yname} is constant in the rows used; RSquare is undefined."))
    if fit.zeroed:
        children.append(r.warning(_singularity_text(design, fit)))

    lo, hi = float(min(fit.pred.min(), y.min())), float(max(fit.pred.max(), y.max()))
    children.append(
        r.outline(
            "Actual by Predicted Plot",
            [
                r.plot(
                    IndexedScatterPlot(
                        x_label=f"{inputs.yname} Predicted",
                        y_label=f"{inputs.yname} Actual",
                        x=r.clean(fit.pred),
                        y=r.clean(y),
                        indices=[int(i) for i in inputs.used],
                        curves=[Curve(label="Actual = Predicted", x=[lo, hi], y=[lo, hi])],
                        hlines=[ReferenceLine(label="Mean", value=float(y.mean()))],
                    )
                )
            ],
        )
    )
    rsq = 1 - fit.sse / sst if sst > 0 else None
    rsq_adj = 1 - (fit.sse / fit.dfe) / (sst / (n - 1)) if sst > 0 and fit.dfe > 0 and n > 1 else None
    children.append(
        r.outline(
            "Summary of Fit",
            [
                r.summary(
                    [
                        ("RSquare", rsq),
                        ("RSquare Adj", rsq_adj),
                        ("Root Mean Square Error", math.sqrt(mse) if fit.dfe > 0 else None),
                        ("Mean of Response", float(y.mean())),
                        ("Observations (or Sum Wgts)", n, "integer"),
                    ]
                )
            ],
        )
    )
    ssm = sst - fit.sse
    f_model = (ssm / df_model) / mse if df_model > 0 and fit.dfe > 0 and mse > 0 else math.nan
    children.append(
        r.outline(
            "Analysis of Variance",
            [
                r.table(
                    [("Source", "text"), ("DF", "integer"), "Sum of Squares", "Mean Square", "F Ratio", ("Prob > F", "pvalue")],
                    [
                        ["Model", df_model, ssm, ssm / df_model if df_model > 0 else None, f_model, _p_f(f_model, df_model, fit.dfe)],
                        ["Error", fit.dfe, fit.sse, mse if fit.dfe > 0 else None, None, None],
                        ["C. Total", n - 1, sst, None, None, None],
                    ],
                )
            ],
        )
    )
    if opts["lack_of_fit"]:
        lof = _lack_of_fit(design, y, fit, sst)
        if lof is not None:
            children.append(lof)
    children.append(r.outline("Parameter Estimates", [_parameter_table(design, fit)]))
    if opts["sorted_estimates"]:
        children.append(_sorted_estimates(design, fit))
    if opts["effect_tests"]:
        children.append(_effect_tests(design, y, fit))
    if opts["lsmeans"]:
        children.extend(_ls_means(design, y, fit))
    if opts["residual_plot"]:
        children.append(
            r.outline(
                "Residual by Predicted Plot",
                [
                    r.plot(
                        IndexedScatterPlot(
                            x_label=f"{inputs.yname} Predicted",
                            y_label=f"{inputs.yname} Residual",
                            x=r.clean(fit.pred),
                            y=r.clean(fit.resid),
                            indices=[int(i) for i in inputs.used],
                            hlines=[ReferenceLine(label="0", value=0.0)],
                        )
                    )
                ],
            )
        )
    if opts["profiler"]:
        children.append(r.outline("Prediction Profiler", [r.plot(ProfilerPlot(model=model_spec(inputs.yname, design, fit)))]))
    children.append(_missing_note(inputs))
    return children


def _singularity_text(design: Design, fit: OLSFit) -> str:
    parts = []
    for col, combo in fit.zeroed.items():
        rhs = " + ".join(f"{r.fmt_num(b, 4)}*{design.term_label(k)}" if k else r.fmt_num(b, 4) for k, b in combo) or "0"
        parts.append(f"{design.term_label(col)} = {rhs}")
    return "Singularity details (these terms are zeroed): " + "; ".join(parts)


def _parameter_table(design: Design, fit: OLSFit):
    se = np.sqrt(np.clip(np.diag(fit.cov), 0, None)) if fit.dfe > 0 else np.full(len(fit.kept), np.nan)
    biased = {k for combo in fit.zeroed.values() for k, _ in combo}
    rows = []
    for col in range(design.X.shape[1]):
        label = design.term_label(col)
        if col in fit.zeroed:
            rows.append([f"{label} (Zeroed)", 0.0, None, None, None])
            continue
        i = fit.kept.index(col)
        b, s = float(fit.beta[i]), float(se[i])
        t = b / s if s > 0 else math.nan
        rows.append([f"{label} (Biased)" if col in biased else label, b, s, t, _p_t(t, fit.dfe)])
    return r.table([("Term", "text"), "Estimate", "Std Error", "t Ratio", ("Prob>|t|", "pvalue")], rows)


def _sorted_estimates(design: Design, fit: OLSFit):
    if fit.dfe <= 0:
        return r.outline("Sorted Parameter Estimates", [r.warning("No error degrees of freedom.")])
    se = np.sqrt(np.clip(np.diag(fit.cov), 0, None))
    rows = []
    for i, col in enumerate(fit.kept):
        if col == 0:
            continue
        t = float(fit.beta[i] / se[i]) if se[i] > 0 else math.nan
        rows.append([design.term_label(col), float(fit.beta[i]), float(se[i]), t, _p_t(t, fit.dfe)])
    rows.sort(key=lambda row: -abs(row[3]) if math.isfinite(row[3]) else 0)
    return r.outline(
        "Sorted Parameter Estimates",
        [r.table([("Term", "text"), "Estimate", "Std Error", "t Ratio", ("Prob>|t|", "pvalue")], rows)],
    )


def _effect_tests(design: Design, y: np.ndarray, fit: OLSFit):
    rows = []
    all_cols = list(range(design.X.shape[1]))
    for e, name in enumerate(design.effect_names):
        cols = design.effect_columns(e)
        df = sum(1 for c in cols if c in fit.kept)
        if df == 0:
            rows.append([name, len(cols), 0, None, None, None])
            continue
        sse_reduced, _ = sse_of(design.X, y, [c for c in all_cols if c not in cols])
        ss = max(sse_reduced - fit.sse, 0.0)
        f = (ss / df) / fit.mse if fit.dfe > 0 and fit.mse > 0 else math.nan
        rows.append([name, len(cols), df, ss, f, _p_f(f, df, fit.dfe)])
    return r.outline(
        "Effect Tests",
        [r.table([("Source", "text"), ("Nparm", "integer"), ("DF", "integer"), "Sum of Squares", "F Ratio", ("Prob > F", "pvalue")], rows)],
    )


def _lack_of_fit(design: Design, y: np.ndarray, fit: OLSFit, sst: float):
    """Pure error from replicated factor settings; None when nothing is replicated."""
    keys = []
    for i in range(y.size):
        key = []
        for f in design.factors.values():
            key.append(f.labels[i] if f.categorical else float(f.numbers[i]))
        keys.append(tuple(key))
    groups: dict[tuple, list[int]] = {}
    for i, k in enumerate(keys):
        groups.setdefault(k, []).append(i)
    df_pe = y.size - len(groups)
    if df_pe <= 0:
        return None
    ss_pe = float(sum(((y[idx] - y[idx].mean()) ** 2).sum() for idx in groups.values()))
    df_lof = fit.dfe - df_pe
    ss_lof = max(fit.sse - ss_pe, 0.0)
    ms_pe = ss_pe / df_pe
    ms_lof = ss_lof / df_lof if df_lof > 0 else None
    f = ms_lof / ms_pe if ms_lof is not None and ms_pe > 0 else math.nan
    rows = [
        ["Lack Of Fit", df_lof, ss_lof, ms_lof, f, _p_f(f, df_lof, df_pe)],
        ["Pure Error", df_pe, ss_pe, ms_pe, None, None],
        ["Total Error", fit.dfe, fit.sse, None, None, None],
    ]
    return r.outline(
        "Lack Of Fit",
        [
            r.table([("Source", "text"), ("DF", "integer"), "Sum of Squares", "Mean Square", "F Ratio", ("Prob > F", "pvalue")], rows),
            r.summary([("Max RSq", 1 - ss_pe / sst if sst > 0 else None)]),
        ],
    )


def _ls_means(design: Design, y: np.ndarray, fit: OLSFit) -> list:
    """LS means for categorical main effects: other factors at their means, codes averaged."""
    out = []
    for e, effect in enumerate(design.effects):
        if len(effect) != 1 or not design.factors[effect[0]].categorical:
            continue
        f = design.factors[effect[0]]
        rows = []
        for level in f.levels:
            x = np.ones(design.X.shape[1])
            for j, t in enumerate(design.terms):
                v = 1.0
                for p in t.parts:
                    pf = design.factors[p.factor]
                    if pf.categorical:
                        if p.factor != f.name:
                            v = 0.0  # effect codes average to zero over the levels
                        else:
                            v *= 1.0 if level == p.level else -1.0 if level == f.levels[-1] else 0.0
                    else:
                        v *= (pf.mean - p.center) ** p.power
                x[j + 1] = v
            xk = x[fit.kept]
            mean = float(xk @ fit.beta)
            se = math.sqrt(max(float(xk @ fit.cov @ xk), 0.0)) if fit.dfe > 0 else None
            raw = y[[i for i, lab in enumerate(f.labels) if lab == level]]
            rows.append([level, mean, se, float(raw.mean()) if raw.size else None])
        out.append(
            r.outline(
                f"Least Squares Means: {f.name}",
                [r.table([("Level", "text"), "Least Sq Mean", "Std Error", "Mean"], rows)],
            )
        )
    return out


def model_spec(yname: str, design: Design, fit: OLSFit) -> LinearModelSpec:
    """The fitted model in the form the frontend profiler and Save Columns evaluate."""
    terms = [ModelTerm(label=design.term_label(c), parts=[] if c == 0 else design.terms[c - 1].parts) for c in fit.kept]
    return LinearModelSpec(
        response=yname,
        factors=[f.spec() for f in design.factors.values()],
        terms=terms,
        coef=r.clean(fit.beta),
        cov=r.clean(np.nan_to_num(fit.cov)),
        df_error=max(fit.dfe, 0),
        rmse=math.sqrt(fit.mse) if fit.dfe > 0 else 0.0,
    )


# ------------------------------------------------------------------------------ stepwise


def _contains(outer: list[str], inner: list[str]) -> bool:
    """True when ``inner`` is a proper sub-multiset of ``outer`` (e.g. x in x*x, x in x*g)."""
    if len(inner) >= len(outer):
        return False
    rest = list(outer)
    for name in inner:
        if name not in rest:
            return False
        rest.remove(name)
    return True


def stepwise_fit(inputs: Inputs, opts: dict[str, bool], items, params: dict, center: bool) -> AnalysisResult:
    title = f"Stepwise Fit for {inputs.yname}"
    direction = params.get("direction", "mixed")
    if direction not in ("forward", "backward", "mixed"):
        direction = "mixed"
    p_enter = float(params.get("p_enter", 0.25))
    p_leave = float(params.get("p_leave", 0.1))
    settings = r.summary(
        [
            ("Direction", direction.capitalize(), "text"),
            ("Prob to Enter", p_enter),
            ("Prob to Leave", p_leave),
        ]
    )

    def done(children: list) -> AnalysisResult:
        return AnalysisResult(analysis="fit_model_stepwise", title=title, options=items, nodes=[r.outline(title, children)])

    problem = _degenerate(inputs, inputs.effects)
    if problem:
        return done([settings, r.warning(problem), _missing_note(inputs)])

    design = build_design(inputs.factors, inputs.effects, center, inputs.used.size)
    X, y = design.X, inputs.y_numbers
    n = y.size
    sst = float(((y - y.mean()) ** 2).sum())
    effects = design.effects
    E = len(effects)

    def cols_for(selected: set[int]) -> list[int]:
        return [0] + [c for e in sorted(selected) for c in design.effect_columns(e)]

    def fit_stats(selected: set[int]) -> tuple[float, int]:
        return sse_of(X, y, cols_for(selected))

    full_sse, full_p = fit_stats(set(range(E)))
    full_mse = full_sse / (n - full_p) if n - full_p > 0 else math.nan

    def partial_test(small: set[int], big: set[int]) -> tuple[float | None, float, int, float | None]:
        """p-value, SS, DF and F ratio for the effects in ``big`` but not ``small``."""
        sse0, p0 = fit_stats(small)
        sse1, p1 = fit_stats(big)
        df, dfe = p1 - p0, n - p1
        if df <= 0 or dfe <= 0:
            return None, 0.0, df, None
        ss = max(sse0 - sse1, 0.0)
        if sse1 <= 0:
            return 0.0, ss, df, None
        f = (ss / df) / (sse1 / dfe)
        return float(stats.f.sf(f, df, dfe)), ss, df, f

    def entry_test(selected: set[int], e: int):
        return partial_test(selected, selected | {e})

    def removal_test(selected: set[int], e: int):
        return partial_test(selected - {e}, selected)

    def can_enter(selected: set[int], e: int) -> bool:
        return all(i in selected for i in range(E) if _contains(effects[e], effects[i]))

    def can_leave(selected: set[int], e: int) -> bool:
        return not any(_contains(effects[i], effects[e]) for i in selected)

    def step_row(step: int, e: int, action: str, p: float | None, ss: float, selected: set[int]) -> list:
        sse, k = fit_stats(selected)
        cp = sse / full_mse - n + 2 * k if math.isfinite(full_mse) and full_mse > 0 else None
        return [step, design.effect_names[e], action, p, ss, 1 - sse / sst if sst > 0 else None, cp, k, _aicc(sse, n, k)]

    selected: set[int] = set(range(E)) if direction == "backward" else set()
    history: list[list] = []
    # In mixed mode an effect that is removed after entering may not enter again, so the
    # search cannot cycle between Prob to Enter and Prob to Leave.
    dropped: set[int] = set()
    for _ in range(2 * E + 1):
        moved = False
        if direction in ("forward", "mixed"):
            best = None
            for e in range(E):
                if e in selected or e in dropped or not can_enter(selected, e):
                    continue
                p, ss, _, _ = entry_test(selected, e)
                if p is not None and (best is None or p < best[1]):
                    best = (e, p, ss)
            if best and best[1] < p_enter:
                selected.add(best[0])
                history.append(step_row(len(history) + 1, best[0], "Entered", best[1], best[2], selected))
                moved = True
        if direction in ("backward", "mixed"):
            worst = None
            for e in selected:
                if not can_leave(selected, e):
                    continue
                p, ss, _, _ = removal_test(selected, e)
                if p is not None and (worst is None or p > worst[1]):
                    worst = (e, p, ss)
            if worst and worst[1] > p_leave:
                selected.discard(worst[0])
                dropped.add(worst[0])
                history.append(step_row(len(history) + 1, worst[0], "Removed", worst[1], worst[2], selected))
                moved = True
        if not moved:
            break

    final = ols(X, y, cols_for(selected))
    current = [["Intercept", "Yes", final.estimate(0), 1, None, None, None]]
    for e in range(E):
        cols = design.effect_columns(e)
        entered = e in selected
        p, ss, _, f = removal_test(selected, e) if entered else entry_test(selected, e)
        estimate = final.estimate(cols[0]) if entered and len(cols) == 1 else None
        current.append([design.effect_names[e], "Yes" if entered else "No", estimate, len(cols), ss, f, p])

    children = [
        settings,
        r.outline(
            "Current Estimates",
            [
                r.table(
                    [("Parameter", "text"), ("Entered", "text"), "Estimate", ("nDF", "integer"), "SS", "F Ratio", ("Prob>F", "pvalue")],
                    current,
                )
            ],
        ),
        r.outline(
            "Step History",
            [
                r.table(
                    [("Step", "integer"), ("Parameter", "text"), ("Action", "text"), ("Sig Prob", "pvalue"), "Seq SS", "RSquare", "Cp", ("p", "integer"), "AICc"],
                    history,
                )
                if history
                else r.text("No effect met the entry or removal criteria.")
            ],
        ),
    ]
    final_effects = [effects[e] for e in sorted(selected)]
    final_title = f"Response {inputs.yname}"
    if final_effects:
        children.append(r.outline(f"{final_title} (final model)", least_squares_report(inputs, final_effects, opts, center)))
    else:
        children.append(r.warning("No effects entered the model."))
    return done(children)


def _aicc(sse: float, n: int, k: int) -> float | None:
    """AICc for a least squares fit with k mean parameters (plus the error variance)."""
    kk = k + 1
    if sse <= 0 or n - kk - 1 <= 0:
        return None
    neg2ll = n * math.log(2 * math.pi * sse / n) + n
    return neg2ll + 2 * kk + 2 * kk * (kk + 1) / (n - kk - 1)


# ------------------------------------------------------------------------------ logistic


@dataclass
class LogitFit:
    neg_llf: float
    n_params: int
    tables: list  # (title, rows) parameter tables
    unstable: bool


def _fit_logit(X: np.ndarray, y_idx: np.ndarray, levels: list[str], ordinal: bool, labels: list[str]) -> LogitFit:
    """Fit binary, nominal or ordinal logistic regression on design columns X (col 0 = intercept)."""
    L = len(levels)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        if L == 2:
            res = sm.Logit((y_idx == 0).astype(float), X).fit(disp=0, maxiter=300)
            est, se = np.asarray(res.params), np.asarray(res.bse)
            tables = [(f"For log odds of {levels[0]}/{levels[1]}", list(zip(labels, est, se)))]
            k = X.shape[1]
        elif ordinal:
            model = OrderedModel(y_idx, X[:, 1:], distr="logit")
            res = model.fit(method="bfgs", disp=0, maxiter=2000)
            p = np.asarray(res.params)
            cov = np.asarray(res.cov_params())
            m = X.shape[1] - 1
            thresholds = np.asarray(model.transform_threshold_params(p))[1:-1]
            jac = np.zeros((L - 1, len(p)))
            jac[:, m] = 1.0
            for kk in range(1, L - 1):
                for i in range(1, kk + 1):
                    jac[kk, m + i] = math.exp(p[m + i])
            thr_se = np.sqrt(np.clip(np.diag(jac @ cov @ jac.T), 0, None))
            slope_se = np.sqrt(np.clip(np.diag(cov)[:m], 0, None))
            rows = [(f"Intercept[{levels[kk]}]", thresholds[kk], thr_se[kk]) for kk in range(L - 1)]
            rows += list(zip(labels[1:], -p[:m], slope_se))  # JMP: logit P(Y <= k) = a_k + X b
            tables = [("Cumulative logit: log odds of P(Y <= level)", rows)]
            k = L - 1 + m
        else:
            codes = np.where(y_idx == L - 1, 0, y_idx + 1)  # statsmodels' reference is code 0
            res = sm.MNLogit(codes, X).fit(disp=0, maxiter=300)
            params, bse = np.asarray(res.params), np.asarray(res.bse)
            tables = [(f"For log odds of {levels[c]}/{levels[-1]}", list(zip(labels, params[:, c], bse[:, c]))) for c in range(L - 1)]
            k = X.shape[1] * (L - 1)
    estimates = np.array([row[1] for _, rows in tables for row in rows], dtype=float)
    errors = np.array([row[2] for _, rows in tables for row in rows], dtype=float)
    neg_llf = -float(res.llf)
    unstable = (
        any(type(w.message).__name__ in {"PerfectSeparationWarning", "ConvergenceWarning", "HessianInversionWarning"} for w in caught)
        or neg_llf < 1e-6
        or not np.all(np.isfinite(errors))
        or bool(np.any(errors > 100 * (np.abs(estimates) + 1)))
    )
    return LogitFit(neg_llf, k, tables, unstable)


def logistic_fit(inputs: Inputs, y_col: AnalysisColumn, center: bool) -> AnalysisResult:
    labels_y = inputs.y_labels
    levels = levels_of(labels_y, y_col.levels)
    L = len(levels)
    ordinal = y_col.modeling_type == "ordinal" and L > 2
    kind = "Ordinal" if ordinal else "Nominal"
    title = f"{kind} Logistic Fit for {inputs.yname}"

    def done(children: list) -> AnalysisResult:
        children.append(_missing_note(inputs))
        return AnalysisResult(analysis="fit_model_logistic", title=title, options=[], nodes=[r.outline(title, children)])

    problem = _degenerate(inputs, inputs.effects)
    if problem:
        return done([r.warning(problem)])
    if L < 2:
        return done([r.warning(f"{inputs.yname} needs at least 2 levels with data for a logistic fit.")])

    design = build_design(inputs.factors, inputs.effects, center, inputs.used.size)
    kept, zeroed = independent_columns(design.X, list(range(design.X.shape[1])))
    X = design.X[:, kept]
    n = X.shape[0]
    index = {lev: i for i, lev in enumerate(levels)}
    y_idx = np.array([index[v] for v in labels_y])
    term_labels = [design.term_label(c) for c in kept]

    children: list = []
    if zeroed:
        children.append(r.warning("Linearly dependent terms were dropped: " + ", ".join(design.term_label(c) for c in zeroed)))
    if n <= len(kept):
        return done(children + [r.warning("There are not enough rows to fit this logistic model.")])
    try:
        fit = _fit_logit(X, y_idx, levels, ordinal, term_labels)
    except Exception as exc:  # singular Hessians, separation, ...
        return done(children + [r.warning(f"The logistic model could not be fit: {exc}")])

    counts = np.bincount(y_idx, minlength=L)
    counts = counts[counts > 0]
    reduced = -float((counts * np.log(counts / n)).sum())
    full = fit.neg_llf
    diff = reduced - full
    df = fit.n_params - (L - 1)
    chisq = 2 * diff
    k = fit.n_params
    aicc = 2 * full + 2 * k + (2 * k * (k + 1) / (n - k - 1) if n - k - 1 > 0 else math.nan)
    bic = 2 * full + k * math.log(n)

    if fit.unstable:
        children.append(
            r.warning("Unstable fit: the model did not converge cleanly (possibly quasi-complete separation). Estimates may be unreliable.")
        )
    children.append(
        r.outline(
            "Whole Model Test",
            [
                r.table(
                    [("Model", "text"), "-LogLikelihood", ("DF", "integer"), "ChiSquare", ("Prob>ChiSq", "pvalue")],
                    [
                        ["Difference", diff, df, chisq, float(stats.chi2.sf(chisq, df)) if df > 0 else None],
                        ["Full", full, None, None, None],
                        ["Reduced", reduced, None, None, None],
                    ],
                ),
                r.summary(
                    [
                        ("RSquare (U)", diff / reduced if reduced > 0 else None),
                        ("AICc", aicc),
                        ("BIC", bic),
                        ("Observations (or Sum Wgts)", n, "integer"),
                    ]
                ),
            ],
        )
    )
    tables = []
    for table_title, rows in fit.tables:
        out = []
        for term, est, se in rows:
            wald = (est / se) ** 2 if se and math.isfinite(se) and se > 0 else math.nan
            out.append([term, est, se, wald, float(stats.chi2.sf(wald, 1)) if math.isfinite(wald) else None])
        tables.append(r.table([("Term", "text"), "Estimate", "Std Error", "ChiSquare", ("Prob>ChiSq", "pvalue")], out, title=table_title))
    children.append(r.outline("Parameter Estimates", tables))

    lr_rows = []
    for e, name in enumerate(design.effect_names):
        cols = [c for c in design.effect_columns(e) if c in kept]
        if not cols:
            lr_rows.append([name, len(design.effect_columns(e)), 0, None, None])
            continue
        sub = [c for c in kept if c not in cols]
        try:
            reduced_fit = _fit_logit(design.X[:, sub], y_idx, levels, ordinal, [design.term_label(c) for c in sub])
            lr = max(2 * (reduced_fit.neg_llf - full), 0.0)
            ddf = fit.n_params - reduced_fit.n_params
            lr_rows.append([name, len(design.effect_columns(e)), ddf, lr, float(stats.chi2.sf(lr, ddf)) if ddf > 0 else None])
        except Exception:
            lr_rows.append([name, len(design.effect_columns(e)), None, None, None])
    children.append(
        r.outline(
            "Effect Likelihood Ratio Tests",
            [r.table([("Source", "text"), ("Nparm", "integer"), ("DF", "integer"), "L-R ChiSquare", ("Prob>ChiSq", "pvalue")], lr_rows)],
        )
    )
    return done(children)
