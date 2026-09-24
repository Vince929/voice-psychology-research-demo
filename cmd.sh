#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
ENV_FILE="$API_DIR/.env"

load_database_url() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Backend environment file is missing: $ENV_FILE" >&2
    echo "Copy apps/api/.env.example to apps/api/.env and set DATABASE_URL first." >&2
    exit 1
  fi

  set -a
  source "$ENV_FILE"
  set +a

  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL must be configured in $ENV_FILE" >&2
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Usage: ./cmd.sh [command]

  (no args), api       Start the FastAPI service at http://127.0.0.1:8000
  mobile, android      Build, install and start the Android app in emulator mode
  usb                  Configure USB port reverse and start the Android app on a device
  metro                Start the React Native Metro server only
  db:migrate           Apply pending versioned SQL migrations with Yoyo
  help, -h, --help     Show this help
EOF
}

migrate_database() {
  if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
    echo "Backend virtual environment is missing: $API_DIR/.venv"
    echo "Run: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e apps/api"
    exit 1
  fi

  load_database_url
  local yoyo_database_url="${DATABASE_URL/mysql+pymysql:/mysql:}"
  (
    cd "$API_DIR"
    .venv/bin/python -m yoyo apply --batch --database "$yoyo_database_url" "$PROJECT_ROOT/db/migrations"
  )
}

start_api() {
  if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
    echo "Backend virtual environment is missing: $API_DIR/.venv"
    echo "Run: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e apps/api"
    exit 1
  fi

  migrate_database
  cd "$API_DIR"
  exec .venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
}

case "${1:-api}" in
  api)
    start_api
    ;;
  mobile|android)
    cd "$PROJECT_ROOT"
    exec npm run mobile:android
    ;;
  usb)
    cd "$PROJECT_ROOT"
    exec npm run mobile:android:usb
    ;;
  metro)
    cd "$PROJECT_ROOT"
    exec npm run mobile:start
    ;;
  db:migrate)
    migrate_database
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
