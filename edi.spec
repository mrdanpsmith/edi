# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for Edi. The Analysis block is shared across platforms; the
# binary-packing filters and the EXE/BUNDLE step are per-platform (PyInstaller
# cannot cross-compile; build each OS's bundle on that OS).
#
# -- Linux (see Dockerfile.pyzip) -------------------------------------------
#
# libstdc++.so.6 and libgbm.so.1 are intentionally NOT bundled: the copies from
# the Ubuntu 22.04 builder are older than the ones on newer desktops, and
# bundling them makes host Mesa/LLVM fail during dlopen -- libstdc++ with
# "GLIBCXX_x.y.z not found", and libgbm (Mesa's buffer manager) with
# "did not find extension DRI_Mesa version 1" / "EGL: Failed to initialize GBM
# device" in QtWebEngine's GPU process. The host always ships its own
# libstdc++/libgbm (glibc 2.35+ systems, plus the libgbm1 package dependency),
# so relying on them is safe.
#
# PySide6.QtQml and PySide6.QtQuick are excluded on every platform: Edi uses
# only the QtWebEngine *widgets* API (QWebEngineView/Page), never the QML API.
# QtWebEngineCore links against libQt6Qml/libQt6Quick (so those shared libs are
# still pulled in by PyInstaller's binary dependency analysis), but the Python
# modules would fire hook-PySide6.QtQml, whose collect_qtqml_files() drags in
# the ENTIRE qml/ tree (~4850 plugin files) plus every Qt library those plugins
# reference (Qt3D, QtQuick3D, QtCharts, QtGraphs, QtVirtualKeyboard, ...).
# Excluding them keeps the bundle to what WebEngine actually needs (roughly
# -120 MB smaller).
#
# The onefile CArchive packs at zlib level 1 instead of the default 9 (see
# PYINSTALLER_ZLIB_COMPRESSION_LEVEL in Dockerfile.pyzip / CI). Build time for
# the pack step is ~3x lower for a negligible size change.

import re
import sys

