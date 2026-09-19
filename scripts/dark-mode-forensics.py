"""Self-guided dark-mode forensics for Edi theme debugging.

Run it and just follow the on-screen prompts: it pauses for you to switch the
theme at the right moments, samples every detection layer during each phase,
then prints a diff showing exactly which setting (if any) changes.

    .venv/bin/python scripts/dark-mode-forensics.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from backend.theme import (
    _probe_appearance,
    _probe_gsettings,
    _probe_gsettings_cli,
    probe_scheme,
)

SCHEMAS = (
    "org.gnome.desktop.interface",
    "org.gnome.shell.ubuntu",
    "org.gnome.settings-daemon.plugins.color",
)


def gsettings_list(schema: str) -> dict[str, str]:
    """Return ``key -> value`` for every setting in ``schema``."""
    gsettings = shutil.which("gsettings")
    if gsettings is None:
        return {}
    # Fixed argv, no shell.
    try:
        result = subprocess.run(  # nosec B603
            [gsettings, "list-recursively", schema],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    out: dict[str, str] = {}
    for line in result.stdout.splitlines():
        parts = line.split(" ", 2)
        if len(parts) == 3:
            out[parts[1]] = parts[2]
    return out


def main() -> int:
    app = QApplication(sys.argv)
    hints = app.styleHints()
    started = time.monotonic()
    signals = []
    hints.colorSchemeChanged.connect(
        lambda scheme: signals.append((time.monotonic(), scheme.name))
    )

    def t() -> float:
        return time.monotonic() - started

    def sample(phase: str) -> dict:
        rec = {
            "phase": phase,
            "t": t(),
            "qt": hints.colorScheme().name,
            "gsettings": {},
            "portal": _probe_appearance(),
            "gsdbus": _probe_gsettings(),
            "gscli": _probe_gsettings_cli(),
            "resolved": probe_scheme(app).name,
        }
        for schema in SCHEMAS:
            for key, value in gsettings_list(schema).items():
                rec["gsettings"].setdefault(key, value)
        return rec

    def capture(seconds: float, phase: str) -> list[dict]:
        end = time.monotonic() + seconds
        records = []
        last_sig = len(signals)
        while True:
            app.processEvents()
            rec = sample(phase)
            new_sigs = signals[last_sig:]
            last_sig = len(signals)
            sig_text = " ".join(f"[{ts - started:4.0f}s signal={name}]" for ts, name in new_sigs)
            gs = rec["gsettings"]
            gs_cli = rec["gscli"]
            print(
                f"[{phase} {t():4.0f}s] Qt={rec['qt']} "
                f"color-scheme={gs.get('color-scheme')!r} "
                f"gtk-theme={gs.get('gtk-theme')!r} "
                f"icon-theme={gs.get('icon-theme')!r} "
                f"prefer-dark={gs.get('gtk-application-prefer-dark-theme')!r} "
                f"portal={rec['portal']!r} gs-dbus={rec['gsdbus']!r} "
                f"gs-cli={gs_cli!r} resolved={rec['resolved']} {sig_text}",
                flush=True,
            )
            records.append(rec)
            if time.monotonic() >= end:
                break
            time.sleep(0.5)
        return records

    print("=" * 72)
    print("EDI DARK-MODE FORENSICS (self-guided)")
    print("=" * 72)
    for var in ("XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "XDG_SESSION_TYPE"):
        print(f"{var}={os.environ.get(var)!r}")
    print(f"DBUS_SESSION_BUS_ADDRESS set = {bool(os.environ.get('DBUS_SESSION_BUS_ADDRESS'))}")
    print()
    how = input("Before we start: how do YOU toggle dark mode? "
                "(e.g. GNOME Settings, an extension, a command)\n> ")
    print()

    input("STEP 1/3  Keep the theme exactly as it is now. Press Enter to sample it (~2s).")
    baseline = capture(2.0, "A-baseline")

    input("\nHEY TOGGLE TO DARK NOW (your usual way). Press Enter when the screen is dark (~5s samples).")
    dark = capture(5.0, "B-dark")

    input("\nHEY TOGGLE BACK TO LIGHT / DEFAULT NOW. Press Enter when it is light again (~3s samples).")
    light = capture(3.0, "C-light")

    print()
    print("=" * 72)
    print("SUMMARY")
    print("=" * 72)
    print(f"dark toggle method: {how}")

    phases = [("A-baseline", baseline), ("B-dark", dark), ("C-light", light)]
    by_key: dict[str, dict[str, str]] = {}
    for phase, records in phases:
        for rec in records:
            for key, value in rec["gsettings"].items():
                by_key.setdefault(key, {})[phase] = value

    changed = {
        key: vals
        for key, vals in by_key.items()
        if len(set(vals.values())) > 1
    }
    if changed:
        print("\ngsettings keys that CHANGED between the phases:")
        for key, vals in sorted(changed.items()):
            print(f"  {key}: A={vals.get('A-baseline')!r} "
                  f"B={vals.get('B-dark')!r} C={vals.get('C-light')!r}")
    else:
        print("\nNo gsettings key in these schemas changed between phases.")
        print("-> Your dark toggle does not write the GNOME settings schemas this")
        print("   script watches (or it writes to gsettings but Qt samples them")
        print("   through a different path).")

    print("\nQt colorSchemeChanged events:")
    for ts, name in signals:
        print(f"  [+{ts - started:5.1f}s] Qt signal -> {name}")

    print("\nresolved scheme the app computes, per phase (first/typical):")
    for phase, records in phases:
        vals = {rec["resolved"] for rec in records}
        print(f"  {phase}: {sorted(vals)}")

    def mode(recs):
        from collections import Counter
        count = Counter(r["gscli"] for r in recs)
        return count.most_common(1)[0]

    print(
        "\nverdict guess: "
        + (
            "dark toggle PROBABLY writes gsettings -> app should read it; "
            "the packager env is the suspect."
            if changed
            else "dark state lives outside these gsettings schemas; "
                 "need the key/source it actually writes."
        )
    )
    print("\nDone. Paste everything above.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted. Paste everything above.")
        raise SystemExit(0)