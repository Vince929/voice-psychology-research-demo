"""Shared integration-test fixtures.

Integration tests exercise FastAPI routes backed by the configured MySQL database.
They apply migrations and create the two acceptance-test accounts.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration
from yoyo import get_backend, read_migrations

API_DIR = Path(__file__).resolve().parents[2]
PROJECT_ROOT = API_DIR.parent.parent
sys.path.insert(0, str(API_DIR))

from app.config import DATABASE_URL, DEEPSEEK_API_KEY  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402

# Same bcrypt hashes as the delivered seed.sql (password: Passw0rd!).
DEMO_PASSWORD_HASHES = {
    "demo1": "$2b$10$L97Psg227hls/TrnHCevxug3ihNh8wQxoK9f9a.FyV9LdmWQE3zum",
    "demo2": "$2b$10$qPiH/oltLSmr0QF0Bd/Keu4.vlHrG.IFRjtsGJDIU.bg3xLs4/yqS",
}

MIGRATIONS_DIR = PROJECT_ROOT / "db" / "migrations"
llm_available = pytest.mark.skipif(
    not DEEPSEEK_API_KEY, reason="DEEPSEEK_API_KEY is not configured; LLM tests need a real call."
)


def _apply_migrations() -> None:
    yoyo_url = DATABASE_URL.replace("mysql+pymysql://", "mysql://", 1)
    backend = get_backend(yoyo_url)
    migrations = read_migrations(str(MIGRATIONS_DIR))
    with backend.lock():
        backend.apply_migrations(backend.to_apply(migrations))


def _inject_test_accounts() -> None:
    db = SessionLocal()
    try:
        for username, password_hash in DEMO_PASSWORD_HASHES.items():
            user = db.query(User).filter(User.username == username).one_or_none()
            if user is None:
                db.add(User(username=username, password_hash=password_hash))
        db.commit()
    finally:
        db.close()


@pytest.fixture(scope="session", autouse=True)
def _database_ready():
    _apply_migrations()
    _inject_test_accounts()
    yield


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


def _login(client: TestClient, username: str) -> str:
    response = client.post("/api/auth/login", json={"username": username, "password": "Passw0rd!"})
    assert response.status_code == 200, response.text
    return response.json()["token"]


@pytest.fixture(scope="session")
def demo1_token(client):
    return _login(client, "demo1")


@pytest.fixture(scope="session")
def demo2_token(client):
    return _login(client, "demo2")


@pytest.fixture()
def auth_client(demo1_token):
    authenticated = TestClient(app)
    authenticated.headers.update({"Authorization": f"Bearer {demo1_token}"})
    return authenticated


@pytest.fixture()
def active_session(auth_client):
    response = auth_client.post(
        "/api/sessions",
        json={"concern": "工作压力", "expression_preference": "gentle", "voice_reply_enabled": True},
    )
    assert response.status_code == 200, response.text
    yield response.json()
    # Some tests delete it themselves already; a 404 here is fine.
    auth_client.delete(f"/api/sessions/{response.json()['id']}")


def send_message(client_with_auth: TestClient, session_id: int, text: str):
    return client_with_auth.post(f"/api/sessions/{session_id}/messages", json={"text": text})
