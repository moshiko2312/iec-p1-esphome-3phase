#!/usr/bin/env python3
"""Host test for the P1 parser lambda in esphome/common/p1.yaml.

Extracts the interval lambda exactly as written, expands id() the way ESPHome
does (id(x).y -> x->y, id(x) -> x), wraps it with small mocks and runs
test_parser.cpp against it. Needs g++ and PyYAML-free parsing (plain text).
Usage: python3 tests/run_parser_test.py
"""
import pathlib
import re
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
yaml_text = (root / "esphome/common/p1.yaml").read_text()

match = re.search(r"- lambda: \|-\n((?: {10}.*\n|\n)+)", yaml_text)
if not match:
    sys.exit("lambda not found in p1.yaml")
body = "\n".join(line[10:] for line in match.group(1).splitlines())
body = re.sub(r"\bid\((\w+)\)\.", r"\1->", body)
body = re.sub(r"\bid\((\w+)\)", r"\1", body)

harness = (root / "tests/test_parser.cpp").read_text()
source = harness.replace("// @@LAMBDA_BODY@@", body)

with tempfile.TemporaryDirectory() as tmp:
    src = pathlib.Path(tmp) / "test.cpp"
    exe = pathlib.Path(tmp) / "test"
    src.write_text(source)
    subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-O1", "-o", str(exe), str(src)], check=True)
    result = subprocess.run([str(exe)])
    sys.exit(result.returncode)
