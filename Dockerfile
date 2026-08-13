# syntax=docker/dockerfile:1

# ---- Frontend build stage: builds dist/ with a pinned Node toolchain ----
FROM node:22-bookworm-slim AS frontend

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY scripts/ scripts/
COPY src/ src/

RUN npm run build
# dist/ is now at /build/dist

# Default action: copy the build output into a mounted /out directory so the
# repo can regenerate dist/ without depending on the host's Node version.
CMD ["cp", "-r", "/build/dist/.", "/out/"]

# ---- Runtime stage: PySide6 shell that loads the built frontend ----
FROM ubuntu:26.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    libegl1 \
    libgl1 \
    libglib2.0-0 \
    libdbus-1-3 \
    libfontconfig1 \
    libxkbcommon0 \
    libnss3 \
    libnspr4 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libxcb-cursor0 \
    libkrb5-3 \
    libgssapi-krb5-2 \
    libxfixes3 \
    libxtst6 \
    libxkbcommon-x11-0 \
    libxcb-xkb1 \
    libxcb-icccm4 \
    libxcb-shape0 \
    libxcb-keysyms1 \
    libxcb-xinerama0 \
    libxcb-render-util0 \
    libpcsclite1 \
    libpulse0 \
    libwayland-cursor0 \
    libwayland-egl1 \
    libwayland-server0 \
    libxkbfile1 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir -r requirements.txt

COPY --from=frontend /build/dist dist/
COPY backend/ backend/
COPY run_edi.py .
COPY tests/ tests/
COPY scripts/assets/ scripts/assets/

# Run the real app by default: interactive Qt shell over X11. For the
# containerized smoke test (no display needed), override instead:
#   docker run --rm -e QT_QPA_PLATFORM=offscreen -e EDI_SELFTEST=1 edi:latest
ENV QT_QPA_PLATFORM=xcb \
    QTWEBENGINE_DISABLE_SANDBOX=1

CMD [".venv/bin/python", "run_edi.py"]
