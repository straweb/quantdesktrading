#!/usr/bin/env python3
"""Splice the new single-row toolbar block into canvas-chart.tsx,
replacing the old HoverMenu column block (marker-delimited)."""
import re

SRC = '/home/z/my-project/src/components/terminal/chart/canvas-chart.tsx'
NEW = '/home/z/my-project/scripts/tb_block.tsx'

with open(SRC) as f:
    src = f.read()
with open(NEW) as f:
    new_block = f.read().rstrip('\n')

start_marker = "      {/* ---- per-chart control column (#chartbar) — LEFT, under the legend rows;"
end_marker = "      {/* annotation text entry (text / note / comment / callout / pin / table) */}"

i = src.index(start_marker)
j = src.index(end_marker)
replaced = src[i:j]
# sanity: the old block must contain the last HoverMenu (breaks) closing tag
assert 'HoverMenu' in replaced and replaced.count('<HoverMenu') == 6, f'unexpected block: {replaced.count("<HoverMenu")} HoverMenus'
src = src[:i] + new_block + "\n\n" + src[j:]

with open(SRC, 'w') as f:
    f.write(src)
print(f'spliced ok — old block {len(replaced)} chars -> new {len(new_block)} chars')
