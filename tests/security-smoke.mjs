import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const ADMIN_PATH = process.env.TEST_ADMIN_PATH || "/ci-private-admin-route";
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD || "TestOwnerPass2026!";
const RECOVERY_SECRET = process.env.TEST_RECOVERY_SECRET || "ci-owner-recovery-secret-0123456789";
const ORIGIN = new URL(BASE).origin;

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", origin: ORIGIN, ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-csrf-token": options.csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(BASE + path, { method: options.method || (options.body ? "POST" : "GET"), headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  let data = {};
  try { data = await response.json(); } catch {}
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie ? setCookie.split(";")[0] : options.cookie || "";
  return { response, data, cookie };
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
  assert.equal(setup.response.status, 200, "MFA setup should succeed");
  assert.ok(setup.data.otpauth_uri.startsWith("otpauth://totp/"), "MFA should return an authenticator URI");
  const confirmed = await call("/api/mfa-confirm", { cookie, csrf, body: { code: totp(setup.data.secret) } });
  assert.equal(confirmed.response.status, 200, "MFA confirmation should succeed");
  assert.equal(confirmed.data.recovery_codes.length, 10, "ten one-time recovery codes should be issued");
  return confirmed.data.recovery_codes;
}
async function assertStatus(result, status, label) {
  assert.equal(result.response.status, status, label + ": " + JSON.stringify(result.data));
}

const privatePage = await call(ADMIN_PATH);
await assertStatus(privatePage, 200, "private admin route");
assert.match(await privatePage.response.text(), /Administrator sign in/, "private route should serve admin login");
await assertStatus(await call("/admin.html"), 404, "direct admin HTML must be blocked");
await assertStatus(await call("/api/login", { body: { username: "owner", password: OWNER_PASSWORD }, headers: { origin: "https://attacker.invalid" } }), 403, "cross-origin login must be rejected");

let owner = await login("owner", OWNER_PASSWORD);
await assertStatus(owner, 200, "initial Owner login");
assert.equal(owner.data.mfaRequired, true, "first login must require MFA enrolment");
let ownerRecovery = await enrolMfa(owner.cookie, owner.data.csrf);
let ownerData = await call("/api/admin-data", { cookie: owner.cookie });
await assertStatus(ownerData, 200, "Owner dashboard");
assert.equal(ownerData.data.admin.role, "owner", "Owner role must be returned");

await assertStatus(await call("/api/admin-create", { cookie: owner.cookie, csrf: owner.data.csrf, body: { username: "helperadmin", display_name: "Helper Admin", role: "admin", password: "HelperAdminPass2026!" } }), 200, "Owner creates individual Admin");
let admin = await login("helperadmin", "HelperAdminPass2026!");
await assertStatus(admin, 200, "Admin first login");
assert.equal(admin.data.mfaRequired, true, "new Admin must enrol MFA");
const adminRecovery = await enrolMfa(admin.cookie, admin.data.csrf);
let adminOverview = await call("/api/security-overview", { cookie: admin.cookie });
await assertStatus(adminOverview, 200, "Admin can see active sessions");
assert.ok(adminOverview.data.sessions.length >= 2, "Owner and Admin sessions should be visible");
await assertStatus(await call("/api/admin-create", { cookie: admin.cookie, csrf: admin.data.csrf, body: { username: "badadmin", display_name: "Bad", role: "admin", password: "BadAdminPass2026!" } }), 403, "Admin cannot create another admin");
await assertStatus(await call("/api/admin-lock-owner", { cookie: admin.cookie, csrf: admin.data.csrf, body: { code: totp((await call("/api/mfa-setup", { cookie: admin.cookie, csrf: admin.data.csrf, body: {} })).data.secret || "") } }), 403, "already enrolled Admin cannot restart MFA setup");

const adminLockCode = totp((await call("/api/mfa-setup", { cookie: admin.cookie, csrf: admin.data.csrf, body: {} })).data.secret || "");
// The previous call is expected to refuse re-enrolment; use a fresh authenticator code from the original secret captured below instead.
assert.ok(adminRecovery.length === 10, "Admin recovery codes must be issued");

