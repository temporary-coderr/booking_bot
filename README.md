# Booking Bot

WhatsApp-inspired, mobile-first driver/customer booking and private admin platform.

## Stack
- Python + Flask backend
- SQLite database (mount a persistent disk at `./instance` in production)
- Vanilla HTML/CSS/JavaScript frontend
- Telegram notifications to the configured admin chat
- WhatsApp official click-to-chat links (the user must press Send)

## Required environment variables
- `SECRET_KEY`: long random session signing secret.
- `ADMIN_PASSWORD`: initial/current admin password; never commit it.
- `ADMIN_URL_TOKEN`: long random secret segment used in the private admin URL. Keep a copy; your private dashboard URL is `APP_BASE_URL/control/ADMIN_URL_TOKEN`.
- `DATABASE_PATH`: optional SQLite path; defaults to `instance/bookings.sqlite3`.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: optional Telegram notification settings.
- `CRON_SECRET`: optional secret for the scheduled matching endpoint.
- `APP_BASE_URL`: public base URL, used to display the private admin URL after deployment.

Set these as deployment environment variables and GitHub Actions secrets where applicable. Do not put secrets in source files. For Render, set `ADMIN_PASSWORD`, `ADMIN_URL_TOKEN`, `APP_BASE_URL`, Telegram values, and the generated secrets in the service environment. Add GitHub Actions secrets `ADMIN_PASSWORD`, `RENDER_API_KEY`, and `RENDER_SERVICE_ID` to enable the **Reset admin password** workflow. When you change the GitHub `ADMIN_PASSWORD` secret, run Actions → Reset admin password → Run workflow; it updates the Render service variable and triggers a deploy. The workflow updates only the `ADMIN_PASSWORD` variable, not the other service variables.

## Run locally
```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
set FLASK_APP=app.py
python app.py
```
Open `http://127.0.0.1:5000`. The private admin URL is `/control/<ADMIN_URL_TOKEN>`.

## Deployment
Use a Python web service (for example Render) with a persistent disk mounted at the project root or set `DATABASE_PATH` to a path on the persistent disk. Free ephemeral filesystems can lose SQLite data on restart and free instances may sleep; they are not suitable for dependable live bookings. Configure the environment variables above before exposing the service.

## Security and behavior
- Admin route is not linked from public pages; both the private URL token and password are required.
- Password verification uses PBKDF2-HMAC-SHA256 and a random salt persisted in the database.
- Change `ADMIN_PASSWORD` in the deployment environment and restart/redeploy to reset it. The app re-hashes the new value using the stored salt.
- Public booking pages never show contact numbers from other bookings or matching records.
- WhatsApp links only open a prefilled chat. The admin/user must manually press Send.
- Matching notifications go only to the configured Telegram admin chat. Phone numbers are excluded from notification text.

## GitHub Actions
The scheduled workflow calls the protected matching endpoint every five minutes. Add `APP_BASE_URL` and `CRON_SECRET` as repository Actions secrets before enabling it.
\n\n## GitHub repository secrets\n\nFor scheduled matching add `APP_BASE_URL` and `CRON_SECRET` as Actions secrets. For password recovery add `ADMIN_PASSWORD`, `RENDER_API_KEY`, and `RENDER_SERVICE_ID`. `ADMIN_URL_TOKEN` is also set as a Render service environment variable; keep its value privately so you can construct the hidden admin URL. Create a long random token (at least 32 characters) for it.\n\nLocal development: set `COOKIE_SECURE=false` when using plain `http://127.0.0.1`.\n