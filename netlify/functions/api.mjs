import crypto from "node:crypto";

const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const dec = (v) => JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
const secret = () => process.env.SESSION_SECRET || "";
const cookieName = "booking_admin";
const now = () => Math.floor(Date.now() / 1000);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sign = (value) => crypto.createHmac("sha256", secret()).update(value).digest("base64url");
function makeSession(csrf) {
  const payload = enc({ admin: true, exp: now() + 8 * 3600, csrf });
  return payload + "." + sign(payload);
}
function readSession(event) {
  const raw = (event.headers.cookie || event.headers.Cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  if (!raw || !secret()) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = dec(payload);
    return data.admin && data.exp > now() ? data : null;
  } catch { return null; }
}
const json = (statusCode, body, headers = {}) => ({
  statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  body: JSON.stringify(body)
});
const cookie = (value, maxAge = 28800) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
async function sheet(action, data = {}) {
  const url = process.env.GOOGLE_SHEET_URL;
  const key = process.env.SHEETS_API_SECRET;
  if (!url || !key) throw new Error("Google Sheets connection is not configured.");
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: key, action, data })
  });
  if (!response.ok) throw new Error("Google Sheets request failed (" + response.status + ").");
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Google Sheets operation failed.");
  return result.data;
}
const clean = (v, n = 100) => String(v ?? "").replace(/[<>]/g, "").trim().replace(/\s+/g, " ").slice(0, n);
const phoneDigits = (v) => String(v ?? "").replace(/[^\d]/g, "").slice(0, 15);
function routePoints(b) {
  return [b.origin, ...(b.via || "").split(","), b.destination].map(x => clean(x, 100).toLowerCase()).filter(Boolean);
}
function matchReason(a, b) {
  const pa = routePoints(a), pb = routePoints(b);
  const sa = new Set(pa.slice(0, -1).map((x, i) => x + "→" + pa[i + 1]));
  if (pb.slice(0, -1).some((x, i) => sa.has(x + "→" + pb[i + 1]))) return "overlapping route";
  if (pa[0] === pb[0] && pa.at(-1) === pb.at(-1)) return "same route";
  if (pa.slice(1, -1).some(x => pb.includes(x)) || pb.slice(1, -1).some(x => pa.includes(x))) return "via/connecting route";
  return "";
}
function findMatches(bookings) {
  const out = [];
  const active = bookings.filter(x => String(x.active) !== "false" && String(x.active) !== "0");
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    if (a.role === b.role || a.trip_date !== b.trip_date) continue;
    const mins = Math.abs(new Date(a.trip_date + "T" + a.trip_time).getTime() - new Date(b.trip_date + "T" + b.trip_time).getTime()) / 60000;
    if (mins > 180) continue;
    const reason = matchReason(a, b);
    if (reason) out.push({ a, b, reason });
  }
  return out;
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  return r.ok;
}
const summary = b => `${String(b.role).toUpperCase()}: ${b.name}\nRoute: ${b.origin} → ${b.destination}${b.via ? " via " + b.via : ""}\nTravel: ${b.trip_date} at ${b.trip_time}\nReference: ${b.reference}`;

