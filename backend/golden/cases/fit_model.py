"""Fit Model: least squares, stepwise and logistic personalities."""

from ._refs import analyze, cont, nom, option_grid, ordi

AREA = "fit_model"
OPTIONS = ["effect_tests", "lack_of_fit", "residual_plot", "profiler", "sorted_estimates", "lsmeans"]


def fm(name, y, factors, effects, *, params=None, **kw):
    return analyze(name, "fit_model", y, roles={"factors": factors}, params={"effects": effects, **(params or {})}, **kw)


def cases():
    h, s, a = cont("students.height"), nom("students.sex"), ordi("students.age")
    out = []
    for i, opts in enumerate(option_grid(OPTIONS)):
        out.append(fm(f"weight~height*sex opts{i}", cont("students.weight"), [h, s], [["height"], ["sex"], ["height", "sex"]], options=opts))
    t, p, m = cont("process.temperature"), cont("process.pressure"), nom("process.machine")
    out += [
        fm("yield rsm-ish", cont("process.yield_pct"), [t, p, m],
           [["temperature"], ["pressure"], ["machine"], ["temperature", "machine"], ["temperature", "temperature"]],
           options={k: True for k in OPTIONS}),
        fm("yield uncentered", cont("process.yield_pct"), [t, p], [["temperature"], ["pressure"], ["temperature", "pressure"]],
           params={"center_polynomials": False}),
        fm("weight age ordinal", cont("students.weight"), [h, a], [["height"], ["age"]], options={"lsmeans": True}),
        fm("syn missing two cats", cont("syn.y"), [cont("syn.x1"), nom("syn.g3"), nom("syn.g2")],
           [["x1"], ["g3"], ["g2"], ["g3", "g2"]], options={k: True for k in OPTIONS}),
        fm("factorial lack of fit", cont("factorial.Resp"), [cont("factorial.A"), cont("factorial.B"), cont("factorial.C")],
           [["A"], ["B"], ["C"], ["A", "B"]], options={k: True for k in OPTIONS}),
        fm("factorial categorical", cont("factorial.Resp"), [cont("factorial.A"), nom("factorial.Cat", levels=["lo", "mid", "hi"])],
           [["A"], ["Cat"], ["A", "Cat"]], options={k: True for k in OPTIONS}),
        fm("screening aliased", cont("screening.Resp"), [cont(f"screening.{f}") for f in "ABCD"],
           [["A"], ["B"], ["C"], ["D"], ["A", "B"], ["C", "D"]], options={k: True for k in OPTIONS}),
        fm("no effects", cont("students.weight"), [], []),
        fm("too few rows", cont("tiny.two"), [cont("tiny.x")], [["x"], ["x", "x"]]),
        fm("constant response", cont("tiny.const"), [cont("tiny.x")], [["x"]]),
        fm("all missing response", cont("tiny.allna"), [cont("tiny.x")], [["x"]]),
        fm("excluded rows", cont("students.weight"), [h, s], [["height"], ["sex"]], rows=list(range(0, 40, 2))),
    ]
    for direction in ("forward", "backward", "mixed"):
        out.append(fm(f"stepwise {direction}", cont("process.yield_pct"), [t, p, m, cont("process.speed")],
                      [["temperature"], ["pressure"], ["machine"], ["speed"], ["temperature", "pressure"], ["temperature", "temperature"]],
                      params={"personality": "stepwise", "direction": direction}))
    out += [
        fm("stepwise strict thresholds", cont("syn.y"), [cont("syn.x1"), cont("syn.x2"), nom("syn.g3"), nom("syn.g2")],
           [["x1"], ["x2"], ["g3"], ["g2"], ["x1", "x2"]], params={"personality": "stepwise", "direction": "mixed", "p_enter": 0.05, "p_leave": 0.05}),
        fm("logistic binary", nom("students.sex"), [h, cont("students.weight")], [["height"], ["weight"]]),
        fm("logistic binary cat factor", nom("process.defect"), [t, m], [["temperature"], ["machine"]]),
        fm("logistic nominal", nom("process.machine"), [t, p], [["temperature"], ["pressure"]]),
        # Finite-difference Hessian in statsmodels: standard errors agree to ~1e-4 relative.
        fm("logistic ordinal", ordi("syn.yo", levels=["Low", "Mid", "High"]), [cont("syn.x1"), nom("syn.g2")], [["x1"], ["g2"]],
           tol={"rtol": 3e-4}),
        fm("logistic separation", nom("tiny.sep_y"), [cont("tiny.x")], [["x"]]),
    ]
    return out
