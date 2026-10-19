"""Design of experiments: full factorial, fractional factorial, response surface and custom designs.

Conventions:

* Continuous factors are coded -1/+1 at their low/high settings; table values are decoded
  back to the factor's units.
* Replicates repeat the design's non-center runs; center points (all continuous factors
  at their midpoint, categorical factors cycling through their levels) are added once.
* The Pattern column uses '-' / '+' for low / high, '0' for center, 'a' / 'A' for axial
  low / high, and 1-9, A-Z for categorical levels.
"""

from __future__ import annotations

import math

import numpy as np

from . import doe_designs as d
from . import report as r
from .schemas import (
    ColumnData,
    DataTablePayload,
    DoeRequest,
    DoeResult,
    ReportNode,
    SavedModel,
)

MAX_RUNS = 5000
MAX_FULL_FACTORIAL_FACTORS = 12
MAX_CUSTOM_RUNS = 1000

DESIGN_NAMES = {
    "full_factorial": "Full Factorial",
    "fractional_factorial": "Screening",
    "response_surface": "Response Surface",
    "custom": "Custom Design",
}


class DoeError(ValueError):
    """The design request cannot be satisfied (bad factors, too few runs, ...)."""


# ----------------------------------------------------------------------- validation


def _factors(req: DoeRequest) -> list[d.Factor]:
    if not req.factors:
        raise DoeError("Add at least one factor.")
    factors: list[d.Factor] = []
    seen: set[str] = set()
    for f in req.factors:
        name = f.name.strip()
        if not name:
            raise DoeError("Every factor needs a name.")
        if name.lower() in seen:
            raise DoeError(f"Factor names must be unique ('{name}' is used twice).")
        if name.lower() == "pattern":
            raise DoeError("'Pattern' is reserved for the pattern column; rename the factor.")
        seen.add(name.lower())
        if f.kind == "continuous":
            low = -1.0 if f.low is None else float(f.low)
            high = 1.0 if f.high is None else float(f.high)
            if not (math.isfinite(low) and math.isfinite(high)) or low >= high:
                raise DoeError(f"Factor '{name}': the low setting must be below the high setting.")
            factors.append(d.Factor(name, "continuous", low, high))
        else:
            levels = [lv.strip() for lv in (f.levels or []) if lv.strip()]
            if len(set(levels)) != len(levels):
                raise DoeError(f"Factor '{name}' lists the same level twice.")
            if len(levels) < 2:
                raise DoeError(f"Categorical factor '{name}' needs at least 2 levels.")
            factors.append(d.Factor(name, "categorical", levels=tuple(levels)))
    return factors


def _responses(req: DoeRequest, factor_names: set[str]) -> list[str]:
    names = [resp.name.strip() for resp in req.responses]
    if not names:
        raise DoeError("Add at least one response.")
    seen: set[str] = set()
    for name in names:
        if not name:
            raise DoeError("Every response needs a name.")
        if name.lower() in seen or name.lower() in factor_names or name.lower() == "pattern":
            raise DoeError(f"Response name '{name}' is already used.")
        seen.add(name.lower())
    return names


def _effects(model: list[list[str]] | None, factors: list[d.Factor]) -> list[d.Effect]:
    """Model effects as factor-index tuples; defaults to main effects."""
    if not model:
        return [(i,) for i in range(len(factors))]
    index = {f.name.lower(): i for i, f in enumerate(factors)}
    effects: list[d.Effect] = []
    for effect in model:
        if not effect:
            continue
        try:
            term = tuple(sorted(index[name.strip().lower()] for name in effect))
        except KeyError as exc:
            raise DoeError(f"The model uses an unknown factor {exc.args[0]!r}.") from None
        for i in set(term):
            if term.count(i) > 1 and not factors[i].continuous:
                raise DoeError(f"Categorical factor '{factors[i].name}' can't appear twice in one effect.")
            if term.count(i) > 2:
                raise DoeError("Model effects can use a factor at most twice (quadratic).")
        if term not in effects:
            effects.append(term)
    # Keep a conventional order: by degree, then factor order.
    return sorted(effects, key=lambda e: (len(e), e))


def _two_factor_effects(k: int) -> list[d.Effect]:
    return [(i, j) for i in range(k) for j in range(i + 1, k)]


# ----------------------------------------------------------------------- designs


def _check_runs(n: int) -> None:
    if n > MAX_RUNS:
        raise DoeError(f"The design would have {n} runs; the limit is {MAX_RUNS}.")


def _with_replicates(base: d.Runs, centers: d.Runs, replicates: int) -> d.Runs:
    runs = base.repeat(replicates + 1).extend(centers)
    _check_runs(len(runs))
    return runs


def _full_factorial(req: DoeRequest, factors: list[d.Factor]):
    if len(factors) > MAX_FULL_FACTORIAL_FACTORS:
        raise DoeError(f"Full factorial designs support up to {MAX_FULL_FACTORIAL_FACTORS} factors; try a screening design.")
    size = math.prod(f.n_levels for f in factors)
    _check_runs(size * (req.replicates + 1) + req.center_points)
    cube = d.full_factorial(factors)
    if req.center_points and not any(f.continuous for f in factors):
        raise DoeError("Center points need at least one continuous factor.")
    centers = d.center_points(factors, req.center_points)
    k = len(factors)
    effects = [(i,) for i in range(k)] + _two_factor_effects(k)
    info = [("Design", "Full factorial", "text")]
    return _with_replicates(cube, centers, req.replicates), effects, info, []


