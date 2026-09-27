import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("数据库连接配置缺失，请设置 DATABASE_URL。")

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = max(1, int(os.getenv("JWT_EXPIRE_HOURS", "24")))

# Tencent Cloud Flash ASR credentials. The legacy variable names are kept as
# fallbacks so an existing local .env keeps working after the rebranding.
ASR_SECRET_ID = os.getenv("TENCENTCLOUD_SECRET_ID") or os.getenv("AUDIO_COS_SECRET_ID", "")
ASR_SECRET_KEY = os.getenv("TENCENTCLOUD_SECRET_KEY") or os.getenv("AUDIO_COS_SECRET_KEY", "")
TENCENTCLOUD_APP_ID = os.getenv("TENCENTCLOUD_APP_ID", "")

# Optional pin of asr.cloud.tencent.com to a fixed mainland Tencent edge IP.
# The flash ASR route only exists on Tencent's mainland edge (e.g. Beijing CLB).
# On networks whose DNS view is overseas the domain resolves to Tencent's
# overseas edge, where /asr/flash/v1/<appid> returns nginx 404 and every voice
# message fails. Empty = normal DNS resolution.
ASR_RESOLVE_IP = os.getenv("ASR_RESOLVE_IP", "").strip()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# Voice messages are stored on the local disk under this directory.
UPLOAD_AUDIO_DIR = BASE_DIR / "upload_audio"
