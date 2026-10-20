"""Fit Y by X: bivariate, oneway, contingency and logistic."""

from ._refs import analyze, cont, nom, option_grid, ordi

AREA = "fit_y_by_x"
BIV = ["fit_mean", "fit_line", "fit_quadratic", "correlation"]
ONEWAY = ["means_anova", "means_std", "t_test", "box_plots", "unequal_variances", "nonparametric", "tukey"]


def fyx(name, y, x, **kw):
    return analyze(name, "fit_y_by_x", y, x, **kw)


def cases():
    out = []
    for i, opts in enumerate(option_grid(BIV)):
        out.append(fyx(f"bivariate weight~height opts{i}", cont("students.weight"), cont("students.height"), options=opts))
    out += [
        fyx("bivariate yield~temperature all", cont("process.yield_pct"), cont("process.temperature"), options={k: True for k in BIV}),
        fyx("bivariate syn missing", cont("syn.y"), cont("syn.x1"), options={k: True for k in BIV}),
        fyx("bivariate excluded rows", cont("students.weight"), cont("students.height"), rows=list(range(1, 40, 3)), options={k: True for k in BIV}),
        fyx("bivariate const x", cont("tiny.x"), cont("tiny.const"), options={k: True for k in BIV}),
        fyx("bivariate const y", cont("tiny.const"), cont("tiny.x"), options={k: True for k in BIV}),
        fyx("bivariate two points", cont("tiny.two"), cont("tiny.x"), options={k: True for k in BIV}),
        fyx("bivariate all missing", cont("tiny.allna"), cont("tiny.x")),
    ]
    for i, opts in enumerate(option_grid(ONEWAY)):
        out.append(fyx(f"oneway yield~machine opts{i}", cont("process.yield_pct"), nom("process.machine"), options=opts))
        out.append(fyx(f"oneway weight~sex opts{i}", cont("students.weight"), nom("students.sex"), options=opts))
    out += [
        fyx("oneway bp~treatment value order", cont("trial.bp_change"), nom("trial.treatment", levels=["Placebo", "Low Dose", "High Dose"]),
            options={k: True for k in ONEWAY}),
        fyx("oneway weight~age ordinal", cont("students.weight"), ordi("students.age"), options={k: True for k in ONEWAY}),
        fyx("oneway syn missing", cont("syn.y"), nom("syn.g3"), options={k: True for k in ONEWAY}),
        fyx("oneway single group", cont("tiny.x"), nom("tiny.cat_one"), options={k: True for k in ONEWAY}),
        fyx("oneway one per level", cont("tiny.x"), nom("students.name"), rows=list(range(8)), options={k: True for k in ONEWAY}),
        fyx("oneway const y", cont("tiny.const"), nom("tiny.pair"), options={k: True for k in ONEWAY}),
        fyx("oneway pair", cont("tiny.pair_y"), nom("tiny.pair"), options={k: True for k in ONEWAY}),
    ]
    for opts in ({}, {"contingency_table": False}, {"tests": False}):
        out.append(fyx(f"contingency response~treatment {sorted(opts)}", ordi("trial.response"), nom("trial.treatment"), options=opts))
    out += [
        fyx("contingency sex~age sparse", nom("students.sex"), ordi("students.age")),
        fyx("contingency 2x2 fisher", nom("process.defect"), nom("process.shift")),
        fyx("contingency 2x2 syn", nom("syn.yb"), nom("syn.g2")),
        fyx("contingency value order", ordi("trial.response", levels=["Worse", "Same", "Improved"]), nom("trial.sex")),
        fyx("contingency one level", nom("tiny.cat_one"), nom("tiny.pair")),
        fyx("contingency missing", nom("syn.g3"), nom("syn.g2")),
    ]
    for opts in ({}, {"odds_ratios": True}):
        tag = "or" if opts else "plain"
        out += [
            fyx(f"logistic sex~height {tag}", nom("students.sex"), cont("students.height"), options=opts),
            fyx(f"logistic defect~temperature {tag}", nom("process.defect"), cont("process.temperature"), options=opts),
            fyx(f"logistic yb~x1 {tag}", nom("syn.yb"), cont("syn.x1"), options=opts),
            fyx(f"logistic nominal 3 {tag}", nom("process.machine"), cont("process.pressure"), options=opts),
            fyx(f"logistic ordinal 3 {tag}", ordi("syn.yo", levels=["Low", "Mid", "High"]), cont("syn.x1"), options=opts),
            fyx(f"logistic ordinal response {tag}", ordi("trial.response"), cont("trial.age"), options=opts),
        ]
    out += [
        fyx("logistic separation", nom("tiny.sep_y"), cont("tiny.x")),
        fyx("logistic ordinal separation", ordi("tiny.sep_y"), cont("tiny.x")),
        fyx("logistic one level", nom("tiny.cat_one"), cont("tiny.x")),
        fyx("logistic missing", nom("syn.g3"), cont("syn.y")),
    ]
    return out
