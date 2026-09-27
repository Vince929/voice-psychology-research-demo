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
  db:up                Start a dedicated MySQL 8 container on port 33061 (pulls image on first run)
  db:down              Stop and remove the dedicated MySQL container
  db:reset             Recreate the dedicated MySQL container from scratch (data loss)
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

# Dedicated demo database (independent of any other project's MySQL).
# Port 33061 avoids clashing with a local 3306 instance.
DB_CONTAINER="voice-psych-mysql"
DB_PORT="33061"
DB_ROOT_PASSWORD="root123"
DB_USER="voice"
DB_PASSWORD="voice123"
DB_NAME="voice_psychology_demo"
DB_URL="mysql+pymysql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}?charset=utf8mb4"

db_up() {
  if podman ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
    echo "Dedicated MySQL container '$DB_CONTAINER' is already running on port $DB_PORT."
  else
    podman rm "$DB_CONTAINER" >/dev/null 2>&1 || true
    podman run -d --name "$DB_CONTAINER" \
      -e MYSQL_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
      -e MYSQL_DATABASE="$DB_NAME" \
      -e MYSQL_USER="$DB_USER" \
      -e MYSQL_PASSWORD="$DB_PASSWORD" \
      -p "${DB_PORT}:3306" \
      mysql:8
  fi
  echo "Waiting for MySQL to accept connections..."
  for _ in $(seq 1 60); do
    if nc -z 127.0.0.1 "$DB_PORT" 2>/dev/null; then
      echo "MySQL is up on port $DB_PORT."
      break
    fi
    sleep 2
  done
  cat <<EOF

Dedicated database ready. To switch the backend to it, set in apps/api/.env:
  DATABASE_URL=$DB_URL
then run: ./cmd.sh db:migrate && ./cmd.sh seed
EOF
}

db_down() {
  podman stop "$DB_CONTAINER" >/dev/null 2>&1 || true
  podman rm "$DB_CONTAINER" >/dev/null 2>&1 || true
  echo "Dedicated MySQL container '$DB_CONTAINER' stopped and removed."
}

db_reset() {
  db_down
  db_up
  echo "Fresh container started; schema is empty. Run ./cmd.sh db:migrate && ./cmd.sh seed next."
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
  db:up)
    db_up
    ;;
  db:down)
    db_down
    ;;
  db:reset)
    db_reset
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
