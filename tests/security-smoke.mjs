import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const ADMIN_PATH = process.env.TEST_ADMIN_PATH || "/ci-private-admin-route";
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD || "TestOwnerPass2026!";
const RECOVERY_SECRET = process.env.TEST_RECOVERY_SECRET || "ci-owner-recovery-secret-0123456789";
const CRON_SECRET = process.env.TEST_CRON_SECRET || "ci-cron-secret-0123456789";
const ORIGIN = new URL(BASE).origin;

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", origin: ORIGIN, ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-csrf-token": options.csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(BASE + path, { method: options.method || (options.body ? "POST" : "GET"), headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie ? setCookie.split(";")[0] : options.cookie || "";
  return { response, data, cookie, text };
}
function decodeBase32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out = [];
  for (const ch of text.replace(/=+$/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch); assert.notEqual(v, -1, "invalid TOTP secret");
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30000));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", decodeBase32(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 1000000).padStart(6, "0");
}
async function login(username, password, code = "", recovery_code = "") {
  return call("/api/login", { body: { username, password, code, recovery_code } });
}
async function enrolMfa(cookie, csrf) {
  const setup = await call("/api/mfa-setup", { cookie, csrf, body: {} });
  assert.equal(setup.response.status, 200, "MFA setup should succeed: " + JSON.stringify(setup.data));
  assert.ok(setup.data.otpauth_uri.startsWith("otpauth://totp/"), "MFA should return an authenticator URI");
  const confirmed = await call("/api/mfa-confirm", { cookie, csrf, body: { code: totp(setup.data.secret) } });
  assert.equal(confirmed.response.status, 200, "MFA confirmation should succeed: " + JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.recovery_codes.length, 10, "ten one-time recovery codes should be issued");
  return { secret: setup.data.secret, codes: confirmed.data.recovery_codes };
}
async function expectStatus(result, status, label) {
  assert.equal(result.response.status, status, label + ": " + JSON.stringify(result.data));
}

const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
const tomorrow = new Date(Date.UTC(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]) + 1));
const tripDate = tomorrow.getUTCFullYear()+"-"+String(tomorrow.getUTCMonth()+1).padStart(2,"0")+"-"+String(tomorrow.getUTCDate()).padStart(2,"0");
const publicBooking = await call("/api/bookings", { body: { role: "customer", name: "CI Privacy Test", phone: "919876543210", origin: "Jaora", destination: "Indore", trip_date: tripDate, trip_time: "23:59" } });
await expectStatus(publicBooking, 201, "public booking creation");
await expectStatus(await call("/api/match-check", { body: {}, headers: { "x-cron-secret": CRON_SECRET } }), 200, "existing cron match-check endpoint");
await expectStatus(await call("/api/match-check", { body: {}, headers: { "x-cron-secret": "wrong-secret" } }), 404, "cron endpoint rejects an incorrect secret");
const privatePage = await call(ADMIN_PATH);
await expectStatus(privatePage, 200, "private admin route");
assert.match(privatePage.text, /Administrator sign in/, "private route should serve admin login");
await expectStatus(await call("/admin.html"), 404, "direct admin HTML must be blocked");
await expectStatus(await call("/api/login", { body: { username: "owner", password: OWNER_PASSWORD }, headers: { origin: "https://attacker.invalid" } }), 403, "cross-origin login must be rejected");

let owner = await login("owner", OWNER_PASSWORD);
await expectStatus(owner, 200, "initial Owner login");
assert.equal(owner.data.mfaRequired, true, "first login must require MFA enrolment");
let ownerMfa = await enrolMfa(owner.cookie, owner.data.csrf);
let ownerData = await call("/api/admin-data", { cookie: owner.cookie });
await expectStatus(ownerData, 200, "Owner dashboard");
assert.equal(ownerData.data.admin.role, "owner", "Owner role must be returned");

await expectStatus(await call("/api/admin-create", { cookie: owner.cookie, csrf: owner.data.csrf, body: { username: "helperadmin", display_name: "Helper Admin", role: "admin", password: "HelperAdminPass2026!", code: totp(ownerMfa.secret) } }), 200, "Owner creates individual Admin");
let admin = await login("helperadmin", "HelperAdminPass2026!");
await expectStatus(admin, 200, "Admin first login");
assert.equal(admin.data.mfaRequired, true, "new Admin must enrol MFA");
let adminMfa = await enrolMfa(admin.cookie, admin.data.csrf);
let adminOverview = await call("/api/security-overview", { cookie: admin.cookie });
await expectStatus(adminOverview, 200, "Admin can see active sessions");
assert.ok(adminOverview.data.sessions.length >= 2, "Owner and Admin sessions should be visible");
await expectStatus(await call("/api/admin-create", { cookie: admin.cookie, csrf: admin.data.csrf, body: { username: "badadmin", display_name: "Bad", role: "admin", password: "BadAdminPass2026!" } }), 403, "Admin cannot create another admin");

