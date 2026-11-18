import os
import re
import tempfile
from datetime import date, timedelta
from pathlib import Path

DB_FILE = Path(tempfile.gettempdir()) / f"booking-bot-tests-{os.getpid()}.sqlite3"
if DB_FILE.exists():
    DB_FILE.unlink()
os.environ["DATABASE_PATH"] = str(DB_FILE)
os.environ["SECRET_KEY"] = "test-only-session-secret"
os.environ["ADMIN_PASSWORD"] = "test-admin-password"
os.environ["ADMIN_URL_TOKEN"] = "test-private-admin-path"
os.environ["COOKIE_SECURE"] = "false"

import app as booking_app  # noqa: E402


def csrf_from(html):
    match = re.search(r'name="csrf_token" value="([^"]+)"', html)
    assert match
    return match.group(1)


def test_public_home_and_booking_save():
    client = booking_app.app.test_client()
    response = client.get("/")
    assert response.status_code == 200
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    response = client.post("/api/bookings", json={
        "role": "customer", "name": "Test Customer", "phone": "9876543210",
        "origin": "Jaora", "destination": "Indore", "via": "",
        "trip_date": tomorrow, "trip_time": "10:30"
    })
    assert response.status_code == 201
    assert response.json["ok"] is True
    assert response.json["reference"]


def test_admin_url_is_not_public_and_password_is_required():
    client = booking_app.app.test_client()
    assert client.get("/control/not-the-token").status_code == 404
    response = client.get("/control/test-private-admin-path")
    assert response.status_code == 200
    token = csrf_from(response.get_data(as_text=True))
    response = client.post("/control/test-private-admin-path", data={
        "csrf_token": token, "password": "wrong-password"
    })
    assert response.status_code == 200
    assert b"Incorrect password" in response.data


def test_admin_can_login_with_password():
    client = booking_app.app.test_client()
    response = client.get("/control/test-private-admin-path")
    token = csrf_from(response.get_data(as_text=True))
    response = client.post("/control/test-private-admin-path", data={
        "csrf_token": token, "password": "test-admin-password"
    }, follow_redirects=True)
    assert response.status_code == 200
    assert b"Booking dashboard" in response.data


def test_match_requires_cron_secret():
    client = booking_app.app.test_client()
    assert client.post("/internal/match").status_code == 404
