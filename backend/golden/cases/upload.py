"""File parsing: CSV / TSV / TXT and Excel, matching pandas' type inference."""

import base64
import datetime as dt
import io
import re
import zipfile

from openpyxl import Workbook

AREA = "upload"


def upload(name, filename, content: bytes):
    return {"name": name, "kind": "upload", "request": {"filename": filename, "content_b64": base64.b64encode(content).decode()}}


def text(name, filename, body: str, encoding="utf-8"):
    return upload(name, filename, body.encode(encoding))


def xlsx(name, rows, extra=None):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    if extra:
        extra(wb)
    buf = io.BytesIO()
    wb.save(buf)
    return upload(name, "book.xlsx", _deterministic(buf.getvalue()))


def _deterministic(content: bytes) -> bytes:
    """Rewrite the workbook with fixed timestamps so exports are reproducible."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(content)) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = re.sub(rb">\d{4}-\d\d-\d\dT[\d:.]+Z<", b">2026-01-01T00:00:00Z<", data)
            dst.writestr(zipfile.ZipInfo(info.filename, date_time=(2026, 1, 1, 0, 0, 0)), data, zipfile.ZIP_DEFLATED)
    return out.getvalue()


def cases():
    out = [
        text("basic csv", "my data.csv", "a,b,c,d\n1,x,1.5,true\n2, y ,,false\n3,,2.5,true\n"),
        text("ints floats", "n.csv", "i,f,neg,sci\n1,1.0,-3,1e3\n2,2.5,-4,2.5e-2\n3,3,-5,7E1\n"),
        text("missing markers", "m.csv", "v,w,s\n1,NA,x\n.,2,NULL\n3,nan,n/a\n,4,\n5,N/A,None\n"),
        text("bool column", "b.csv", "flag,other\nTrue,1\nFalse,2\nTRUE,3\nfalse,4\n"),
        text("bool with missing", "b2.csv", "flag\nTrue\n\nFalse\n"),
        text("mixed numbers and text", "mix.csv", "code\n1\n2.50\nabc\n4\n"),
        text("quoted fields", "q.csv", 'name,note\n"Smith, J","said ""hi"""\n"Lee","multi\nline"\n'),
        text("duplicate headers", "dup.csv", "x,x,y\n1,2,3\n4,5,6\n"),
        text("empty header", "eh.csv", "x,,y\n1,2,3\n"),
        text("bom utf8", "bom.csv", "﻿name,val\nAnn,1\nBo,2\n"),
        text("latin1", "lat.csv", "name,val\nJos\xe9,1\nRen\xe9e,2\n", encoding="latin-1"),
        text("tsv", "t.tsv", "a\tb\n1\thello world\n2\tbye\n"),
        text("txt semicolon", "s.txt", "a;b;c\n1;2;x\n3;4;y\n"),
        text("txt tab", "t.txt", "a\tb\n1\t2\n3\t4\n"),
        text("trailing newline and spaces", "sp.csv", "a,b\n 1 ,x \n2,  y\n"),
        text("large ints", "big.csv", "id\n9007199254740993\n12\n"),
        text("only header", "h.csv", "a,b\n"),
        text("ragged rows", "r.csv", "a,b,c\n1,2\n3,4,5\n"),
        text("empty file", "e.csv", ""),
        text("unsupported ext", "x.json", '{"a":1}'),
        text("legacy xls", "old.xls", "junk"),
        xlsx("xlsx basic", [["name", "score", "passed"], ["Ann", 91.5, True], ["Bo", 78, False], ["Cy", None, True]]),
        xlsx("xlsx ints", [["n"], [1], [2], [3]]),
        xlsx("xlsx dates", [["day", "when"], [dt.date(2024, 1, 5), dt.datetime(2024, 1, 5, 13, 30)],
                            [dt.date(2024, 2, 29), dt.datetime(2024, 3, 1, 8, 0, 15)]]),
        xlsx("xlsx mixed column", [["code"], [1], ["abc"], [2.5], [None]]),
        xlsx("xlsx missing markers", [["v", "s"], [1, "NA"], [".", "x"], [3, " padded "]]),
        xlsx("xlsx formulas cached", [["a", "b"], [1, 2], [3, 4]]),
    ]
    return out
