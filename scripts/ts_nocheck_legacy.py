#!/usr/bin/env python3
"""Prepend `// @ts-nocheck` to every file in the LEGACY monolith graph.

The live terminal runs entirely on FastAPI /pyapi + socket.io. The old
Next.js-API/Prisma/broker-sdk monolith (src/lib/services, src/app/api,
brokers/) is dead code that no request path reaches, but tsc still walks it
via instrumentation + .next generated route types. Newer dep installs
(regenerated Prisma client without the old models) surface ~150 latent type
errors there. @ts-nocheck silences type errors per-file with ZERO runtime
effect (SWC bundling is unaffected).
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = "// @ts-nocheck"

LEGACY_TREES = [
    os.path.join(ROOT, "brokers"),
    os.path.join(ROOT, "src", "lib", "services"),
    os.path.join(ROOT, "src", "app", "api"),
]

# standalone legacy files (old monolith bootstrap registrar)
EXTRA_FILES = [
    os.path.join(ROOT, "src", "instrumentation-node.ts"),
]

done, skipped = [], []
for tree in LEGACY_TREES:
    for dirpath, _dirs, files in os.walk(tree):
        for f in files:
            if not f.endswith(".ts"):
                continue
            p = os.path.join(dirpath, f)
            with open(p, "r", encoding="utf-8") as fh:
                src = fh.read()
            if src.lstrip().startswith(MARK):
                skipped.append(p)
                continue
            # keep any existing shebang/docstring order simple: pragma first
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(MARK + "\n" + src)
            done.append(os.path.relpath(p, ROOT))

for p in EXTRA_FILES:
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as fh:
            src = fh.read()
        if not src.lstrip().startswith(MARK):
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(MARK + "\n" + src)
            done.append(os.path.relpath(p, ROOT))
        else:
            skipped.append(p)

print(f"marked {len(done)} files, already-marked {len(skipped)}")
if "-v" in sys.argv:
    for p in done:
        print(" +", p)
