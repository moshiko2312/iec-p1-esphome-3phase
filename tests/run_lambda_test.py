#!/usr/bin/env python3
"""Compiles the plan and cost lambdas from esphome/common/*.yaml on a PC.

Each multi-line lambda is pasted into a function, with id() expanded the way
ESPHome does, next to small mocks of the ESPHome classes it touches. Then a few
scenarios run against the real iec_p1.h engine. Usage: python3 tests/run_lambda_test.py
"""
import pathlib
import re
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent


def lambdas(path):
    text = (root / path).read_text()
    out = []
    for m in re.finditer(r"^( *)- lambda: \|-\n((?:\1  .*\n|\n)+)", text, re.M):
        indent = len(m.group(1)) + 2
        body = "\n".join(line[indent:] for line in m.group(2).splitlines())
        out.append(body)
    for m in re.finditer(r"^ *- lambda: ([^|\n].*)$", text, re.M):
        out.append(m.group(1))
    return out


def expand(body):
    body = re.sub(r"\bid\((\w+)\)\.", r"\1->", body)
    return re.sub(r"\bid\((\w+)\)", r"\1", body)


plans = lambdas("esphome/common/plans.yaml")
cost = lambdas("esphome/common/cost.yaml")
funcs = []
for i, body in enumerate(plans + cost):
    funcs.append(f"void lambda_{i}(float kwh, float kw) {{ (void) kwh; (void) kw;\n{expand(body)}\n}}")

harness = (root / "tests/test_lambdas.cpp").read_text()
source = harness.replace("// @@LAMBDAS@@", "\n\n".join(funcs))
source = source.replace("@@UPDATE_PRICE@@", "lambda_0")

with tempfile.TemporaryDirectory() as tmp:
    src = pathlib.Path(tmp) / "t.cpp"
    exe = pathlib.Path(tmp) / "t"
    src.write_text(source)
    subprocess.run(["g++", "-std=c++17", "-Wall", "-Wno-unused-variable", "-I", str(root / "esphome/common"),
                    "-o", str(exe), str(src)], check=True)
    sys.exit(subprocess.run([str(exe)]).returncode)
