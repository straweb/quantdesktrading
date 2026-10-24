"""Insert `from __future__ import annotations` into every backend/*.py file
that doesn't have it yet (Python 3.9 hardening: PEP 563 defers annotation
evaluation, so future edits using `X | None` can't crash import on 3.9)."""
import ast
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
ROOT = os.path.abspath(ROOT)
FUTURE = "from __future__ import annotations"
changed, skipped = [], []

for dirpath, _dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".py"):
            continue
        path = os.path.join(dirpath, fn)
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
        if FUTURE in src:
            skipped.append(os.path.relpath(path, ROOT))
            continue
        lines = src.splitlines(keepends=True)
        tree = ast.parse(src)
        # insertion index (0-based line number)
        idx = 0
        if tree.body:
            first = tree.body[0]
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                idx = first.end_lineno  # right after module docstring
        # skip leading shebang/comment/blank block for files without a docstring
        else:
            while idx < len(lines) and (lines[idx].startswith("#!") or
                                        lines[idx].lstrip().startswith("#") or
                                        not lines[idx].strip()):
                idx += 1
        lines.insert(idx, FUTURE + "\n")
        # keep one blank line after the import if the next line is code
        if idx + 1 < len(lines) and lines[idx + 1].strip():
            lines.insert(idx + 1, "\n")
        with open(path, "w", encoding="utf-8") as f:
            f.write("".join(lines))
        changed.append(os.path.relpath(path, ROOT))

print(f"updated {len(changed)} files, already-had {len(skipped)}")
for c in changed:
    print("  +", c)

# syntax sanity: everything must still parse
bad = []
for dirpath, _dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".py"):
            continue
        path = os.path.join(dirpath, fn)
        try:
            ast.parse(open(path, encoding="utf-8").read())
        except SyntaxError as e:
            bad.append(f"{path}: {e}")
if bad:
    print("SYNTAX ERRORS:")
    print("\n".join(bad))
    sys.exit(1)
print("syntax check OK")
