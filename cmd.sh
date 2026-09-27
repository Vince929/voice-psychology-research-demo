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
  mobile, android      Build, install and start the Android app in emulator mode
  usb                  Configure USB port reverse and start the Android app on a device
  metro                Start the React Native Metro server only
  package, apk         Build the Android release APK
  db:migrate           Apply pending versioned SQL migrations with Yoyo
  seed                 Insert the two acceptance test accounts (seed.sql)
  test                 Run the pytest suite (apps/api/tests)
  help, -h, --help     Show this help
EOF
}

require_venv() {
  if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
    echo "Backend virtual environment is missing: $API_DIR/.venv" >&2
    echo "Run: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e 'apps/api[dev]'" >&2
    exit 1
  fi
}

migrate_database() {
  require_venv
  load_database_url
  local yoyo_database_url="${DATABASE_URL/mysql+pymysql:/mysql:}"
  (
    cd "$API_DIR"
    .venv/bin/python -m yoyo apply --batch --database "$yoyo_database_url" "$PROJECT_ROOT/db/migrations"
  )
}

seed_accounts() {
  require_venv
  load_database_url
  (
    cd "$API_DIR"
    .venv/bin/python -c '
import pymysql
from urllib.parse import urlparse
from app.config import DATABASE_URL
parsed = urlparse(DATABASE_URL.replace("mysql+pymysql://", "mysql://"))
sql = open("seed.sql", encoding="utf-8").read()
connection = pymysql.connect(
    host=parsed.hostname,
    port=parsed.port or 3306,
    user=parsed.username,
    password=parsed.password,
    database=parsed.path.lstrip("/"),
    charset="utf8mb4",
    autocommit=True,
)
with connection.cursor() as cursor:
    cursor.execute(sql)
print("seed accounts ready: demo1 / demo2 (password: Passw0rd!)")
'
  )
}

run_tests() {
  require_venv
  load_database_url
  (
    cd "$API_DIR"
    exec .venv/bin/python -m pytest tests -v
  )
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
  require_venv
  migrate_database
  cd "$API_DIR"
  exec .venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
}

case "${1:-api}" in
  api)
    start_api
    ;;
  seed)
    seed_accounts
    ;;
  test)
    run_tests
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