def _fractional(req: DoeRequest, factors: list[d.Factor]):
    k = len(factors)
    if k < 2:
        raise DoeError("Screening designs need at least 2 factors.")
    if k > d.MAX_FRACTIONAL_FACTORS:
        raise DoeError(f"Screening designs support up to {d.MAX_FRACTIONAL_FACTORS} factors.")
    for f in factors:
        if f.n_levels != 2:
            raise DoeError(f"Screening designs use 2-level factors; '{f.name}' has {f.n_levels} levels.")
    if req.resolution is not None and req.resolution not in (3, 4, 5):
        raise DoeError("Resolution must be III, IV or V.")
    try:
        fraction = d.choose_fraction(k, req.resolution)
    except ValueError as exc:
        raise DoeError(str(exc)) from None
    if req.center_points and not any(f.continuous for f in factors):
        raise DoeError("Center points need at least one continuous factor.")
    cube = d.fraction_runs(fraction, factors)
    centers = d.center_points(factors, req.center_points)
    names = [f.name for f in factors]
    effects: list[d.Effect] = [(i,) for i in range(k)]
    full = not fraction.generators
    if full or fraction.resolution >= 5:
        effects += _two_factor_effects(k)
    info = [
        ("Design", "Full factorial" if full else f"2^({k}-{len(fraction.generators)}) fractional factorial", "text"),
        ("Resolution", "Full" if full else d.roman(fraction.resolution), "text"),
    ]
    extra: list[ReportNode] = []
    if not full:
        extra.append(r.outline("Design Generators", [r.text(line, "equation") for line in d.generator_text(fraction, names)]))
        extra.append(
            r.outline(
                "Alias Structure",
                [
                    r.table([("Effect", "text"), ("Aliases (up to two-factor interactions)", "text")], [(e, a or "—") for e, a in d.alias_structure(fraction, names)]),
                    r.text("Higher-order interactions are assumed negligible."),
                ],
            )
        )
    return _with_replicates(cube, centers, req.replicates), effects, info, extra


def _response_surface(req: DoeRequest, factors: list[d.Factor]):
    k = len(factors)
    if any(not f.continuous for f in factors):
        raise DoeError("Response surface designs use continuous factors only.")
    effects: list[d.Effect] = [(i,) for i in range(k)] + _two_factor_effects(k) + [(i, i) for i in range(k)]
    if req.rsm_type == "box_behnken":
        if k not in d.BBD_FACTORS:
            raise DoeError("Box-Behnken designs support 3 to 7 factors.")
        base = d.box_behnken(factors)
        centers = d.center_points(factors, req.center_points)
        info = [("Design", "Box-Behnken", "text")]
        return _with_replicates(base, centers, req.replicates), effects, info, []
    if not 2 <= k <= d.MAX_CCD_FACTORS:
        raise DoeError(f"Central composite designs support 2 to {d.MAX_CCD_FACTORS} factors.")
    base, centers, alpha, cube = d.ccd(factors, req.ccd_alpha, req.center_points)
    label = {"rotatable": "rotatable", "orthogonal": "orthogonal", "face_centered": "face-centered"}[req.ccd_alpha]
    info = [
        ("Design", f"Central composite ({label})", "text"),
        ("Axial value (alpha)", round(alpha, 4)),
        ("Cube runs", cube.runs, "integer"),
    ]
    return _with_replicates(base, centers, req.replicates), effects, info, []


def _custom(req: DoeRequest, factors: list[d.Factor], rng: np.random.Generator):
    effects = _effects(req.model, factors)
    p = d.n_parameters(factors, effects)
    n_runs = req.n_runs if req.n_runs is not None else p + 4
    if n_runs < p:
        raise DoeError(f"The model has {p} parameters, so the design needs at least {p} runs.")
    if n_runs > MAX_CUSTOM_RUNS:
        raise DoeError(f"Custom designs support up to {MAX_CUSTOM_RUNS} runs.")
    if req.center_points and not any(f.continuous for f in factors):
        raise DoeError("Center points need at least one continuous factor.")
    coded = d.coordinate_exchange(factors, effects, n_runs, rng)
    base = d.make_runs(coded, factors)
    centers = d.center_points(factors, req.center_points)
    info = [("Design", "D-optimal (coordinate exchange)", "text"), ("Model parameters", p, "integer")]
    extra: list[ReportNode] = []
    labels, corr = d.correlations(coded, factors, effects)
    if 1 < len(labels) <= 24:
        extra.append(
            r.outline(
                "Correlations of Model Terms",
                [r.table([("Term", "text")] + [(lb, "number") for lb in labels], [[lb, *row] for lb, row in zip(labels, corr)])],
                closed=True,
            )
        )
    return _with_replicates(base, centers, req.replicates), effects, info, extra


