"""PyInstaller entry point for the packaged Edi binary.

Under EDI_SELFTEST (packaged-binary smoke test) the import of backend.main can
die inside QtWebEngine's DLL loading before any of our code runs; when that
happens print a DLL inventory of the extracted bundle plus a PE import-table
lint of the Qt module that failed, so the CI job log states exactly which
library is missing and where the loader should have found it.
"""

import os
import struct
import sys

_QT_COMPANION_DLLS = (
    "Qt6Core.dll",
    "Qt6Gui.dll",
    "Qt6Network.dll",
    "Qt6Positioning.dll",
    "Qt6PrintSupport.dll",
    "Qt6Qml.dll",
    "Qt6QmlModels.dll",
    "Qt6Quick.dll",
    "Qt6QuickWidgets.dll",
    "Qt6WebChannel.dll",
    "Qt6WebEngineCore.dll",
    "Qt6WebEngineWidgets.dll",
    "Qt6Pdf.dll",
    "Qt6PdfWidgets.dll",
    "Qt6NetworkAuth.dll",
)

# The Qt module the app imports first; anything further up the chain is already
# loadable by the time we get here. Lint this one (or the first Qt6 core module
# we can actually find) so every static import is accounted for.
_LINT_MODULES = (
    "Qt6WebEngineCore.dll",
    "Qt6WebChannel.dll",
    "Qt6Network.dll",
    "Qt6Quick.dll",
    "Qt6Qml.dll",
    "Qt6Widgets.dll",
    "Qt6Gui.dll",
    "Qt6Core.dll",
)


def _pe_imports(path: str):
    """Return the static import-table module names of a PE file (pure stdlib)."""
    with open(path, "rb") as fh:
        data = fh.read()
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        return None
    coff = e_lfanew + 4
    num_sections = struct.unpack_from("<H", data, coff + 2)[0]
    opt_size = struct.unpack_from("<H", data, coff + 16)[0]
    opt = coff + 20
    is_pe32p = struct.unpack_from("<H", data, opt)[0] == 0x20B
    dd = opt + (112 if is_pe32p else 96)
    import_rva = struct.unpack_from("<I", data, dd + 1 * 8)[0]
    if not import_rva:
        return None
    sections = []
    sec0 = opt + opt_size
    for i in range(num_sections):
        sec = data[sec0 + i * 40 : sec0 + (i + 1) * 40]
        vsize, vaddr, rsize, rptr = struct.unpack_from("<IIII", sec, 8)
        sections.append((vaddr, vsize, rptr, rsize))

    def raw(rva):
        for vaddr, vsize, rptr, rsize in sections:
            if rptr and vaddr <= rva < vaddr + vsize:
                return rptr + (rva - vaddr)
        return None

    def cstr(rva):
        o = raw(rva)
        if o is None:
            return None
        end = data.find(b"\x00", o)
        return data[o:end].decode("latin1")

    names = []
    o = raw(import_rva)
    while o is not None and o + 20 <= len(data):
        fields = struct.unpack_from("<IIIII", data, o)
        if not any(fields):
            break
        name = cstr(fields[3])
        if name:
            names.append(name)
        o += 20
    return names


def _dump_import_lint() -> None:
    """Cross-check every static import of the failing Qt module against the
    bundle and C:\\Windows\\System32 so a load failure names its cause."""
    import glob as _glob

    base = getattr(sys, "_MEIPASS", None)
    if not base:
        return
    target = None
    for module in _LINT_MODULES:
        hits = _glob.glob(os.path.join(base, "**", module), recursive=True)
        if hits:
            target = hits[0]
            break
    if not target:
        print("[selftest] import-lint: no lintable Qt module in the bundle",
              file=sys.stderr, flush=True)
        return
    print(f"[selftest] import-lint of {os.path.relpath(target, base)}",
          file=sys.stderr, flush=True)
    imports = _pe_imports(target) or []
    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    sys32 = os.path.join(sysroot, "System32")
    bundle_names = {
        os.path.basename(p).lower()
        for p in _glob.glob(os.path.join(base, "**", "*.*"), recursive=True)
    }
    for imp in imports:
        low = imp.lower()
        if low in bundle_names:
            print(f"[selftest]   OK  {imp} -> bundle", file=sys.stderr, flush=True)
        elif os.path.isfile(os.path.join(sys32, imp)):
            print(f"[selftest]   OK  {imp} -> System32 ({sys32})",
                  file=sys.stderr, flush=True)
        else:
            print(f"[selftest]   MISSING {imp} (not in bundle or System32)",
                  file=sys.stderr, flush=True)


def _dump_dll_inventory() -> None:
    import glob as _glob

    base = getattr(sys, "_MEIPASS", None)
    if not base:
        return
    print(f"[selftest] _MEIPASS={base}", file=sys.stderr, flush=True)
    for name in _QT_COMPANION_DLLS:
        hits = _glob.glob(os.path.join(base, "**", name), recursive=True)
        if hits:
            rel = os.path.relpath(hits[0], base)
            print(f"[selftest]  present {name} -> {rel}", file=sys.stderr, flush=True)
        else:
            print(f"[selftest]  ABSENT  {name} (not anywhere in the bundle)",
                  file=sys.stderr, flush=True)
    qt_dlls = sorted(_glob.glob(os.path.join(base, "**", "Qt6*.dll"), recursive=True))
    print(f"[selftest] Qt6 DLLs bundled: {len(qt_dlls)}", file=sys.stderr, flush=True)
    for p in qt_dlls:
        print(f"[selftest]   {os.path.relpath(p, base)}", file=sys.stderr, flush=True)
    present = sorted(os.listdir(base)) if os.path.isdir(base) else []
    top_dlls = [n for n in present if n.lower().endswith(".dll")]
    print(f"[selftest] {len(present)} entries at bundle root; {len(top_dlls)} DLLs:",
          file=sys.stderr, flush=True)
    print("  " + ", ".join(sorted(top_dlls)), file=sys.stderr, flush=True)


try:
    from backend.main import main
except Exception:
    if os.environ.get("EDI_SELFTEST"):
        _dump_dll_inventory()
        _dump_import_lint()
    raise

if __name__ == "__main__":
    raise SystemExit(main())