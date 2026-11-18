import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path
from urllib.parse import quote

import requests
from flask import Flask, abort, flash, jsonify, redirect, render_template, request, session, url_for

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "instance" / "bookings.sqlite3")))
DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY", ""),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "true").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=1024 * 1024,
)

PBKDF2_ITERATIONS = 600_000
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
ADMIN_URL_TOKEN = os.getenv("ADMIN_URL_TOKEN", "")
APP_BASE_URL = os.getenv("APP_BASE_URL", "").rstrip("/")
CRON_SECRET = os.getenv("CRON_SECRET", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")


def db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('driver','customer')),
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            via TEXT DEFAULT '',
            trip_date TEXT NOT NULL,
            trip_time TEXT NOT NULL,
            created_at TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS whatsapp_receivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            phone TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS match_notifications (
            pair_key TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        );
        """)
        salt_row = conn.execute("SELECT value FROM app_meta WHERE key='admin_salt'").fetchone()
        if not salt_row:
            conn.execute("INSERT INTO app_meta(key,value) VALUES('admin_salt',?)", (secrets.token_hex(32),))
        # Store only the derived password hash. Recompute at startup so changing ADMIN_PASSWORD
        # in the host's secret settings is the supported recovery procedure.
        if ADMIN_PASSWORD:
            salt = conn.execute("SELECT value FROM app_meta WHERE key='admin_salt'").fetchone()["value"]
            derived = hashlib.pbkdf2_hmac("sha256", ADMIN_PASSWORD.encode(), salt.encode(), PBKDF2_ITERATIONS).hex()
            conn.execute(
                "INSERT INTO app_meta(key,value) VALUES('admin_password_hash',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (derived,),
            )


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


@app.context_processor
def inject_csrf():
    return {"csrf_token": csrf_token}


def validate_csrf():
    sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
    expected = session.get("csrf", "")
    if not sent or not expected or not hmac.compare_digest(sent, expected):
        abort(400, "Invalid form token. Refresh and try again.")


def private_admin_url():
    if not ADMIN_URL_TOKEN:
        return None
    return f"{APP_BASE_URL}{url_for('admin_login', token=ADMIN_URL_TOKEN)}" if APP_BASE_URL else url_for("admin_login", token=ADMIN_URL_TOKEN)


def admin_path_ok(token):
    return bool(ADMIN_URL_TOKEN) and hmac.compare_digest(token, ADMIN_URL_TOKEN)


def admin_required(view):
    @wraps(view)
    def wrapped(token, *args, **kwargs):
        if not admin_path_ok(token):
            abort(404)
        if not session.get("admin_authenticated"):
            return redirect(url_for("admin_login", token=token))
        return view(token, *args, **kwargs)
    return wrapped


def clean_text(value, max_len=100):
    return " ".join((value or "").strip().split())[:max_len]


def normalize(value):
    return " ".join((value or "").strip().lower().split())


def parse_route_points(row):
    points = [normalize(row["origin"])]
    points.extend(normalize(x) for x in (row["via"] or "").split(",") if normalize(x))
    points.append(normalize(row["destination"]))
    return points


def routes_overlap(a, b):
    pa, pb = parse_route_points(a), parse_route_points(b)
    # Any shared directed segment indicates a useful overlapping route.
    segments_a = set(zip(pa, pa[1:]))
    segments_b = set(zip(pb, pb[1:]))
    if segments_a & segments_b:
        return True, "overlapping route"
    if normalize(a["origin"]) == normalize(b["origin"]) and normalize(a["destination"]) == normalize(b["destination"]):
        return True, "same route"
    # A route can connect to another at an intermediate stop.
    if set(pa[1:-1]) & set(pb) or set(pb[1:-1]) & set(pa):
        return True, "via/connecting route"
    return False, ""


def find_matches(conn, booking):
    rows = conn.execute(
        "SELECT * FROM bookings WHERE active=1 AND role<>? AND trip_date=? AND id<>?",
        (booking["role"], booking["trip_date"], booking["id"]),
    ).fetchall()
    matches = []
    target = datetime.strptime(booking["trip_date"] + " " + booking["trip_time"], "%Y-%m-%d %H:%M")
    for other in rows:
        other_time = datetime.strptime(other["trip_date"] + " " + other["trip_time"], "%Y-%m-%d %H:%M")
        if abs((target - other_time).total_seconds()) > 3 * 3600:
            continue
        ok, reason = routes_overlap(booking, other)
        if ok:
            matches.append((other, reason))
    return matches


def telegram_send(text):
    if not (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID):
        return False
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "disable_web_page_preview": True},
            timeout=12,
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        app.logger.exception("Telegram notification failed")
        return False


def booking_summary(row):
    role = "Driver" if row["role"] == "driver" else "Customer"
    return (
        f"{role}: {row['name']}\n"
        f"Route: {row['origin']} → {row['destination']}"
        f"{(' via ' + row['via']) if row['via'] else ''}\n"
        f"Date/time: {row['trip_date']} at {row['trip_time']}\n"
        f"Reference: {row['reference']}"
    )


def process_matches():
    sent = 0
    with db() as conn:
        bookings = conn.execute("SELECT * FROM bookings WHERE active=1 ORDER BY id DESC LIMIT 500").fetchall()
        for booking in bookings:
            for other, reason in find_matches(conn, booking):
                left, right = sorted([booking["reference"], other["reference"]])
                pair_key = left + ":" + right
                if conn.execute("SELECT 1 FROM match_notifications WHERE pair_key=?", (pair_key,)).fetchone():
                    continue
                # Only two admin-directed messages; neither contains either phone number.
                msg1 = "POSSIBLE BOOKING MATCH (1/2)\n" + booking_summary(booking) + f"\nMatch type: {reason}\nOther booking: {other['reference']}\nAdmin: review and decide whether to contact either party."
                msg2 = "POSSIBLE BOOKING MATCH (2/2)\n" + booking_summary(other) + f"\nMatch type: {reason}\nOther booking: {booking['reference']}\nAdmin: review and decide whether to contact either party."
                ok1 = telegram_send(msg1)
                ok2 = telegram_send(msg2)
                if ok1 and ok2:
                    conn.execute("INSERT OR IGNORE INTO match_notifications(pair_key,created_at) VALUES(?,?)",
                                 (pair_key, datetime.utcnow().isoformat(timespec="seconds")))
                    sent += 1
    return sent


@app.get("/")
def home():
    with db() as conn:
        receivers = conn.execute("SELECT id,label,phone FROM whatsapp_receivers ORDER BY id").fetchall()
    return render_template("index.html", receivers=receivers, today=date.today().isoformat())


@app.post("/api/bookings")
def create_booking():
    payload = request.get_json(silent=True) or request.form
    role = clean_text(payload.get("role"), 12).lower()
    name = clean_text(payload.get("name"), 80)
    phone = "".join(ch for ch in (payload.get("phone") or "") if ch.isdigit() or ch == "+")[:16]
    origin = clean_text(payload.get("origin"), 80)
    destination = clean_text(payload.get("destination"), 80)
    via = clean_text(payload.get("via"), 160)
    trip_date = clean_text(payload.get("trip_date"), 10)
    trip_time = clean_text(payload.get("trip_time"), 5)
    if role not in ("driver", "customer") or not name or len(phone) < 10 or not origin or not destination or normalize(origin) == normalize(destination):
        return jsonify(ok=False, error="Please check your name, mobile number and route details."), 400
    try:
        chosen = datetime.strptime(trip_date + " " + trip_time, "%Y-%m-%d %H:%M")
        if chosen.date() < date.today() or chosen > datetime.now() + timedelta(days=365):
            raise ValueError()
    except ValueError:
        return jsonify(ok=False, error="Please choose a valid future date and time."), 400

    reference = secrets.token_hex(4).upper()
    with db() as conn:
        conn.execute(
            """INSERT INTO bookings(reference,role,name,phone,origin,destination,via,trip_date,trip_time,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (reference, role, name, phone, origin, destination, via, trip_date, trip_time, datetime.utcnow().isoformat(timespec="seconds")),
        )
        receivers = conn.execute("SELECT label,phone FROM whatsapp_receivers ORDER BY id").fetchall()
    # The booking is committed before any WhatsApp action is returned.
    message = f"New {role} booking | Ref {reference}\nName: {name}\nMobile: {phone}\nRoute: {origin} to {destination}"
    if via:
        message += f" via {via}"
    message += f"\nDate: {trip_date} | Time: {trip_time}"
    links = [{"label": r["label"], "url": f"https://wa.me/{''.join(c for c in r['phone'] if c.isdigit())}?text={quote(message)}"} for r in receivers]
    telegram_send("NEW BOOKING\n" + booking_summary({"role": role, "name": name, "origin": origin, "destination": destination, "via": via, "trip_date": trip_date, "trip_time": trip_time, "reference": reference}))
    return jsonify(ok=True, reference=reference, whatsapp_links=links,
                   message="Booking saved successfully. Choose an admin WhatsApp contact if you want to send the booking details."), 201


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/internal/match")
def scheduled_match():
    supplied = request.headers.get("X-Cron-Secret", "")
    if not CRON_SECRET or not supplied or not hmac.compare_digest(supplied, CRON_SECRET):
        abort(404)
    return jsonify(ok=True, matched_pairs_notified=process_matches())


