# RouteADDA security testing

This branch is for local testing only. Do not deploy until all checks pass and the production D1 database ID and secrets have been configured.

## Required local variables

Copy `.dev.vars.example` to `.dev.vars`. Use unique random values for `ADMIN_PATH`, `SESSION_SECRET`, `OWNER_RECOVERY_SECRET`, and `CRON_SECRET`. Set a strong initial `ADMIN_PASSWORD` (12+ characters, uppercase, lowercase and a number). Never commit `.dev.vars`.

`ADMIN_PASSWORD` bootstraps the Owner account only when the D1 `admins` table is empty. Later password changes happen inside the dashboard and revoke every active admin session. `ADMIN_URL_TOKEN` is no longer used.

## Local test commands

```powershell
npm.cmd install
npm.cmd run db:migrate:local
npm.cmd run check
npm.cmd run dev
```

Open the private route configured by `ADMIN_PATH`, not `/admin.html`. The direct `/admin.html` route must return 404. First Owner login requires authenticator enrolment. Scan the QR code with an authenticator app, confirm a current six-digit code, and save the one-time recovery codes.

## Automated security smoke test

The GitHub Actions workflow runs local D1 migrations and a Worker smoke test covering private admin routing, Owner bootstrap, MFA, recovery codes, Admin creation, emergency Owner lock, Owner recovery, Viewer restrictions and global session revocation.

## Manual checks before deployment

- Test on HTTPS with a real authenticator app and a second browser/device.
- Verify Telegram login, failed-login, account, MFA, lockout, recovery and session-revocation alerts reach the intended private chat.
- Confirm a Telegram outage does not prevent authentication or booking actions.
- Verify booking creation, matching, exports, WhatsApp contacts, scheduled expiry and existing Telegram match notifications still work.
- Verify each role's permissions and inspect the security audit log.
- Configure Cloudflare production D1 ID and secrets only after local validation. Keep Netlify unchanged until the Cloudflare version is accepted.
