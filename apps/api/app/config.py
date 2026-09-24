from pathlib import Path
import os

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL must be configured")

UPLOAD_AUDIO_DIR = Path(os.getenv("UPLOAD_AUDIO_DIR", BASE_DIR / "upload_audio"))
ENABLE_DEEPSEEK_ANALYSIS = os.getenv("ENABLE_DEEPSEEK_ANALYSIS", "false").lower() == "true"
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
