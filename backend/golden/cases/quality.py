"""Control charts and process capability."""

import numpy as np

from ..data import datasets
from ._refs import analyze, cont, nom, ordi

AREA = "quality"
ALL = {"test_beyond_limits": True, "nelson_tests": True, "show_zones": True}


def _spc_dataset() -> dict[str, list]:
    """60-row series that each trigger one Nelson test, plus subgroup and count columns."""
    rng = np.random.default_rng(1924)
    base = rng.normal(0, 1, 60)

    def with_pattern(start: int, pattern: list[float]) -> list[float]:
        out = base.copy()
        out[start : start + len(pattern)] = pattern
        return [round(float(v), 4) for v in out]

    sizes = [4, 5, 3, 1, 6, 4, 5, 2, 7, 4, 5, 3, 4, 7]  # sums to 60; one singleton subgroup
    grp_var = [f"g{k + 1:02d}" for k, n in enumerate(sizes) for _ in range(n)]
    step = [float(k // 5) * 2.0 for k in range(60)]  # constant within consecutive groups of 5
    return {
        "t1": with_pattern(30, [9.0]),
        "t2": with_pattern(20, [1.6, 1.4, 1.7, 1.5, 1.8, 1.45, 1.65, 1.55, 1.75]),
        "t3": with_pattern(40, [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5]),
        "t4": with_pattern(10, [0.8, -0.8] * 7),
        "t5": with_pattern(50, [3.0, 0.1, 3.1]),
        "t6": with_pattern(35, [1.8, 1.9, 0.0, 1.7, 1.85]),
        "t7": with_pattern(5, [0.05, -0.04, 0.03, -0.02, 0.01, -0.05, 0.04, -0.03, 0.02, -0.01, 0.05, -0.04, 0.03, -0.02, 0.01]),
        "t8": with_pattern(44, [2.2, 2.4, -2.3, -2.2, 2.3, -2.4, 2.1, -2.2]),
        "grp_var": grp_var,
        "step": step,
        "zeros": [0] * 60,
        "neg": [3, -1] + [2] * 58,
        "over": [12, 3] + [4] * 58,
        "tens": [10] * 60,
        "lab": [None if k % 7 == 3 else f"L{k}" for k in range(60)],
    }


def _register() -> None:
    # Datasets only these cases use live here so data.py stays the same for other areas.
    datasets().setdefault("spc", _spc_dataset())


def cc(name, y, params, roles=None, **kw):
    return analyze(name, "control_chart", y, roles=roles, params=params, **kw)


def cap(name, y, params, roles=None, **kw):
    return analyze(name, "capability", y, roles=roles, params=params, **kw)


def cases():
    _register()
    yld, temp = cont("process.yield_pct"), cont("process.temperature")
    batch = ordi("process.batch")
    out = [
        cc("imr yield defaults", yld, {"chart_type": "imr"}),
        cc("imr yield all tests", yld, {"chart_type": "imr"}, options=ALL),
        cc("imr yield no tests", yld, {"chart_type": "imr"}, options={"test_beyond_limits": False}),
        cc("imr with labels", cont("students.height"), {"chart_type": "imr"}, roles={"subgroup": [nom("students.name")]}, options=ALL),
        cc("imr with spec", yld, {"chart_type": "imr", "lsl": 75, "usl": 90, "target": 82}),
        cc("imr excluded", yld, {"chart_type": "imr"}, rows=list(range(0, 200, 3)), options=ALL),
        cc("xbar_r subgroup col", temp, {"chart_type": "xbar_r"}, roles={"subgroup": [batch]}, options=ALL),
        cc("xbar_r size 5", temp, {"chart_type": "xbar_r", "subgroup_size": 5}, options=ALL),
        cc("xbar_s size 8", temp, {"chart_type": "xbar_s", "subgroup_size": 8}, options=ALL),
        cc("xbar_s subgroup col spec", yld, {"chart_type": "xbar_s", "lsl": 70, "usl": 95}, roles={"subgroup": [batch]}),
        cc("xbar varying sizes", cont("syn.y"), {"chart_type": "xbar_r"}, roles={"subgroup": [nom("syn.g3")]}),
        cc("p chart sample size col", cont("syn.defectives"), {"chart_type": "p"}, roles={"sample_size": [cont("syn.sizes")]}, options=ALL),
        cc("p chart constant n", cont("syn.defectives"), {"chart_type": "p", "sample_size": 60}),
        cc("np chart", cont("syn.defectives"), {"chart_type": "np", "sample_size": 60}, options=ALL),
        cc("c chart", cont("syn.defects"), {"chart_type": "c"}, options=ALL),
        cc("u chart", cont("syn.defects"), {"chart_type": "u"}, roles={"sample_size": [cont("syn.sizes")]}, options=ALL),
        cc("p chart categorical defect", nom("process.defect"), {"chart_type": "p", "defect_level": "Fail"}, roles={"subgroup": [batch]}),
        cc("np chart categorical default level", nom("process.defect"), {"chart_type": "np"}, roles={"subgroup": [batch]}),
        cc("imr const", cont("tiny.const"), {"chart_type": "imr"}),
        cc("imr one", cont("tiny.one"), {"chart_type": "imr"}),
        cc("imr all missing", cont("tiny.allna"), {"chart_type": "imr"}),
        cc("p without sizes", cont("syn.defectives"), {"chart_type": "p"}),
        cap("capability two sided", yld, {"lsl": 75, "usl": 90, "target": 82}),
        cap("capability lsl only", yld, {"lsl": 75}),
        cap("capability usl only", cont("students.height"), {"usl": 68}),
        cap("capability subgroup", temp, {"lsl": 150, "usl": 210}, roles={"subgroup": [batch]}),
        cap("capability no limits", yld, {}),
        cap("capability const", cont("tiny.const"), {"lsl": 1, "usl": 9}),
        cap("capability excluded", yld, {"lsl": 75, "usl": 90}, rows=list(range(0, 200, 2))),
    ]
    out += [cc(f"nelson test {k}", cont(f"spc.t{k}"), {"chart_type": "imr"}, options=ALL) for k in range(1, 9)]
    grp_var = nom("spc.grp_var")
    out += [
        cc("xbar_s varying sizes with singleton", cont("spc.t1"), {"chart_type": "xbar_s"}, roles={"subgroup": [grp_var]}, options=ALL),
        cc("xbar_r varying sizes with singleton", cont("spc.t2"), {"chart_type": "xbar_r"}, roles={"subgroup": [grp_var]}, options=ALL),
        cc("xbar all singletons", cont("students.height"), {"chart_type": "xbar_r"}, roles={"subgroup": [nom("students.name")]}),
        cc("xbar no within variation", cont("spc.step"), {"chart_type": "xbar_r", "subgroup_size": 5}, options=ALL),
        cc("xbar_r size 30", temp, {"chart_type": "xbar_r", "subgroup_size": 30}, options=ALL),
        cc("xbar_s size 30 spec", temp, {"chart_type": "xbar_s", "subgroup_size": 30, "lsl": 150, "usl": 210}),
        cc("xbar string params", temp, {"chart_type": "xbar_r", "subgroup_size": "4", "lsl": "160", "usl": " 200 "}),
        cc("xbar subgroup size 0 defaults to 5", temp, {"chart_type": "xbar_r", "subgroup_size": 0}),
        cc("imr labels with gaps", cont("spc.t3"), {"chart_type": "imr"}, roles={"subgroup": [nom("spc.lab")]}),
        cc("u chart constant n", cont("syn.defects"), {"chart_type": "u", "sample_size": 50}, options=ALL),
        cc("c chart by subgroup", cont("syn.defects"), {"chart_type": "c"}, roles={"subgroup": [ordi("syn.batch")]}, options=ALL),
        cc("p chart by subgroup with sizes", cont("syn.defectives"), {"chart_type": "p"},
           roles={"subgroup": [nom("syn.g3")], "sample_size": [cont("syn.sizes")]}, options=ALL),
        cc("np chart varying sizes", cont("syn.defectives"), {"chart_type": "np"}, roles={"sample_size": [cont("syn.sizes")]}, options=ALL),
        cc("p chart excluded rows", cont("syn.defectives"), {"chart_type": "p"}, roles={"sample_size": [cont("syn.sizes")]},
           rows=list(range(0, 60, 3)), options=ALL),
        cc("u chart excluded rows", cont("syn.defects"), {"chart_type": "u"}, roles={"sample_size": [cont("syn.sizes")]}, rows=list(range(1, 60, 2))),
        cc("p chart categorical by size", nom("process.defect"), {"chart_type": "p", "subgroup_size": 10, "defect_level": "Fail"}, options=ALL),
        cc("p chart categorical unknown level", nom("process.defect"), {"chart_type": "p", "defect_level": "Broken"}, roles={"subgroup": [batch]}),
        cc("p chart categorical no subgroups", nom("process.defect"), {"chart_type": "p"}),
        cc("c chart categorical", nom("process.defect"), {"chart_type": "c"}, roles={"subgroup": [batch]}),
        cc("c chart zero defects", cont("spc.zeros"), {"chart_type": "c"}),
        cc("c chart negative counts", cont("spc.neg"), {"chart_type": "c"}),
        cc("p chart counts over size", cont("spc.over"), {"chart_type": "p", "sample_size": 10}),
        cc("np chart sample size column", cont("spc.over"), {"chart_type": "np"}, roles={"sample_size": [cont("spc.tens")]}),
        cc("p chart sample size zero", cont("syn.defectives"), {"chart_type": "p", "sample_size": 0}),
        cc("unknown chart type", yld, {"chart_type": "zz"}),
        cc("spec on attribute chart", cont("syn.defects"), {"chart_type": "c", "lsl": 1, "usl": 9}),
        cc("imr categorical y", nom("process.machine"), {"chart_type": "imr"}),
        cap("capability lsl and target", yld, {"lsl": 75, "target": 80}),
        cap("capability usl and target", yld, {"usl": 90, "target": 85}),
        cap("capability target only", yld, {"target": 82}),
        cap("capability limits reversed", yld, {"lsl": 90, "usl": 75, "target": 82}),
        cap("capability categorical", nom("process.machine"), {"lsl": 1, "usl": 2}),
        cap("capability one value", cont("tiny.one"), {"lsl": 1, "usl": 9}),
        cap("capability subgroup with singleton", cont("spc.t4"), {"lsl": -3, "usl": 3}, roles={"subgroup": [grp_var]}),
        cap("capability string limits", yld, {"lsl": "75", "usl": "nan", "target": "x"}),
    ]
    return out
