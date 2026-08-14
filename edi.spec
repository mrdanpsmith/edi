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

a = Analysis(
    ['run_edi.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('dist', 'dist'),
        ('backend/qwebchannel.js', 'backend'),
        ('scripts/assets/app-icon.png', 'assets'),
        ('assets/edi-logo.png', 'assets'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

GL_HOST_DEPS = {'libstdc++.so.6', 'libgbm.so.1'}
a.binaries = [b for b in a.binaries if b[0] not in GL_HOST_DEPS]

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
