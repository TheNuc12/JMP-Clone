"""Distribution platform."""

from ._refs import analyze, cont, nom, option_grid, ordi

AREA = "distribution"
CONT_OPTIONS = ["fit_normal", "outlier_box"]


def cases():
    out = []
    for i, opts in enumerate(option_grid(CONT_OPTIONS)):
        out.append(analyze(f"students height opts{i}", "distribution", cont("students.height"), options=opts))
        out.append(analyze(f"process yield opts{i}", "distribution", cont("process.yield_pct"), options=opts))
    out += [
        analyze("trial bp_change fit normal", "distribution", cont("trial.bp_change"), options={"fit_normal": True}),
        analyze("syn y missing values", "distribution", cont("syn.y"), options={"fit_normal": True}),
        analyze("syn x2 uniform", "distribution", cont("syn.x2"), options={"fit_normal": True}),
        analyze("students weight excluded rows", "distribution", cont("students.weight"), rows=list(range(0, 40, 2))),
        analyze("big n lilliefors", "distribution", cont("big.z"), options={"fit_normal": True}),
        analyze("shapiro at n 5000", "distribution", cont("big.z"), rows=list(range(5000)), options={"fit_normal": True}),
        analyze("pressure two decimals", "distribution", cont("process.pressure"), options={"fit_normal": True}),
        analyze("const", "distribution", cont("tiny.const"), options={"fit_normal": True}),
        analyze("one value", "distribution", cont("tiny.one"), options={"fit_normal": True}),
        analyze("two values", "distribution", cont("tiny.two"), options={"fit_normal": True}),
        analyze("all missing", "distribution", cont("tiny.allna"), options={"fit_normal": True}),
        analyze("integers as continuous", "distribution", cont("process.batch")),
        # categorical
        analyze("sex nominal", "distribution", nom("students.sex")),
        analyze("age ordinal numeric levels", "distribution", ordi("students.age")),
        analyze("response value order", "distribution", ordi("trial.response", levels=["Worse", "Same", "Improved"])),
        analyze("partial value order numeric labels", "distribution", ordi("students.age", levels=["17", "12"])),
        analyze("g3 with missing", "distribution", nom("syn.g3")),
        analyze("operator", "distribution", nom("process.operator")),
        analyze("cat all missing", "distribution", nom("tiny.cat_na")),
        analyze("cat one level", "distribution", nom("tiny.cat_one")),
        analyze("numeric as nominal", "distribution", nom("syn.batch")),
        analyze("names many levels", "distribution", nom("students.name")),
    ]
    return out