export default async (event) => {
  const method = event.httpMethod;
  const body = (() => { try { return JSON.parse(event.body || "{}"); } catch { return {}; } })();
  const path = event.path || "";
  try {
    if (method === "GET" && path.endsWith("/public-config")) {
      const data = await sheet("public_config");
      return json(200, { ok: true, receivers: data.receivers || [] });
    }
    if (method === "POST" && path.endsWith("/bookings")) {
      const role = clean(body.role, 12).toLowerCase();
      const booking = {
        role, name: clean(body.name, 80), phone: phoneDigits(body.phone),
        origin: clean(body.origin, 80), destination: clean(body.destination, 80),
        via: clean(body.via, 160), trip_date: clean(body.trip_date, 10),
        trip_time: clean(body.trip_time, 5)
      };
      if (!["driver", "customer"].includes(role) || !booking.name || booking.phone.length < 10 ||
          !booking.origin || !booking.destination || booking.origin.toLowerCase() === booking.destination.toLowerCase()) {
        return json(400, { ok: false, error: "Please check your name, mobile number and route details." });
      }
      const trip = new Date(booking.trip_date + "T" + booking.trip_time);
      if (!Number.isFinite(trip.getTime()) || trip.getTime() < Date.now() || trip.getTime() > Date.now() + 365 * 86400000) {
        return json(400, { ok: false, error: "Please choose a valid future date and time." });
      }
      const saved = await sheet("create_booking", booking);
      const receivers = await sheet("public_config");
      const msg = `New ${role} booking | Ref ${saved.reference}\nName: ${booking.name}\nMobile: ${booking.phone}\nRoute: ${booking.origin} to ${booking.destination}${booking.via ? " via " + booking.via : ""}\nDate: ${booking.trip_date} | Time: ${booking.trip_time}`;
      const links = (receivers.receivers || []).map(r => ({
        label: r.label, url: "https://wa.me/" + phoneDigits(r.phone) + "?text=" + encodeURIComponent(msg)
      }));
      return json(201, { ok: true, reference: saved.reference, whatsapp_links: links, message: "Booking saved successfully. Choose a WhatsApp contact if you want to send the details." });
    }
    if (method === "POST" && path.endsWith("/login")) {
      if (!secret() || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_URL_TOKEN) return json(503, { ok: false, error: "Admin security is not configured." });
      if (!safeEqual(body.token, process.env.ADMIN_URL_TOKEN)) return json(404, { ok: false, error: "Not found." });
      if (!safeEqual(body.password, process.env.ADMIN_PASSWORD)) return json(401, { ok: false, error: "Incorrect password." });
      const csrf = crypto.randomBytes(32).toString("base64url");
      return json(200, { ok: true, csrf }, { "set-cookie": cookie(makeSession(csrf)) });
    }
    if (method === "POST" && path.endsWith("/logout")) {
      return json(200, { ok: true }, { "set-cookie": cookie("", 0) });
    }
    if (method === "POST" && path.endsWith("/match-check")) {
      if (!process.env.CRON_SECRET || !safeEqual(event.headers["x-cron-secret"], process.env.CRON_SECRET)) return json(404, { ok: false });
      const bookings = await sheet("list_bookings");
      const matches = findMatches(bookings || []);
      let notified = 0;
      for (const m of matches) {
        const pair = [m.a.reference, m.b.reference].sort().join(":");
        const known = await sheet("notification_exists", { pair });
        if (known.exists) continue;
        const ok = await sendTelegram("POSSIBLE DRIVER / CUSTOMER MATCH\n\n" + summary(m.a) + "\n\n" + summary(m.b) + "\n\nMatch type: " + m.reason + "\nAdmin: review and decide whether to contact either party. Phone numbers are not included.");
        if (ok) { await sheet("record_notification", { pair }); notified++; }
      }
      return json(200, { ok: true, matched_pairs_notified: notified });
    }
    const session = readSession(event);
    if (!session) return json(401, { ok: false, error: "Please sign in again." });
    if (method !== "GET" && !safeEqual(event.headers["x-csrf-token"], session.csrf)) return json(403, { ok: false, error: "Security token expired. Refresh the dashboard." });
    if (method === "GET" && path.endsWith("/admin-data")) {
      const [bookings, receivers, notified] = await Promise.all([sheet("list_bookings"), sheet("list_receivers"), sheet("count_notifications")]);
      return json(200, { ok: true, csrf: session.csrf, bookings, receivers, notified: notified.count, matches: findMatches(bookings || []) });
    }
    if (method === "POST" && path.endsWith("/booking-update")) {
      return json(200, { ok: true, booking: await sheet("update_booking", body) });
    }
    if (method === "POST" && path.endsWith("/booking-status")) {
      return json(200, { ok: true, booking: await sheet("set_booking_status", body) });
    }
    if (method === "POST" && path.endsWith("/booking-delete")) {
      await sheet("delete_booking", body); return json(200, { ok: true });
    }
    if (method === "POST" && path.endsWith("/receiver-add")) {
      const label = clean(body.label, 50), phone = phoneDigits(body.phone);
      if (!label || phone.length < 10 || phone.length > 15) return json(400, { ok: false, error: "Enter a label and a valid number including country code." });
      return json(200, { ok: true, receiver: await sheet("add_receiver", { label, phone }) });
    }
    if (method === "POST" && path.endsWith("/receiver-delete")) {
      await sheet("delete_receiver", body); return json(200, { ok: true });
    }
    if (method === "POST" && path.endsWith("/manual-match-alert")) {
      const m = body.match || {};
      const ok = await sendTelegram("ADMIN MATCH UPDATE\n\n" + summary(m.a || {}) + "\n\n" + summary(m.b || {}) + "\n\n" + clean(m.reason, 60));
      return json(200, { ok });
    }
    return json(404, { ok: false, error: "Not found." });
  } catch (error) {
    console.error("Booking API error:", error);
    return json(500, { ok: false, error: error.message || "Server error." });
  }
};
