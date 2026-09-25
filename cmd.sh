#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
MOBILE_DIR="$PROJECT_ROOT/apps/mobile"
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
  worker               Start the persistent ASR and AI analysis worker
  mobile, android      Build, install and start the Android app in emulator mode
  usb                  Configure USB port reverse and start the Android app on a device
  metro                Start the React Native Metro server only
  package, apk         Build the Android release APK
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

start_worker() {
  if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
    echo "Backend virtual environment is missing: $API_DIR/.venv"
    echo "Run: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e apps/api"
    exit 1
  fi

  migrate_database
  cd "$API_DIR"
  exec .venv/bin/python -m app.worker
}

build_android_apk() {
  local gradle_wrapper="$MOBILE_DIR/android/gradlew"
  if [[ ! -x "$gradle_wrapper" ]]; then
    echo "Android Gradle wrapper is missing or not executable: $gradle_wrapper" >&2
    exit 1
  fi

  (
    cd "$MOBILE_DIR/android"
    ./gradlew assembleRelease
  )
  echo "Release APK: $MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
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
  worker)
    start_worker
    ;;
  mobile|android)
    cd "$PROJECT_ROOT"
    exec pnpm run mobile:android
    ;;
  usb)
    cd "$PROJECT_ROOT"
    exec pnpm run mobile:android:usb
    ;;
  metro)
    cd "$PROJECT_ROOT"
    exec pnpm run mobile:start
    ;;
  package|apk)
    build_android_apk
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
