"""Design of experiments. Randomization is off so designs compare exactly; custom
(D-optimal) designs use a random search and are compared by their properties."""

AREA = "doe"


def cont(name, low=-1.0, high=1.0):
    return {"name": name, "kind": "continuous", "low": low, "high": high}


def cat(name, *levels):
    return {"name": name, "kind": "categorical", "levels": list(levels)}


def doe(name, design, factors, compare="exact", **kw):
    request = {"design": design, "factors": factors, "randomize": False, **kw}
    return {"name": name, "kind": "doe", "request": request, "compare": compare}


def cases():
    c3 = [cont("X1"), cont("X2"), cont("X3")]
    out = [
        doe("full 3 continuous", "full_factorial", c3),
        doe("full with centers", "full_factorial", c3, center_points=3),
        doe("full replicated", "full_factorial", c3, replicates=1, center_points=2),
        doe("full mixed", "full_factorial", [cont("Temp", 150, 200), cat("Catalyst", "A", "B", "C")], center_points=2),
        doe("full two responses", "full_factorial", c3[:2], responses=[{"name": "Yield", "goal": "maximize"}, {"name": "Cost", "goal": "minimize"}]),
        doe("full randomized seed", "full_factorial", c3, randomize=True, seed=3, compare="rows"),
        doe("full too many factors", "full_factorial", [cont(f"F{i}") for i in range(13)]),
        doe("full bad range", "full_factorial", [cont("X", 2, 1)]),
        doe("full duplicate names", "full_factorial", [cont("X"), cont("X")]),
    ]
    for k in range(3, 12):
        out.append(doe(f"fractional k{k}", "fractional_factorial", [cont(f"X{i + 1}") for i in range(k)]))
    for k, res in ((5, 3), (5, 5), (6, 3), (7, 4), (8, 5)):
        out.append(doe(f"fractional k{k} res{res}", "fractional_factorial", [cont(f"X{i + 1}") for i in range(k)], resolution=res))
    out += [
        doe("fractional categorical 2-level", "fractional_factorial", [cont("A"), cont("B"), cat("C", "x", "y"), cont("D")]),
        doe("fractional 3-level categorical error", "fractional_factorial", [cont("A"), cat("B", "x", "y", "z"), cont("C")]),
        doe("fractional k13", "fractional_factorial", [cont(f"X{i + 1}") for i in range(13)]),
    ]
    for k in (2, 3, 4, 5):
        for alpha in ("rotatable", "orthogonal", "face_centered"):
            out.append(doe(f"ccd k{k} {alpha}", "response_surface", [cont(f"X{i + 1}", 10, 20) for i in range(k)], ccd_alpha=alpha))
    for k in range(3, 8):
        out.append(doe(f"bbd k{k}", "response_surface", [cont(f"X{i + 1}") for i in range(k)], rsm_type="box_behnken"))
    out += [
        doe("bbd k2 error", "response_surface", [cont("X1"), cont("X2")], rsm_type="box_behnken"),
        doe("rsm categorical error", "response_surface", [cont("X1"), cat("C", "a", "b")]),
        doe("custom main effects", "custom", c3, compare="properties", seed=1),
        doe("custom interactions", "custom", c3, model=[["X1"], ["X2"], ["X3"], ["X1", "X2"], ["X1", "X3"]], compare="properties", seed=1),
        doe("custom quadratic", "custom", c3[:2], model=[["X1"], ["X2"], ["X1", "X2"], ["X1", "X1"], ["X2", "X2"]], n_runs=10, compare="properties", seed=2),
        doe("custom categorical", "custom", [cont("X1"), cat("M", "a", "b", "c")], model=[["X1"], ["M"], ["X1", "M"]], compare="properties", seed=4),
        doe("custom too few runs", "custom", c3, model=[["X1"], ["X2"], ["X3"], ["X1", "X2"]], n_runs=3),
    ]
    return out