a = Analysis(
    ['run_edi.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('dist', 'dist'),
        ('backend/qwebchannel.js', 'backend'),
        ('scripts/assets/app-icon.png', 'assets'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PySide6.QtQml', 'PySide6.QtQuick'],
    noarchive=False,
)

if sys.platform == 'linux':
    # Linux-only: shared-library filtering does not make sense on Windows/macOS
    # bundling (the matches are ELF sonames).
    GL_HOST_DEPS = {'libstdc++.so.6', 'libgbm.so.1'}
    a.binaries = [b for b in a.binaries if b[0] not in GL_HOST_DEPS]

    # Edi never uses the on-screen virtual keyboard; drop its input-context
    # plugin, which would otherwise drag in libQt6VirtualKeyboard and
    # libQt6VirtualKeyboardQml.
    QT_DEAD_PREFIXES = (
        'PySide6/Qt/plugins/platforminputcontexts/libqtvirtualkeyboard',
        'PySide6/Qt/lib/libQt6VirtualKeyboard',
        'libQt6VirtualKeyboard',
    )
    a.binaries = [b for b in a.binaries if not b[0].startswith(QT_DEAD_PREFIXES)]

pyz = PYZ(a.pure)

# Version for the Windows version resource and the macOS Info.plist, read from
# backend/__init__.py at spec-evaluation time so it cannot drift from the tag.
_VERSION_STR = None
if sys.platform in ('win32', 'darwin'):
    with open('backend/__init__.py', encoding='utf-8') as fh:
        _m = re.search(r'__version__ = "([^"]+)"', fh.read())
    _VERSION_STR = _m.group(1) if _m else None

if sys.platform == 'win32':
    from PyInstaller.utils.win32.versioninfo import (
        FixedFileInfo,
        StringFileInfo,
        StringStruct,
        StringTable,
        VarFileInfo,
        VarStruct,
        VSVersionInfo,
    )

    _v4 = (*map(int, (_VERSION_STR or '0.0.0').split('.')), 0, 0, 0, 0)[:4]

    vs_version_info = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=_v4,
            prodvers=_v4,
            mask=0x3F,
            flags=0x0,
            OS=0x40004,
            fileType=0x1,
            subtype=0x0,
            date=(0, 0),
        ),
        kids=[
            StringFileInfo(
                [
                    StringTable(
                        '040904B0',
                        [
                            StringStruct('CompanyName', 'Edi'),
                            StringStruct('FileDescription', 'Edi'),
                            StringStruct('FileVersion', _VERSION_STR or '0.0.0'),
                            StringStruct('InternalName', 'Edi'),
                            StringStruct('OriginalFilename', 'Edi.exe'),
                            StringStruct('ProductName', 'Edi'),
                            StringStruct('ProductVersion', _VERSION_STR or '0.0.0'),
                        ],
                    )
                ]
            ),
            VarFileInfo([VarStruct('Translation', [1033, 1200])]),
        ],
    )

    # QtWebEngineCore.dll's Qt dependencies are resolved on Linux via ELF
    # DT_NEEDED (which PyInstaller's binary analysis follows) but on Windows are
    # imported by Qt6WebEngineCore.dll in a way the import-table analysis misses
    # (delay-load / versioned imports). A packaged run then dies at
    # `import QtWebEngineCore` with "DLL load failed ... could not be found" even
    # though extraction succeeded. Explicitly bundle the companion set into
    # PySide6/ (deduped against what the Analysis already collected).
    import os as _os

    _pyside_dir = _os.path.dirname(__import__('PySide6').__file__)
    _webengine_companions = (
        'Qt6WebEngineCore.dll',
        'Qt6WebEngineWidgets.dll',
        'Qt6Network.dll',
        'Qt6Positioning.dll',
        'Qt6PrintSupport.dll',
        'Qt6Qml.dll',
        'Qt6QmlModels.dll',
        'Qt6QmlWorkerscript.dll',
        'Qt6Quick.dll',
        'Qt6QuickWidgets.dll',
        'Qt6WebChannel.dll',
    )
    _collected_dests = {b[0].lower() for b in a.binaries}
    for _dll in _webengine_companions:
        _dll_src = _os.path.join(_pyside_dir, _dll)
        _dest = 'PySide6/' + _dll
        if _os.path.isfile(_dll_src) and _dest.lower() not in _collected_dests:
            a.binaries.append((_dest, _dll_src, 'BINARY'))

    # Qt6Core.dll hard-imports icuuc.dll / icuin.dll (Windows' system ICU).
    # Build hosts that lack System32 ICU (Wine, Server SKUs) have those staged
    # next to Qt6Core.dll by the build script so the Qt metadata probe and the
    # import-table analysis can resolve them; bundle them so the exe also boots
    # on any no-ICU Windows. Deduped like the companion set above.
    _icu_srcs = ['icu.dll', 'icuuc.dll', 'icuin.dll']
    for _icu in _icu_srcs:
        _icu_src = _os.path.join(_pyside_dir, _icu)
        _dest = 'PySide6/' + _icu
        if _os.path.isfile(_icu_src) and _dest.lower() not in _collected_dests:
            a.binaries.append((_dest, _icu_src, 'BINARY'))

    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='Edi',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon='scripts/assets/app-icon.ico',
        version=vs_version_info,
    )

    # Console-bootloader twin (not shipped): runw.exe swallows the onefile
    # bootloader's fatal messages into an invisible dialog and returns only an
    # exit code (-1 = Z_ERRNO, a failed fwrite while self-extracting to
    # %TEMP%\_MEI*). build-windows.ps1 smoke-tests run.exe so the actual
    # "Error extracting <entry>: <errno>" line lands in the CI log instead of
    # being lost. Shares pyz/a so this is just a second ~25s PKG pack.
    selftest_exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='Edi-selftest',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon='scripts/assets/app-icon.ico',
        version=vs_version_info,
    )

elif sys.platform == 'darwin':
    from pathlib import Path

    _icns = Path('scripts/assets/app-icon.icns')
    if not _icns.is_file():
        raise SystemExit('error: scripts/assets/app-icon.icns missing; run node scripts/generate-icon.mjs')

    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='Edi',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=str(_icns),
    )

    app = BUNDLE(
        exe,
        name='Edi.app',
        icon=str(_icns),
        bundle_identifier='com.mrdanpsmith.edi',
        info_plist={
            'CFBundleName': 'Edi',
            'CFBundleDisplayName': 'Edi',
            'CFBundleShortVersionString': _VERSION_STR or '0.0.0',
            'CFBundleVersion': _VERSION_STR or '0.0.0',
            'LSMinimumSystemVersion': '11.0',
            'NSHighResolutionCapable': True,
            'CFBundleDevelopmentRegion': 'en',
        },
    )

else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='edi',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )