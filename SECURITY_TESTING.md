# RouteADDA security testing

This branch is for local testing only. No production deployment, merge, or remote D1 migration has been performed. The production D1 ID remains a placeholder.

## 1. Prepare local secrets

In the active project folder, copy `.dev.vars.example` to `.dev.vars` if you do not already have a local file. Edit `.dev.vars` and set:

- `ADMIN_PATH`: a long random URL path (at least 20 letters/numbers/hyphens/underscores after the leading slash).
- `ADMIN_USERNAME`: initial Owner username, default `owner`.
- `ADMIN_PASSWORD`: initial Owner password, at least 12 characters with uppercase, lowercase and a number.
- `SESSION_SECRET`: a unique random secret of at least 32 characters. Keep it stable after MFA enrolment; changing it makes stored MFA secrets unreadable.
- `OWNER_RECOVERY_SECRET`: a different unique random secret of at least 32 characters. Store it somewhere private/offline. It can recover the Owner password and reset Owner MFA if the phone is lost.
- Keep your existing `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `CRON_SECRET` values server-side.

Remove the old `ADMIN_URL_TOKEN`; the new login does not use it. Never paste secrets into chat, GitHub source files, screenshots, or Telegram.

`ADMIN_PASSWORD` bootstraps the Owner account only when the D1 `admins` table is empty. Changing that environment variable later does not reset an existing account. Use the dashboard password-reset action or the emergency recovery secret.

## 2. Apply local migrations and start the Worker

Run these commands in PowerShell from the active project folder:

```powershell
npm.cmd install
npm.cmd run db:migrate:local
npm.cmd run check
npm.cmd run dev
```

Keep the Worker terminal open. Open the local private route using the exact path you configured in `ADMIN_PATH`, for example `http://127.0.0.1:8787/your-long-private-route`.

The old `/admin.html` and `/control/*` routes must return 404. The private route is only an extra barrier: every administrator still needs an individual username, password and authenticator code.

## 3. First login and MFA

1. Sign in using the initial Owner username and password.
2. Scan the displayed QR code using Google Authenticator or another TOTP app.
3. Enter the current six-digit code to enable MFA.
4. Save all ten one-time recovery codes somewhere private. They are shown only once.
5. Sign out and sign back in using your password and authenticator code.

Every new Admin and Viewer account must enrol MFA before accessing dashboard data.

## 4. Test the security controls

- Create a separate Admin account and a Viewer account.
- Sign in as Admin and confirm you can see active sessions, revoke a specific session, or use the emergency Owner lock after entering your own MFA code.
- Confirm an emergency-locked Owner cannot sign in. Restore the Owner only with the server-side `OWNER_RECOVERY_SECRET`; recovery resets Owner MFA and revokes all sessions.
- Sign in as Viewer and confirm phone numbers are masked, booking edits are rejected, exports are blocked, and session controls are unavailable.
- Change an admin password. Confirm **all** admin sessions are invalidated and everyone must sign in again.
- Use a recovery code once, then confirm the same code cannot be reused.
- Check the Owner security audit panel and the private Telegram chat for security alerts.

The automated smoke script creates test admin accounts and rotates the local Owner password/MFA. Run it only against a disposable local D1 database, never against production or a local database you need to preserve:

```powershell
$env:TEST_BASE_URL = "http://127.0.0.1:8787"
$env:TEST_ADMIN_PATH = "/your-long-private-route"
$env:TEST_OWNER_PASSWORD = "your-initial-owner-password"
$env:TEST_RECOVERY_SECRET = "your-owner-recovery-secret"
npm.cmd run test:security
```

## 5. Verify existing RouteADDA features

After the security checks, test booking creation, booking edits/status, manual matching, scheduled expiry, WhatsApp receivers/help contacts, CSV/XLSX exports, activity history, and existing Telegram match notifications. Test Telegram outage behaviour and test with a second browser/device over HTTPS.

## Deployment gate

Do not deploy until the automated checks pass, manual checks are complete, all required production secrets are configured in Cloudflare, and the real production D1 database ID has been supplied. Netlify and its existing database remain untouched until you explicitly approve switching over.
