"""Verify backend is Python 3.9-safe: NO PEP-604 unions (X | Y) in any
runtime-evaluated annotation, no match-statements, and every file parses.

AST-based — catches anything the regex fixer missed, including unions in
pydantic BaseModel fields (evaluated at class creation) and FastAPI
endpoint signatures (evaluated by FastAPI at route registration).
"""
import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "backend"
bad = []


def scan_annotation(node, where: str) -> None:
    for n in ast.walk(node):
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr):
            bad.append(f"{where}: union operator in annotation (line {n.lineno})")
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and "|" in n.value:
            bad.append(f"{where}: quoted union annotation {n.value!r} (line {n.lineno})")


for p in sorted(ROOT.rglob("*.py")):
    src = p.read_text()
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        bad.append(f"{p}: SYNTAX ERROR {e}")
        continue
    rel = p.relative_to(ROOT.parent)
    for n in ast.walk(tree):
        if isinstance(n, ast.Match):
            bad.append(f"{rel}: match-statement (py3.10+) line {n.lineno}")
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for a in list(n.args.args) + list(n.args.kwonlyargs) + list(n.args.posonlyargs):
                if a.annotation is not None:
                    scan_annotation(a.annotation, f"{rel} def {n.name} param {a.arg}")
            if n.args.vararg and n.args.vararg.annotation is not None:
                scan_annotation(n.args.vararg.annotation, f"{rel} def {n.name} vararg")
            if n.args.kwarg and n.args.kwarg.annotation is not None:
                scan_annotation(n.args.kwarg.annotation, f"{rel} def {n.name} kwarg")
            if n.returns is not None:
                scan_annotation(n.returns, f"{rel} def {n.name} return")
        if isinstance(n, ast.AnnAssign):
            scan_annotation(n.annotation, f"{rel} ann-assign line {n.lineno}")

if bad:
    print(f"FAIL — {len(bad)} py3.9 violations:")
    for b in bad[:60]:
        print("  ", b)
    sys.exit(1)
print("OK — no PEP-604 unions / match statements in runtime-evaluated annotations")
