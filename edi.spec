# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the portable onefile Edi build (see Dockerfile.pyzip).
#
# libstdc++.so.6 is intentionally NOT bundled: the copy from the Ubuntu 22.04
# builder is older than the one on newer desktops, and bundling it makes host
# GPU/driver libraries (libLLVM, radeonsi, mesa EGL) fail to load with
# "GLIBCXX_x.y.z not found" during dlopen. The host's libstdc++ is always >=
# the 22.04 one, so relying on it is safe for glibc 2.35+ systems.

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
    excludes=[],
    noarchive=False,
)

a.binaries = [b for b in a.binaries if b[0] != 'libstdc++.so.6']

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
