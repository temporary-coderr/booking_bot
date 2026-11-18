# Booking Bot

Mobile-first driver/customer booking platform using Netlify, Google Sheets, Telegram and WhatsApp click-to-chat.

## Architecture

- **Netlify** hosts the public website and serverless API.
- **Google Sheets** stores bookings, WhatsApp receivers and match-notification history.
- **Telegram** sends private admin-only match alerts.
- **WhatsApp** uses official click-to-chat links. The person must review and press Send; the app never sends WhatsApp messages automatically.
- **GitHub Actions** runs matching and expiry checks every five minutes.

The public page is `public/index.html`. Netlify publishes the `public/` directory. The old Flask/SQLite/Render deployment is no longer the active architecture.

## Netlify environment variables

Keep all values in Netlify Site configuration → Environment variables. Never commit secrets or paste them into public code.

Already configured by you:
- `GOOGLE_SHEET_URL` — must be the **Apps Script Web App deployment URL** connected to your spreadsheet, not the normal spreadsheet browser URL.
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Add these server-only variables:
- `SHEETS_API_SECRET` — a long random secret; it must exactly match the Apps Script Script Property with the same name.
- `ADMIN_PASSWORD` — your private dashboard password.
- `ADMIN_URL_TOKEN` — long random secret path token (at least 32 random characters).
- `SESSION_SECRET` — long random session-signing secret (at least 32 random characters).
- `CRON_SECRET` — long random secret used by the scheduled matching workflow.

Do not use the same value for all secrets. Do not put any of them in the `public/` folder.

## Connect Google Sheets

1. Open the target Google spreadsheet.
2. Open Extensions → Apps Script.
3. Replace the editor content with `google-apps-script/Code.gs` from this repository.
4. In Apps Script Project Settings → Script Properties, add:
   - `SPREADSHEET_ID`: the ID between `/d/` and `/edit` in the spreadsheet URL.
   - `SHEETS_API_SECRET`: exactly the same random value configured in Netlify.
5. In the Apps Script editor, select and run `setup` once. Approve the requested spreadsheet permissions. It creates the `Bookings`, `Receivers`, and `Notifications` tabs and their headers.
6. Deploy → New deployment → Web app. Execute as **Me**. Set access to **Anyone** so Netlify Functions can call the endpoint; the shared secret protects the data operations.
7. Copy the Web App URL ending in `/exec` into Netlify's `GOOGLE_SHEET_URL` environment variable.
8. After changing environment variables, trigger a new Netlify deploy.

Do not share the Apps Script URL together with the API secret. The normal spreadsheet link is not the API endpoint.

## Netlify deployment

1. Import `temporary-coderr/booking_bot` into Netlify.
2. Build settings:
   - Base directory: blank
   - Build command: blank
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
3. Add all eight environment variables listed above (the three existing ones plus five additional ones).
4. Deploy the site.
5. Open the public site and submit a test booking. Confirm a row appears in the Google Sheets `Bookings` tab.

The hidden admin URL is:

`https://YOUR-NETLIFY-SITE.netlify.app/control/YOUR_ADMIN_URL_TOKEN`

Keep the token private. The admin page is not linked from the public booking page. Both the secret path and password are required.

## Admin dashboard powers

- View, search and filter all driver/customer bookings.
- See private phone numbers and open a WhatsApp chat manually.
- Edit name, phone, route, via, date and time.
- Change status: pending, approved, rejected or completed.
- Activate/deactivate or permanently delete bookings.
- Review route/date/time matches and manually contact either party.
- Add/remove WhatsApp receivers used by the post-booking share button.\n- See booking visitor activity, edits, auto-deletions and WhatsApp link opens. A link-open event is not proof that the WhatsApp message was sent.
- View total bookings, active bookings, possible matches and notification count.
- Log out; the signed admin session expires after eight hours.

Customer/driver phone numbers are not included in automated Telegram match alerts. The admin decides manually whether to contact or connect people.

## Scheduled matching

The repository's GitHub Actions workflow calls Netlify every five minutes. Add these GitHub repository Actions secrets:
- `APP_BASE_URL`: your deployed Netlify site URL, e.g. `https://your-site.netlify.app`.
- `CRON_SECRET`: the same value as the Netlify environment variable.

You can also run the workflow manually from GitHub → Actions → Booking match checker.

## Password recovery

Change `ADMIN_PASSWORD` in Netlify Site configuration → Environment variables, then trigger a new deploy. The password is checked server-side; it is never embedded in the website source. Keep your `ADMIN_URL_TOKEN` safe as well.

## Important notes

- Netlify Functions are stateless; persistent booking data lives in Google Sheets, not local files.
- The matching workflow may start a few minutes later than its scheduled time because GitHub scheduled jobs are not exact real-time timers.
- Never share customer/driver numbers publicly. WhatsApp is a manual click-to-chat action only.