@app.route("/control/<token>", methods=["GET", "POST"])
def admin_login(token):
    if not admin_path_ok(token):
        abort(404)
    if session.get("admin_authenticated"):
        return redirect(url_for("admin_dashboard", token=token))
    if request.method == "POST":
        validate_csrf()
        if not ADMIN_PASSWORD or not app.config["SECRET_KEY"]:
            flash("Admin login is not configured. Set ADMIN_PASSWORD and SECRET_KEY.", "error")
        else:
            with db() as conn:
                salt = conn.execute("SELECT value FROM app_meta WHERE key='admin_salt'").fetchone()["value"]
                expected = conn.execute("SELECT value FROM app_meta WHERE key='admin_password_hash'").fetchone()
            supplied = hashlib.pbkdf2_hmac("sha256", request.form.get("password", "").encode(), salt.encode(), PBKDF2_ITERATIONS).hex()
            if expected and hmac.compare_digest(supplied, expected["value"]):
                session.clear()
                session["admin_authenticated"] = True
                session.permanent = True
                session["csrf"] = secrets.token_urlsafe(32)
                return redirect(url_for("admin_dashboard", token=token))
            flash("Incorrect password.", "error")
    return render_template("admin_login.html")


@app.get("/control/<token>/dashboard")
@admin_required
def admin_dashboard(token):
    with db() as conn:
        bookings = conn.execute("SELECT * FROM bookings ORDER BY id DESC LIMIT 300").fetchall()
        receivers = conn.execute("SELECT * FROM whatsapp_receivers ORDER BY id").fetchall()
        pairs = conn.execute("SELECT * FROM match_notifications ORDER BY created_at DESC LIMIT 100").fetchall()
        match_rows = []
        seen = set()
        for booking in bookings:
            for other, reason in find_matches(conn, booking):
                key = tuple(sorted((booking["reference"], other["reference"])))
                if key not in seen:
                    seen.add(key)
                    match_rows.append((booking, other, reason))
    return render_template("admin.html", token=token, bookings=bookings, receivers=receivers,
                           matches=match_rows[:100], notified=len(pairs), admin_url=private_admin_url())


