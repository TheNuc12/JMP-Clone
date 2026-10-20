"""Control charts and process capability."""

from ._refs import analyze, cont, nom, ordi

AREA = "quality"
ALL = {"test_beyond_limits": True, "nelson_tests": True, "show_zones": True}


def cc(name, y, params, roles=None, **kw):
    return analyze(name, "control_chart", y, roles=roles, params=params, **kw)


def cap(name, y, params, roles=None, **kw):
    return analyze(name, "capability", y, roles=roles, params=params, **kw)


def cases():
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
    return out
