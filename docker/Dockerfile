# ── Stage 1: Build React frontend ──────────────────────────────────────────────
FROM node:18-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build
# Output: /app/frontend/dist/

# ── Stage 2: Python backend + bundled frontend ─────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# System dependencies (gcc for some Python packages)
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python backend
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e ./backend/

# Copy compiled frontend into /app/static/ — FastAPI serves it from there
COPY --from=frontend-builder /app/frontend/dist ./static/

# Runtime config
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/backend

# PiOS stores user data in /data (mount a volume here)
RUN mkdir -p /data/.pios/plugins /data/.pios/vault

EXPOSE 9100

# Health check — waits up to 30 s for the API to respond
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9100/api/system/health')" \
    || exit 1

CMD ["python", "-m", "uvicorn", "pios.main:app", \
     "--host", "0.0.0.0", "--port", "9100", \
     "--workers", "1", "--log-level", "info"]