@app.post("/control/<token>/receivers")
@admin_required
def add_receiver(token):
    validate_csrf()
    label = clean_text(request.form.get("label"), 50)
    phone = "".join(ch for ch in request.form.get("phone", "") if ch.isdigit())
    if not label or len(phone) < 10 or len(phone) > 15:
        flash("Enter a label and a valid WhatsApp number with country code.", "error")
    else:
        with db() as conn:
            conn.execute("INSERT INTO whatsapp_receivers(label,phone) VALUES(?,?)", (label, phone))
        flash("WhatsApp receiver added.", "success")
    return redirect(url_for("admin_dashboard", token=token))


@app.post("/control/<token>/receivers/<int:receiver_id>/delete")
@admin_required
def delete_receiver(token, receiver_id):
    validate_csrf()
    with db() as conn:
        conn.execute("DELETE FROM whatsapp_receivers WHERE id=?", (receiver_id,))
    flash("Receiver removed.", "success")
    return redirect(url_for("admin_dashboard", token=token))


@app.post("/control/<token>/bookings/<int:booking_id>/toggle")
@admin_required
def toggle_booking(token, booking_id):
    validate_csrf()
    with db() as conn:
        conn.execute("UPDATE bookings SET active=1-active WHERE id=?", (booking_id,))
    return redirect(url_for("admin_dashboard", token=token))


@app.post("/control/<token>/logout")
@admin_required
def admin_logout(token):
    validate_csrf()
    session.clear()
    return redirect(url_for("admin_login", token=token))


@app.errorhandler(404)
def not_found(_error):
    return render_template("error.html", code=404, message="Page not found."), 404


@app.errorhandler(400)
def bad_request(error):
    return render_template("error.html", code=400, message=getattr(error, "description", "Bad request.")), 400


init_db()

if not app.config["SECRET_KEY"]:
    app.logger.warning("SECRET_KEY is missing. Admin login is disabled until configured.")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
