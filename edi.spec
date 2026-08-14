# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the portable onefile Edi build (see Dockerfile.pyzip).
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
# PySide6.QtQml and PySide6.QtQuick are excluded: Edi uses only the QtWebEngine
# *widgets* API (QWebEngineView/Page), never the QML API. QtWebEngineCore links
# against libQt6Qml/libQt6Quick (so those shared libs are still pulled in by
# PyInstaller's binary dependency analysis), but the Python modules would fire
# hook-PySide6.QtQml, whose collect_qtqml_files() drags in the ENTIRE qml/ tree
# (~4850 plugin files) plus every Qt library those plugins reference (Qt3D,
# QtQuick3D, QtCharts, QtGraphs, QtVirtualKeyboard, ...). Excluding them keeps
# the bundle to what WebEngine actually needs (roughly -120 MB smaller).
#
# The onefile CArchive packs at zlib level 6 instead of the default 9 (see
# PYINSTALLER_ZLIB_COMPRESSION_LEVEL in Dockerfile.pyzip / CI). Build time for
# the pack step is ~3x lower for a negligible size change.

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

GL_HOST_DEPS = {'libstdc++.so.6', 'libgbm.so.1'}
a.binaries = [b for b in a.binaries if b[0] not in GL_HOST_DEPS]

# Edi never uses the on-screen virtual keyboard; drop its input-context plugin,
# which would otherwise drag in libQt6VirtualKeyboard and libQt6VirtualKeyboardQml.
QT_DEAD_PREFIXES = (
    'PySide6/Qt/plugins/platforminputcontexts/libqtvirtualkeyboard',
    'PySide6/Qt/lib/libQt6VirtualKeyboard',
    'libQt6VirtualKeyboard',
)
a.binaries = [b for b in a.binaries if not b[0].startswith(QT_DEAD_PREFIXES)]

pyz = PYZ(a.pure)

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
