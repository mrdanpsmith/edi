"""PyInstaller entry point for the packaged Edi binary."""

from backend.main import main

if __name__ == "__main__":
    raise SystemExit(main())
