"""Parse CSV / ODS / XLSX spreadsheets into rows of cell text.

Used by the "Insert → Spreadsheet" feature: the frontend picks a file, the
backend parses it on a worker thread, and the rows are turned into a markdown
table in the page.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from pathlib import Path
from defusedxml import ElementTree

ODS_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}

XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

# Cap repeated-row/column expansion so a crafted file cannot balloon memory.
_MAX_REPEAT = 1000
# Cap where an XLSX cell may say it is (`r="ZZZZZZ1"`, a row a million down):
# the gap before it is filled with empty cells, so an uncapped position is an
# allocation the file chooses. Cells and rows past these are not imported.
_MAX_COLUMNS = 1000
_MAX_ROWS = 10000

XLSX_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

SUPPORTED_TABLE_EXTENSIONS = (".csv", ".tsv", ".txt", ".ods", ".xlsx", ".xlsm")


def parse_table_file(path: str) -> dict:
    """Parse a spreadsheet file into ``{"name": str, "rows": [[str]]}``."""
    suffix = Path(path).suffix.lower()
    if suffix == ".ods":
        rows, sheet = _parse_ods(path)
    elif suffix in (".xlsx", ".xlsm"):
        rows, sheet = _parse_xlsx(path)
    elif suffix in (".csv", ".tsv", ".txt"):
        rows = _parse_delimited(path)
        sheet = ""
    else:
        raise ValueError(f"Unsupported spreadsheet extension: {suffix or '(none)'}")
    name = sheet or Path(path).stem
    return {"name": name, "rows": _trim_rows(rows)}


def _parse_delimited(path: str) -> list[list[str]]:
    raw = Path(path).read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    delimiter = _detect_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    return [row for row in reader]


def _detect_delimiter(text: str) -> str:
    candidates = (",", ";", "\t")
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        counts = {candidate: stripped.count(candidate) for candidate in candidates}
        best = max(candidates, key=counts.__getitem__)
        return best
    return ","


def _parse_ods(path: str) -> tuple[list[list[str]], str]:
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("content.xml"))
    tables = root.findall(".//table:table", ODS_NS)
    if not tables:
        return [], ""
    table = tables[0]
    sheet = table.get(f"{{{ODS_NS['table']}}}name") or ""
    rows: list[list[str]] = []
    for row_el in table.findall("table:table-row", ODS_NS):
        cells = _ods_row_cells(row_el)
        repeat = _repeat_count(row_el, "number-rows-repeated")
        rows.extend([list(cells) for _ in range(repeat)])
    return rows, sheet


def _ods_row_cells(row_el) -> list[str]:
    cells: list[str] = []
    for cell_el in row_el:
        if _local_name(cell_el.tag) not in ("table-cell", "covered-table-cell"):
            continue
        value = _ods_cell_value(cell_el)
        repeat = _repeat_count(cell_el, "number-columns-repeated")
        cells.extend([value] * repeat)
    return cells


def _ods_text(element) -> str:
    """All the text of an ODS paragraph, not just what precedes its first child.

    A paragraph's text is split across `<text:span>`s, links and the like, and
    runs of spaces, tabs and breaks are elements of their own (`<text:s
    text:c="3"/>`), so `element.text` alone dropped everything after the first
    formatted run.
    """
    out = element.text or ""
    for child in element:
        name = _local_name(child.tag)
        if name == "s":
            raw = child.get(f"{{{ODS_NS['text']}}}c")
            out += " " * (min(int(raw), _MAX_REPEAT) if raw and raw.isdigit() else 1)
        elif name == "tab":
            out += "\t"
        elif name == "line-break":
            out += "\n"
        else:
            out += _ods_text(child)
        out += child.tail or ""
    return out


def _ods_cell_value(cell_el) -> str:
    texts = [_ods_text(part) for part in cell_el.findall("text:p", ODS_NS)]
    if texts:
        return "\n".join(texts).strip()
    value_type = cell_el.get(f"{{{ODS_NS['office']}}}value-type")
    if value_type == "string":
        value = cell_el.get(f"{{{ODS_NS['office']}}}string-value")
        return value.strip() if value is not None else ""
    if value_type is not None:
        value = cell_el.get(f"{{{ODS_NS['office']}}}value")
        return value.strip() if value is not None else ""
    return ""


def _parse_xlsx(path: str) -> tuple[list[list[str]], str]:
    with zipfile.ZipFile(path) as archive:
        shared = _xlsx_shared_strings(archive)
        sheet = _xlsx_first_sheet_name(archive)
        sheet_path = _xlsx_first_sheet_path(archive)
        if sheet_path is None:
            return [], sheet
        rows = _xlsx_sheet_rows(archive.read(sheet_path), shared)
    return rows, sheet


def _xlsx_shared_strings(archive) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    strings: list[str] = []
    for si in root.findall(f"{{{XLSX_NS}}}si"):
        parts = [t.text or "" for t in si.iter(f"{{{XLSX_NS}}}t")]
        strings.append("".join(parts))
    return strings


def _xlsx_first_sheet_name(archive) -> str:
    if "xl/workbook.xml" not in archive.namelist():
        return ""
    root = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    sheets = root.findall(f"{{{XLSX_NS}}}sheets/{{{XLSX_NS}}}sheet")
    return sheets[0].get("name") or "" if sheets else ""


def _xlsx_first_sheet_path(archive) -> str | None:
    """The part holding the workbook's first sheet.

    The workbook lists its sheets in tab order and names each one's part through
    its relationships; file names say nothing about order (`sheet10.xml` sorts
    before `sheet2.xml`, and a reordered workbook keeps its old names). The
    sorted file names are only the fallback for an archive without that wiring.
    """
    names = archive.namelist()
    if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        first = workbook.find(f"{{{XLSX_NS}}}sheets/{{{XLSX_NS}}}sheet")
        rel_id = first.get(f"{{{XLSX_REL_NS}}}id") if first is not None else None
        rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        for rel in rels.findall(f"{{{PACKAGE_REL_NS}}}Relationship"):
            if rel_id is None or rel.get("Id") != rel_id:
                continue
            target = (rel.get("Target") or "").lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            if path in names:
                return path
    sheets = sorted(
        (name for name in names if name.startswith("xl/worksheets/") and name.endswith(".xml")),
        key=_natural_key,
    )
    return sheets[0] if sheets else None


def _natural_key(name: str) -> list:
    """Sort `sheet2` before `sheet10`."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


