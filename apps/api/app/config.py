from pathlib import Path
import os

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
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