# ------------------------------------------------------------------------- output


def _decimals(f: d.Factor) -> int:
    return max(0, 4 - math.floor(math.log10(f.high - f.low)))


def _decode(runs: d.Runs, factors: list[d.Factor]) -> list[list[float | str]]:
    """Factor columns in the factors' own units (or level names)."""
    cols: list[list[float | str]] = []
    for j, f in enumerate(factors):
        coded = runs.coded[:, j]
        if f.continuous:
            mid, half = (f.high + f.low) / 2, (f.high - f.low) / 2
            digits = _decimals(f)
            cols.append([float(round(mid + c * half, digits)) for c in coded])
        else:
            cols.append([f.levels[int(c)] for c in coded])
    return cols


def _table(name: str, runs: d.Runs, factors: list[d.Factor], responses: list[str], effects: list[d.Effect]) -> DataTablePayload:
    n = len(runs)
    columns = [ColumnData(name="Pattern", data_type="character", modeling_type="nominal", values=list(runs.patterns))]
    for f, values in zip(factors, _decode(runs, factors)):
        if f.continuous:
            columns.append(ColumnData(name=f.name, data_type="numeric", modeling_type="continuous", values=values))
        else:
            columns.append(
                ColumnData(name=f.name, data_type="character", modeling_type="nominal", values=values, value_order=list(f.levels))
            )
    for resp in responses:
        columns.append(ColumnData(name=resp, data_type="numeric", modeling_type="continuous", values=[None] * n))
    model = SavedModel(responses=responses, effects=[[factors[i].name for i in e] for e in effects])
    return DataTablePayload(name=name, n_rows=n, columns=columns, model=model)


def _factor_table(factors: list[d.Factor]) -> ReportNode:
    rows = []
    for f in factors:
        if f.continuous:
            rows.append((f.name, "Continuous", f"{r.fmt_num(f.low, 6)} to {r.fmt_num(f.high, 6)}"))
        else:
            rows.append((f.name, "Categorical", ", ".join(f.levels)))
    return r.outline("Factors", [r.table([("Factor", "text"), ("Type", "text"), ("Values", "text")], rows)])


def make_design(req: DoeRequest) -> DoeResult:
    factors = _factors(req)
    responses = _responses(req, {f.name.lower() for f in factors})
    if not 0 <= req.replicates <= 20:
        raise DoeError("Replicates must be between 0 and 20.")
    if not 0 <= req.center_points <= 100:
        raise DoeError("Center points must be between 0 and 100.")
    seed_seq = np.random.SeedSequence(req.seed)
    design_rng, order_rng = (np.random.default_rng(s) for s in seed_seq.spawn(2))

    if req.design == "full_factorial":
        runs, effects, info, extra = _full_factorial(req, factors)
    elif req.design == "fractional_factorial":
        runs, effects, info, extra = _fractional(req, factors)
    elif req.design == "response_surface":
        runs, effects, info, extra = _response_surface(req, factors)
    else:
        runs, effects, info, extra = _custom(req, factors, design_rng)

    if req.randomize:
        order = order_rng.permutation(len(runs))
        runs = d.Runs(runs.coded[order], [runs.patterns[i] for i in order])

    name = f"DOE {DESIGN_NAMES[req.design]}"
    table = _table(name, runs, factors, responses, effects)
    model_text = ", ".join(d.effect_label(e, factors) for e in effects)

    goals = {"maximize": "Maximize", "minimize": "Minimize", "match_target": "Match target", "none": "None"}
    summary = [
        *info,
        ("Factors", len(factors), "integer"),
        ("Runs", len(runs), "integer"),
        ("Replicates", req.replicates, "integer"),
        ("Center points", req.center_points, "integer"),
        ("Run order", "Randomized" if req.randomize else "Standard", "text"),
    ]
    diag = d.diagnose(runs.coded, factors, effects)
    if diag is None:
        diag_children: list[ReportNode] = [r.warning(f"The model ({model_text}) cannot be estimated from this design.")]
    else:
        diag_children = [
            r.summary(
                [
                    ("D Efficiency", diag.d_efficiency),
                    ("G Efficiency", diag.g_efficiency),
                    ("A Efficiency", diag.a_efficiency),
                    ("Average Variance of Prediction", diag.average_variance),
                ]
            ),
            r.text(f"For the model: {model_text}"),
        ]
    nodes: list[ReportNode] = [
        r.outline(
            name,
            [
                r.outline("Design", [r.summary(summary)]),
                _factor_table(factors),
                r.outline(
                    "Responses",
                    [r.table([("Response", "text"), ("Goal", "text")], [(resp.name.strip(), goals[resp.goal]) for resp in req.responses])],
                ),
                # Open sections (generators, aliases) come before the diagnostics, closed ones after.
                *[n for n in extra if not getattr(n, "closed", False)],
                r.outline("Design Diagnostics", diag_children),
                *[n for n in extra if getattr(n, "closed", False)],
            ],
        )
    ]
    return DoeResult(table=table, nodes=nodes)
