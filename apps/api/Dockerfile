FROM python:3.11-slim AS builder

WORKDIR /app

COPY apps/api ./
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.11-slim AS runner

WORKDIR /app

COPY --from=builder /install /usr/local
COPY apps/api/app ./app
COPY db/migrations ./db/migrations

RUN useradd --create-home --uid 10001 appuser && \
    mkdir -p /app/upload_audio && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
