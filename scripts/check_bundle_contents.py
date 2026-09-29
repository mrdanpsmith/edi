"""Structural bundle check for the Windows onefile: are the Qt plugins and the
ICU DLLs actually inside the CArchive?

This is the load-bearing regression gate for the pluginless-bundle defect: the
Qt hooks stop collecting `platforms/`, `imageformats/` and friends, PyInstaller
reports success, the .exe is produced, and the only symptom is a crash on a
machine that lacks the DLLs. It has to be a separate check from the frozen
smoke because the smoke can be SKIPPED as environmental (a host that cannot
import QtWebEngineCore, or Wine's Chromium) -- and on exactly those hosts the
smoke proves nothing about the bundle, so this is what still has to run.

CArchiveReader is pure stdlib + PyInstaller, so this reads the .exe directly:
no render, no X display, no working GPU. It therefore works identically on
real Windows and under Wine, which is why both build paths call this one file
rather than each carrying its own copy of the required-entry list.

Usage: check_bundle_contents.py <path-to-onefile.exe>
Exits non-zero (and prints BUNDLE_MISSING) if anything required is absent.
"""

import sys

from PyInstaller.archive.readers import CArchiveReader

# Lowercased, '/' -separated. The list is deliberately narrow and specific:
# qwindows is the real platform plugin, qoffscreen is what the CI smoke runs
# under, qjpeg is a cheap proof that imageformats/ was collected at all (a
# whole directory rather than one file), and the two ICU DLLs are the ones
# forced into the bundle by edi.spec's win32 branch so the exe boots on a
# Windows with no system ICU.
REQUIRED = (
    'pyside6/plugins/platforms/qwindows.dll',
    'pyside6/plugins/platforms/qoffscreen.dll',
    'pyside6/plugins/imageformats/qjpeg.dll',
    'pyside6/icuuc.dll',
    'pyside6/icuin.dll',
)


def main() -> int:
    if len(sys.argv) != 2:
        print('usage: check_bundle_contents.py <onefile.exe>')
        return 2

    archive = CArchiveReader(sys.argv[1])
    names = {n.lower().replace('\\', '/') for n in archive.toc}
    missing = [want for want in REQUIRED if want not in names]

    if missing:
        print('BUNDLE_MISSING total=%d missing=%r' % (len(names), missing))
        return 1

    print('BUNDLE_OK total=%d (platform plugins, imageformats, ICU all present)' % len(names))
    return 0


if __name__ == '__main__':
    sys.exit(main())
