#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"

usage() {
  cat <<'EOF'
Usage: ./cmd.sh [command]

  (no args), api       Start the FastAPI service at http://127.0.0.1:8000
  mobile, android      Build, install and start the Android app in emulator mode
  usb                  Configure USB port reverse and start the Android app on a device
  metro                Start the React Native Metro server only
  help, -h, --help     Show this help
EOF
}

start_api() {
  if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
    echo "Backend virtual environment is missing: $API_DIR/.venv"
    echo "Run: python3 -m venv apps/api/.venv && apps/api/.venv/bin/pip install -e apps/api"
    exit 1
  fi

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
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
