import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL must be configured")

AUDIO_COS_BUCKET = os.getenv("AUDIO_COS_BUCKET", "")
AUDIO_COS_REGION = os.getenv("AUDIO_COS_REGION", "")
AUDIO_COS_SECRET_ID = os.getenv("AUDIO_COS_SECRET_ID", "")
AUDIO_COS_SECRET_KEY = os.getenv("AUDIO_COS_SECRET_KEY", "")
AUDIO_COS_KEY_PREFIX = os.getenv("AUDIO_COS_KEY_PREFIX", "voice-psychology")

TENCENTCLOUD_APP_ID = os.getenv("TENCENTCLOUD_APP_ID", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
TASK_MAX_ATTEMPTS = max(1, int(os.getenv("TASK_MAX_ATTEMPTS", "3")))
WORKER_POLL_INTERVAL_SECONDS = max(1.0, float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", "2")))
WORKER_LEASE_SECONDS = max(30, int(os.getenv("WORKER_LEASE_SECONDS", "180")))
