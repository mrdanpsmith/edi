"""PyInstaller entry point for the packaged Edi binary.

Under EDI_SELFTEST (packaged-binary smoke test) the import of backend.main can
die inside QtWebEngine's DLL loading before any of our code runs; when that
happens print a DLL inventory of the extracted bundle so the CI job log says
exactly which Qt companion library is missing/junk.
"""

import os
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
    raise

if __name__ == "__main__":
    raise SystemExit(main())