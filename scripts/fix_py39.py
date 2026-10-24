"""Fix Python 3.9 compatibility: convert PEP-604 unions (X | Y) in
runtime-evaluated annotations to typing.Optional / typing.Union.

The user's Mac runs Apple CLT Python 3.9 where `dict | None` raises
TypeError at definition time — this crashed the backend on boot.

Approach: char-scan every line for `|` chains whose operands look like
type atoms (identifier[...], dotted, quoted forward-refs), confirm the
chain sits in an ANNOTATION context (left-walk finds `:` with a plain
identifier before it, or `->`), then rewrite the chain.  Finally merge
missing typing imports.  Quoted forward refs ("Hub | None") are
converted inside the quotes.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "backend"
OPENERS = "([{"
CLOSERS = ")]}"


def _match_back(line: str, pos: int) -> int:
    """pos at a closer; return index of its matching opener."""
    depth = 0
    i = pos
    while i >= 0:
        c = line[i]
        if c in CLOSERS:
            depth += 1
        elif c in OPENERS:
            depth -= 1
            if depth == 0:
                return i
        i -= 1
    return -1


def _atom_left(line: str, pos: int) -> tuple[int, str] | None:  # noqa: UP045
    """Expand the type atom ending at pos (inclusive). Returns (start, text)."""
    i = pos
    while i >= 0 and line[i] in " \t":
        i -= 1
    if i < 0:
        return None
    # closing bracket -> walk to matching opener, then dotted ident chain
    if line[i] in CLOSERS:
        op = _match_back(line, i)
        if op < 0:
            return None
        j = op - 1
        while j >= 0 and line[j] in " \t":
            j -= 1
        end_ident = j
        while j >= 0 and (line[j].isalnum() or line[j] in "_."):
            j -= 1
        if end_ident == j or not line[j + 1:end_ident + 1].replace(".", "").isalnum():
            return None
        return (j + 1, line[j + 1:i + 1])
    # quoted forward ref
    if line[i] in "\"'":
        q = line[i]
        j = i - 1
        while j >= 0 and line[j] != q:
            j -= 1
        if j < 0:
            return None
        return (j, line[j:i + 1])
    # dotted identifier
    end = i
    while i >= 0 and (line[i].isalnum() or line[i] in "_."):
        i -= 1
    txt = line[i + 1:end + 1]
    if not txt or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_\.]*", txt):
        return None
    return (i + 1, txt)


def _atom_right(line: str, pos: int) -> tuple[int, str] | None:  # noqa: UP045
    """Expand the type atom starting at pos. Returns (end_exclusive, text)."""
    i = pos
    n = len(line)
    while i < n and line[i] in " \t":
        i += 1
    if i >= n:
        return None
    if line[i] in "\"'":
        q = line[i]
        j = i + 1
        while j < n and line[j] != q:
            j += 1
        if j >= n:
            return None
        return (j + 1, line[i:j + 1])
    end_ident = i
    while i < n and (line[i].isalnum() or line[i] in "_."):
        i += 1
    txt = line[end_ident:i]
    if not txt or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_\.]*", txt):
        return None
    # optional subscript (one balanced group)
    if i < n and line[i] == "[":
        depth = 0
        j = i
        while j < n:
            if line[j] == "[":
                depth += 1
            elif line[j] == "]":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j < n:
            txt = line[end_ident:j + 1]
            i = j + 1
    return (i, txt)


def _is_annotation_context(line: str, chain_start: int) -> bool:
    """Walk left from the union chain; annotation = `:` (with a plain
    identifier before it) or `->`."""
    i = chain_start - 1
    while i >= 0:
        c = line[i]
        if c in " \t":
            i -= 1
            continue
        if c == ":":
            # colon in a dict/slice literal? -> key/value ends with quote,
            # closer or digit right before the colon
            j = i - 1
            while j >= 0 and line[j] in " \t":
                j -= 1
            if j >= 0 and (line[j] in "\"'" or line[j] in CLOSERS or line[j].isdigit()):
                return False
            return True
        if c == ">":
            return i >= 1 and line[i - 1] == "-"
        if c == "=" or c == "," or c == "(" or c == ";" or c == "{":
            return False
        if c in CLOSERS:          # e.g. default value ] ... not annotation
            op = _match_back(line, i)
            if op < 0:
                return False
            i = op - 1
            continue
        if c.isalnum() or c in "_.\"'":
            # identifier (annotation target) — keep walking? The annotation
            # target itself is left of the colon; reaching an identifier
            # without a colon means expression context (return x | y).
            return False
        return False
    return False


def _convert_chain(parts: list[str]) -> str:
    parts = [p.strip() for p in parts]
    has_none = "None" in parts
    others = [p for p in parts if p != "None"]
    if has_none and len(others) == 1:
        return f"Optional[{others[0]}]"
    if has_none:
        return "Union[" + ", ".join(others + ["None"]) + "]"
    return "Union[" + ", ".join(parts) + "]"


def _convert_quoted(text: str) -> str:
    """'Hub | None' (with quotes) -> 'Optional[Hub]' (quotes kept)."""
    q = text[0]
    inner = text[1:-1]
    if "|" not in inner:
        return text
    chain = _scan_chain(inner, inner.index("|"))
    if not chain:
        return text
    start, end, parts = chain
    return q + _convert_chain(parts) + q


def _scan_chain(line: str, pipe_pos: int):
    """Build the full union chain around pipe_pos -> (start, end, parts) or None."""
    # right side
    r = _atom_right(line, pipe_pos + 1)
    if not r:
        return None
    end, txt = r
    parts = [txt]
    while True:
        skip = end
        while skip < len(line) and line[skip] in " \t":
            skip += 1
        if skip < len(line) and line[skip] == "|":
            r2 = _atom_right(line, skip + 1)
            if not r2:
                break
            end, txt = r2
            parts.append(txt)
        else:
            break
    # left side
    l = _atom_left(line, pipe_pos - 1)
    if not l:
        return None
    start, txt = l
    left_parts = [txt]
    while True:
        skip = start - 1
        while skip >= 0 and line[skip] in " \t":
            skip -= 1
        if skip >= 0 and line[skip] == "|":
            l2 = _atom_left(line, skip - 1)
            if not l2:
                break
            start, txt = l2
            left_parts.insert(0, txt)
        else:
            break
    parts = left_parts + parts
    return (start, end, parts)


def fix_line(line: str) -> str:
    out = line
    # quoted forward-ref unions first ("Hub | None")
    for m in re.finditer(r'"[^"\n]*\|[^"\n]*"', out):
        conv = _convert_quoted(m.group(0))
        if conv != m.group(0):
            out = out[:m.start()] + conv + out[m.end():]
            break
    guard = 0
    while guard < 12:
        guard += 1
        done = True
        for i, c in enumerate(out):
            if c != "|":
                continue
            chain = _scan_chain(out, i)
            if not chain:
                continue
            start, end, parts = chain
            if len(parts) < 2:
                continue
            if not _is_annotation_context(out, start):
                continue
            # skip comments
            hash_pos = out.find("#")
            if 0 <= hash_pos < start:
                continue
            conv = _convert_chain(parts)
            out = out[:start] + conv + out[end:]
            done = False
            break
        if done:
            break
    return out


def ensure_imports(path: pathlib.Path, names: set[str]) -> None:
    if not names:
        return
    src = path.read_text()
    need = sorted(n for n in names if not re.search(rf"\b{n}\b", src.split("def ")[0]))
    if not need:
        return
    lines = src.splitlines(keepends=True)
    # extend an existing single-line typing import?
    for i, ln in enumerate(lines):
        m = re.match(r"from typing import ([^\(\n]+)$", ln)
        if m:
            have = [x.strip() for x in m.group(1).split(",")]
            merged = sorted(set(have) | set(need), key=str.lower)
            lines[i] = "from typing import " + ", ".join(merged) + "\n"
            path.write_text("".join(lines))
            return
    # extend a parenthesised typing import
    for i, ln in enumerate(lines):
        if re.match(r"from typing import \(", ln):
            j = i
            while j < len(lines) and ")" not in lines[j]:
                j += 1
            block = "".join(lines[i:j + 1])
            have = set(re.findall(r"[A-Za-z_]+", block.split("(", 1)[1])) - {"import", "from", "typing"}
            merged = sorted(have | set(need), key=str.lower)
            new = "from typing import (\n" + "".join(f"    {n},\n" for n in merged) + ")\n"
            lines[i:j + 1] = [new]
            path.write_text("".join(lines))
            return
    # no typing import: insert before the first import/from line
    for i, ln in enumerate(lines):
        if ln.startswith("import ") or ln.startswith("from "):
            lines.insert(i, "from typing import " + ", ".join(need) + "\n")
            path.write_text("".join(lines))
            return
    lines.insert(0, "from typing import " + ", ".join(need) + "\n")
    path.write_text("".join(lines))


def main() -> None:
    total = 0
    touched = []
    for p in sorted(ROOT.rglob("*.py")):
        orig = p.read_text()
        out_lines = []
        changed = False
        names: set[str] = set()
        for ln in orig.splitlines(keepends=True):
            nl = fix_line(ln)
            if nl != ln:
                for n in re.findall(r"Optional|Union", nl):
                    names.add(n)
                changed = True
            out_lines.append(nl)
        if changed:
            new = "".join(out_lines)
            if not new.endswith("\n"):
                new += "\n"
            p.write_text(new)
            ensure_imports(p, names)
            touched.append(str(p.relative_to(ROOT.parent)))
            total += len(re.findall(r"Optional\[|Union\[", new)) - len(re.findall(r"Optional\[|Union\[", orig))
    print(f"files changed: {len(touched)}, unions converted: ~{total}")
    for t in touched:
        print("  ", t)


if __name__ == "__main__":
    sys.exit(main())