await expectStatus(await call("/api/admin-lock-owner", { cookie: admin.cookie, csrf: admin.data.csrf, body: { code: totp(adminMfa.secret) } }), 200, "trusted Admin can emergency-lock Owner");
await expectStatus(await login("owner", OWNER_PASSWORD), 401, "locked Owner cannot log in");
await expectStatus(await call("/api/owner-recovery", { body: { username: "owner", recovery_secret: RECOVERY_SECRET, new_password: "OwnerRestoredPass2026!" } }), 200, "Owner emergency recovery");
await expectStatus(await call("/api/admin-data", { cookie: admin.cookie }), 401, "Owner recovery revokes every existing session");

owner = await login("owner", "OwnerRestoredPass2026!");
await expectStatus(owner, 200, "Owner can sign in after recovery");
assert.equal(owner.data.mfaRequired, true, "Owner recovery must force MFA re-enrolment");
ownerMfa = await enrolMfa(owner.cookie, owner.data.csrf);
ownerData = await call("/api/admin-data", { cookie: owner.cookie });
await expectStatus(ownerData, 200, "recovered Owner dashboard");

await expectStatus(await call("/api/admin-create", { cookie: owner.cookie, csrf: owner.data.csrf, body: { username: "readonly", display_name: "Read Only", role: "viewer", password: "ReadOnlyPass2026!", code: totp(ownerMfa.secret) } }), 200, "Owner creates Viewer");
let viewer = await login("readonly", "ReadOnlyPass2026!");
await expectStatus(viewer, 200, "Viewer first login");
assert.equal(viewer.data.mfaRequired, true, "Viewer must also enrol MFA");
const viewerMfa = await enrolMfa(viewer.cookie, viewer.data.csrf);
await expectStatus(await call("/api/booking-status", { cookie: viewer.cookie, csrf: viewer.data.csrf, body: { id: "nonexistent", active: false } }), 403, "Viewer cannot mutate bookings");
const viewerData = await call("/api/admin-data", { cookie: viewer.cookie });
await expectStatus(viewerData, 200, "Viewer read-only dashboard");
await expectStatus(await call("/api/security-overview", { cookie: viewer.cookie }), 403, "Viewer cannot inspect admin sessions");
assert.ok(viewerData.data.bookings.every(b => !String(b.phone).endsWith("3210") || String(b.phone).startsWith("••")), "Viewer must not receive raw customer phone numbers");

await expectStatus(await call("/api/logout", { cookie: owner.cookie, csrf: owner.data.csrf, body: {} }), 200, "Owner logout");
const recoveryLogin = await login("owner", "OwnerRestoredPass2026!", "", ownerMfa.codes[0]);
await expectStatus(recoveryLogin, 200, "one-time recovery code login");
await expectStatus(await login("owner", "OwnerRestoredPass2026!", "", ownerMfa.codes[0]), 401, "recovery code cannot be reused");

owner = await login("owner", "OwnerRestoredPass2026!", totp(ownerMfa.secret));
await expectStatus(owner, 200, "Owner MFA login");
await expectStatus(await call("/api/password-change", { cookie: owner.cookie, csrf: owner.data.csrf, body: { current_password: "OwnerRestoredPass2026!", new_password: "OwnerPasswordRotated2026!", code: totp(ownerMfa.secret) } }), 200, "global password reset");
await expectStatus(await call("/api/admin-data", { cookie: owner.cookie }), 401, "global password reset revokes Owner session");
await expectStatus(await call("/api/admin-data", { cookie: recoveryLogin.cookie }), 401, "global password reset revokes other admin sessions");

owner = await login("owner", "OwnerPasswordRotated2026!", totp(ownerMfa.secret));
await expectStatus(owner, 200, "Owner can sign in after password rotation");
await expectStatus(await call("/api/admin-revoke-all", { cookie: owner.cookie, csrf: owner.data.csrf, body: { code: totp(ownerMfa.secret) } }), 200, "global emergency logout");
await expectStatus(await call("/api/admin-data", { cookie: owner.cookie }), 401, "global emergency logout revokes current session");

console.log("PASS: private route, MFA, recovery codes, individual admins, emergency Owner lock, recovery, Viewer RBAC, global password reset and global logout.");