def _xlsx_sheet_rows(sheet_xml: bytes, shared: list[str]) -> list[list[str]]:
    root = ElementTree.fromstring(sheet_xml)
    sheet_data = root.find(f"{{{XLSX_NS}}}sheetData")
    if sheet_data is None:
        return []
    rows: list[list[str]] = []
    for row_el in sheet_data.findall(f"{{{XLSX_NS}}}row"):
        # A sheet only stores rows that hold something: `r` says which row this
        # is, and the empty rows before it are part of the table.
        row_number = _xlsx_row_number(row_el.get("r"), len(rows) + 1)
        if row_number > _MAX_ROWS:
            break
        while len(rows) < row_number - 1:
            rows.append([])
        row: list[str] = []
        col = 1
        for cell_el in row_el.findall(f"{{{XLSX_NS}}}c"):
            cell_col = _xlsx_cell_col(cell_el.get("r") or "")
            if cell_col > _MAX_COLUMNS:
                break
            while col < cell_col:
                row.append("")
                col += 1
            row.append(_xlsx_cell_value(cell_el, shared))
            col += 1
        rows.append(row)
    return rows


def _xlsx_row_number(raw: str | None, default: int) -> int:
    """The 1-based row a `<row r=…>` names; rows without one follow the last."""
    return int(raw) if raw and raw.isdigit() and int(raw) >= default else default


def _xlsx_cell_value(cell_el, shared: list[str]) -> str:
    cell_type = cell_el.get("t")
    v_el = cell_el.find(f"{{{XLSX_NS}}}v")
    raw = v_el.text if v_el is not None else ""
    if cell_type == "s" and raw.isdigit() and int(raw) < len(shared):
        return shared[int(raw)]
    if cell_type == "inlineStr":
        is_el = cell_el.find(f"{{{XLSX_NS}}}is")
        if is_el is not None:
            return "".join(t.text or "" for t in is_el.iter(f"{{{XLSX_NS}}}t"))
        return ""
    return raw.strip()


def _xlsx_cell_col(ref: str) -> int:
    letters = "".join(char for char in ref if char.isalpha())
    if not letters:
        return 0
    col = 0
    for char in letters.upper():
        col = col * 26 + (ord(char) - 64)
        if col > _MAX_COLUMNS:
            return _MAX_COLUMNS + 1
    return col


def _repeat_count(element, attribute: str) -> int:
    raw = element.get(f"{{{ODS_NS['table']}}}{attribute}")
    try:
        return min(max(int(raw), 1), _MAX_REPEAT)
    except (TypeError, ValueError):
        return 1


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _trim_rows(rows: list[list[str]]) -> list[list[str]]:
    while rows and all(cell == "" for cell in rows[-1]):
        rows.pop()
    trimmed = [_trim_cells(row) for row in rows]
    while trimmed and not trimmed[-1]:
        trimmed.pop()
    return trimmed


def _trim_cells(row: list[str]) -> list[str]:
    while row and row[-1] == "":
        row.pop()
    return row
