FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy backend code
COPY backend/ ./backend/

# Install Python dependencies
RUN cd backend && pip install --no-cache-dir -r requirements.txt

# Create config and data directories
RUN mkdir -p ~/.pios && mkdir -p /app/data

# Expose port
EXPOSE 8000

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PIOS_HOME=/app/data

# Run the application
CMD ["python", "-m", "uvicorn", "pios.main:app", "--host", "0.0.0.0", "--port", "8000"]
