"""Test 5: account A cannot read or write account B's sessions (server-side enforcement)."""


def test_cross_user_session_access_is_blocked(client, auth_client, active_session, demo2_token):
    session_id = active_session["id"]

    # Sanity: the owner can read it.
    assert auth_client.get(f"/api/sessions/{session_id}").status_code == 200

    # demo2's token must get 404 (no existence leak), not 200/403.
    response = client.get(
        f"/api/sessions/{session_id}", headers={"Authorization": f"Bearer {demo2_token}"}
    )
    assert response.status_code == 404

    # Sending a message into someone else's session is blocked too.
    response = client.post(
        f"/api/sessions/{session_id}/messages",
        json={"text": "你好"},
        headers={"Authorization": f"Bearer {demo2_token}"},
    )
    assert response.status_code == 404

    # Ending someone else's session is blocked.
    response = client.post(
        f"/api/sessions/{session_id}/end", headers={"Authorization": f"Bearer {demo2_token}"}
    )
    assert response.status_code == 404

    # Deleting someone else's session is blocked.
    response = client.delete(
        f"/api/sessions/{session_id}", headers={"Authorization": f"Bearer {demo2_token}"}
    )
    assert response.status_code == 404

    # The session list of demo2 does not contain demo1's session.
    listing = client.get("/api/sessions", headers={"Authorization": f"Bearer {demo2_token}"}).json()
    assert all(item["id"] != session_id for item in listing)


def test_unauthenticated_requests_are_rejected(client, active_session):
    assert client.get("/api/sessions").status_code == 401
    assert client.get(f"/api/sessions/{active_session['id']}").status_code == 401
    assert client.post("/api/sessions", json={
        "concern": "工作", "expression_preference": "gentle", "voice_reply_enabled": True
    }).status_code == 401


def test_wrong_password_is_rejected(client):
    response = client.post("/api/auth/login", json={"username": "demo1", "password": "wrong-password"})
    assert response.status_code == 401
