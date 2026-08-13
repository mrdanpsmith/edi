"""Tests for spreadsheet import parsing (CSV / ODS / XLSX)."""

from __future__ import annotations

import io
import zipfile

from backend.tables import parse_table_file

import pytest

ODS_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
)

XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _ods_bytes(table_rows: list[list[tuple[str, str, int]]], sheet: str = "Sheet1") -> bytes:
    """Build an ODS archive.

    Each cell is ``(value_type, value, repeat)``; repeat expands
    ``table:number-columns-repeated`` / ``table:number-rows-repeated``.
    """
    row_xml: list[str] = []
    for row in table_rows:
        row_xml.append("<table:table-row>")
        for value_type, value, repeat in row:
            attrs = f'office:value-type="{value_type}"'
            if value_type != "string":
                attrs += f' office:value="{value}"'
            if repeat > 1:
                attrs += f' table:number-columns-repeated="{repeat}"'
            row_xml.append(f'<table:table-cell {attrs}><text:p>{value}</text:p></table:table-cell>')
        row_xml.append("</table:table-row>")
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<office:document-content {ODS_NS}>'
        "<office:body><office:spreadsheet>"
        f'<table:table table:name="{sheet}">{"".join(row_xml)}</table:table>'
        "</office:spreadsheet></office:body>"
        "</office:document-content>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
        archive.writestr("content.xml", content)
    return buffer.getvalue()


def _xlsx_bytes(
    rows: list[list[tuple[str, str, str]]],
    sheet: str = "Data",
    shared: list[str] | None = None,
) -> bytes:
    """Build an XLSX archive.

    Each cell is ``(ref, t, value)``; ``t`` is the ``<c t=...>`` type (empty
    for numbers). If ``shared`` is given, cells with ``t="s"`` index into it.
    """
    row_xml: list[str] = []
    for row in rows:
        cells = "".join(_xlsx_cell_xml(ref, t, value) for ref, t, value in row)
        row_xml.append(f"<row>{cells}</row>")
    sheet_xml = (
        f'<worksheet xmlns="{XLSX_NS}">'
        f"<sheetData>{''.join(row_xml)}</sheetData>"
        "</worksheet>"
    )
    shared_xml = ""
    if shared:
        items = "".join(f"<si><t>{text}</t></si>" for text in shared)
        shared_xml = f'<sst xmlns="{XLSX_NS}">{items}</sst>'
    workbook_xml = (
        f'<workbook xmlns="{XLSX_NS}"><sheets>'
        f'<sheet name="{sheet}" sheetId="1"/></sheets></workbook>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook_xml)
        if shared_xml:
            archive.writestr("xl/sharedStrings.xml", shared_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return buffer.getvalue()


def _xlsx_cell_xml(ref: str, t: str, value: str) -> str:
    if t == "inlineStr":
        return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'
    inner = f"<v>{value}</v>"
    attr = f' t="{t}"' if t else ""
    return f'<c r="{ref}"{attr}>{inner}</c>'


def test_csv_basic(tmp_path):
    target = tmp_path / "data.csv"
    target.write_text("name,value\napple,3\npear,7\n", encoding="utf-8")
    result = parse_table_file(str(target))
    assert result["name"] == "data"
    assert result["rows"] == [["name", "value"], ["apple", "3"], ["pear", "7"]]


def test_csv_quoted_cells_and_delimiter(tmp_path):
    target = tmp_path / "quoted.tsv"
    target.write_text("name\tnotes\na\t\"has, comma\"\nb\t\"quoted \"\"word\"\"\"\n", encoding="utf-8")
    result = parse_table_file(str(target))
    assert result["rows"] == [["name", "notes"], ["a", "has, comma"], ["b", 'quoted "word"']]


def test_csv_semicolon_detected(tmp_path):
    target = tmp_path / "semi.csv"
    target.write_text("a;b;c\n1;2;3\n", encoding="utf-8")
    assert parse_table_file(str(target))["rows"] == [["a", "b", "c"], ["1", "2", "3"]]


def test_csv_latin1_fallback(tmp_path):
    target = tmp_path / "latin.csv"
    target.write_bytes("name,caf\xe9\ncaf\xe9,5\n".encode("latin-1"))
    assert parse_table_file(str(target))["rows"] == [["name", "café"], ["café", "5"]]


def test_csv_trims_trailing_empty_rows(tmp_path):
    target = tmp_path / "trail.csv"
    target.write_text("a,b\n1,2\n\n\n", encoding="utf-8")
    assert parse_table_file(str(target))["rows"] == [["a", "b"], ["1", "2"]]


def test_ods_basic(tmp_path):
    target = tmp_path / "sheet.ods"
    target.write_bytes(
        _ods_bytes(
            [
                [("string", "Item", 1), ("string", "Qty", 1)],
                [("string", "Widget", 1), ("float", "12", 1)],
                [("string", "Gadget", 1), ("float", "7.5", 1)],
            ],
            sheet="Inventory",
        )
    )
    result = parse_table_file(str(target))
    assert result["name"] == "Inventory"
    assert result["rows"] == [["Item", "Qty"], ["Widget", "12"], ["Gadget", "7.5"]]


def test_ods_repeated_rows_and_columns(tmp_path):
    target = tmp_path / "repeat.ods"
    target.write_bytes(
        _ods_bytes(
            [
                [("string", "x", 3)],
                [("string", "y", 1), ("string", "z", 2)],
            ]
        )
    )
    assert parse_table_file(str(target))["rows"] == [["x", "x", "x"], ["y", "z", "z"]]


def test_ods_numeric_cell_without_text(tmp_path):
    target = tmp_path / "num.ods"
    target.write_bytes(_ods_bytes([[("float", "42", 1), ("string", "label", 1)]]))
    assert parse_table_file(str(target))["rows"] == [["42", "label"]]


def test_xlsx_shared_strings(tmp_path):
    target = tmp_path / "shared.xlsx"
    target.write_bytes(
        _xlsx_bytes(
            [
                [("A1", "s", "0"), ("B1", "s", "1")],
                [("A2", "", "10"), ("B2", "s", "2")],
            ],
            sheet="Orders",
            shared=["item", "qty", "widget"],
        )
    )
    result = parse_table_file(str(target))
    assert result["name"] == "Orders"
    assert result["rows"] == [["item", "qty"], ["10", "widget"]]


def test_xlsx_inline_string_and_formula_result(tmp_path):
    target = tmp_path / "mixed.xlsx"
    target.write_bytes(
        _xlsx_bytes(
            [
                [("A1", "inlineStr", "inline text"), ("B1", "str", "=SUM(1,2)")],
            ]
        )
    )
    rows = parse_table_file(str(target))["rows"]
    assert rows == [["inline text", "=SUM(1,2)"]]


def test_xlsx_column_gaps(tmp_path):
    target = tmp_path / "gaps.xlsx"
    target.write_bytes(
        _xlsx_bytes(
            [
                [("A1", "", "1"), ("D1", "", "4")],
            ]
        )
    )
    assert parse_table_file(str(target))["rows"] == [["1", "", "", "4"]]


def test_unsupported_extension(tmp_path):
    target = tmp_path / "notes.doc"
    target.write_text("hello", encoding="utf-8")
    with pytest.raises(ValueError, match="Unsupported spreadsheet extension"):
        parse_table_file(str(target))


def test_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        parse_table_file(str(tmp_path / "nope.csv"))
