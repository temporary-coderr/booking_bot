import { authenticate, handleSecurity } from "./security.js";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const now = () => Date.now();
const indiaNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date()).map(x=>[x.type,x.value])); return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute; };
const clean = (v, n = 100) => String(v ?? "").replace(/[<>]/g, "").trim().replace(/\s+/g, " ").slice(0, n);
const digits = v => String(v ?? "").replace(/\D/g, "").slice(0, 15);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
const terminal = new Set(["completed", "cancelled", "closed", "expired", "rejected"]);
const active = b => Number(b.active) === 1 && !terminal.has(String(b.status).toLowerCase());
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? "")), y = new TextEncoder().encode(String(b ?? ""));
  if (x.length !== y.length) return false;
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]; return diff === 0;
}
async function body(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 16384) return { __invalid_body: true };
  try { const raw = await request.text(); if (raw.length > 16384) return { __invalid_body: true }; return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
async function rateLimit(db, request, label, maximum, windowMs) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(label + "|" + ip));
  const key = b64(bytes), current = now();
  const row = await db.prepare("SELECT request_count,window_started_at,blocked_until FROM api_rate_limits WHERE rate_key=?").bind(key).first();
  if (row?.blocked_until && Date.parse(row.blocked_until) > current) return false;
  if (!row || current - Date.parse(row.window_started_at) >= windowMs) {
    await db.prepare("INSERT INTO api_rate_limits(rate_key,request_count,window_started_at,blocked_until) VALUES(?,1,?,NULL) ON CONFLICT(rate_key) DO UPDATE SET request_count=1,window_started_at=excluded.window_started_at,blocked_until=NULL").bind(key,new Date(current).toISOString()).run();
    return true;
  }
  const count = Number(row.request_count || 0) + 1;
  const blocked = count > maximum ? new Date(current + windowMs).toISOString() : null;
  await db.prepare("UPDATE api_rate_limits SET request_count=?,blocked_until=? WHERE rate_key=?").bind(count,blocked,key).run();
  return count <= maximum;
}
function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
async function activity(db, reference, event) {
  await db.prepare("INSERT INTO activity(reference,event,created_at) VALUES(?,?,?)").bind(reference || "", event, new Date().toISOString()).run();
}
async function expireBookings(db) {
  const setting = await db.prepare("SELECT value FROM settings WHERE key='expiry_hours'").first();
  const hours = [6,12,24].includes(Number(setting?.value)) ? Number(setting.value) : 12;
  const cutoff = new Date(now() - hours * 3600000).toISOString();
  const result = await db.prepare("UPDATE bookings SET active=0,status='expired' WHERE active=1 AND status NOT IN ('completed','cancelled','closed','expired','rejected') AND created_at < ?").bind(cutoff).run();
  return result.meta?.changes || 0;
}
function normalizeLocation(value) {
  const text = String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const aliases = {
    "भोपाल": "bhopal",
    "bhopal city": "bhopal",
    "इंदौर": "indore",
    "इन्दौर": "indore",
    "indore city": "indore",
    "उज्जैन": "ujjain",
    "ujjain city": "ujjain",
    "रतलाम": "ratlam",
    "ratlam city": "ratlam",
    "जावरा": "jaora",
    "जावरा शहर": "jaora",
    "jaora city": "jaora",
    "राघोगढ़": "raghogarh",
    "राघौगढ़": "raghogarh",
    "raghogarh city": "raghogarh",
    "राजगढ़": "rajgarh",
    "rajgarh city": "rajgarh",
    "पचोर": "pachore",
    "pachore city": "pachore"
  };

  return aliases[text] || text;
}

function bookingTime(b) {
  const date = String(b.trip_date || "");
  const time = String(b.trip_time || "");

  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = time.match(/^(\d{2}):(\d{2})$/);

  if (!dm || !tm) return null;

  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);

  if (
    month < 1 || month > 12 ||
    hour > 23 || minute > 59
  ) return null;

  const timestamp = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute
  );

  const check = new Date(timestamp);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) return null;

  return timestamp;
}

function matchReason(a, b) {
  const originA = normalizeLocation(a.origin);
  const originB = normalizeLocation(b.origin);

  if (!originA || !originB || originA !== originB) {
    return "";
  }

  return "Same origin — within 24 hours";
}

function findMatches(bookings) {
  const list = bookings.filter(active);
  const matches = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      if (
        !["driver", "customer"].includes(a.role) ||
        !["driver", "customer"].includes(b.role) ||
        a.role === b.role
      ) continue;

      const timeA = bookingTime(a);
      const timeB = bookingTime(b);

      if (timeA === null || timeB === null) continue;

      const differenceHours =
        Math.abs(timeA - timeB) / 3600000;

      if (differenceHours > 24) continue;

      const reason = matchReason(a, b);

      if (reason) {
        matches.push({ a, b, reason });
      }
    }
  }

  return matches;
}
const summary = b => String(b.role).toUpperCase() + ": " + b.name + "\nRoute: " + b.origin + " → " + b.destination + (b.via ? " via " + b.via : "") + "\nTravel: " + b.trip_date + " at " + b.trip_time + (b.vehicle_type ? "\nVehicle: " + b.vehicle_type : "") + (b.capacity_kg ? " · Capacity: " + b.capacity_kg + " kg" : "") + (b.passenger_count ? " · Passengers: " + b.passenger_count : "") + "\nReference: " + b.reference;
async function sendTelegram(text, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) });
  return r.ok;
}
async function createBooking(request, env) {
  const d = await body(request); if (d.__invalid_body) return json({ok:false,error:"Request body is too large."},413); const role = clean(d.role, 12).toLowerCase();
  const b = { role, name: clean(d.name, 80), phone: digits(d.phone), origin: clean(d.origin, 80), destination: clean(d.destination, 80), via: (Array.isArray(d.via) ? d.via : String(d.via || "").split(",")).map(x => clean(x, 80)).filter(Boolean).slice(0, 5).join(", "), trip_date: clean(d.trip_date, 10), trip_time: clean(d.trip_time, 5), vehicle_type: role === "driver" ? clean(d.vehicle_type, 20).toUpperCase() : "", capacity_kg: role === "driver" && ["TRUCK", "PICKUP"].includes(String(d.vehicle_type).toUpperCase()) ? String(Math.max(0, Number(d.capacity_kg) || 0)) : "", passenger_count: role === "driver" && String(d.vehicle_type).toUpperCase() === "CAR" ? String(Math.max(1, Math.min(20, Number(d.passenger_count) || 1))) : "" };
  if (!["driver", "customer"].includes(role) || !b.name || b.phone.length < 10 || !b.origin || !b.destination || b.origin.toLowerCase() === b.destination.toLowerCase()) return json({ ok: false, error: "Please complete all required details and check your mobile number." }, 400);
  if (role === "driver" && (!["TRUCK", "PICKUP", "CAR", "OTHER"].includes(b.vehicle_type) || (["TRUCK", "PICKUP"].includes(b.vehicle_type) && !Number(b.capacity_kg)) || (b.vehicle_type === "CAR" && !Number(b.passenger_count)))) return json({ ok: false, error: "Please complete the vehicle details." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.trip_date) || !/^\d{2}:\d{2}$/.test(b.trip_time)) return json({ ok: false, error: "Enter a valid travel date and time." }, 400);
  const tripKey = b.trip_date + "T" + b.trip_time, currentIndia = indiaNow();
  const tripMillis = Date.parse(tripKey + ":00Z"), currentMillis = Date.parse(currentIndia + ":00Z");
  if (!Number.isFinite(tripMillis) || tripKey <= currentIndia || tripMillis > currentMillis + 365 * 86400000) return json({ ok: false, error: "Past date or time is not allowed. Choose a future travel time." }, 400);
  const db = env.DB; await expireBookings(db);
  const id = crypto.randomUUID(), reference = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(), created = new Date().toISOString();
  const inserted = await db.prepare("INSERT INTO bookings(id,reference,role,name,phone,origin,destination,via,trip_date,trip_time,created_at,active,status,vehicle_type,capacity_kg,passenger_count) SELECT ?,?,?,?,?,?,?,?,?,?,?,1,'pending',?,?,? WHERE (SELECT COUNT(*) FROM bookings WHERE phone=? AND role=? AND active=1 AND status NOT IN ('completed','cancelled','closed','expired','rejected') AND (trip_date || 'T' || trip_time) > ?) < 5").bind(id, reference, b.role, b.name, b.phone, b.origin, b.destination, b.via, b.trip_date, b.trip_time, created, b.vehicle_type, b.capacity_kg, b.passenger_count, b.phone, role, indiaNow()).run();
  if (!inserted.meta?.changes) return json({ ok: false, error: "This mobile number already has 5 active " + role + " requests. Complete or cancel an existing request before adding another." }, 409);
  if (role === "driver" && d.additional_availability === true) await db.prepare("INSERT INTO driver_availability(booking_id,available_locations,created_at) VALUES(?,?,?)").bind(id, clean(d.available_locations, 500), created).run();
  await activity(db, reference, "booking_created");
  const receivers = await db.prepare("SELECT id,label,phone FROM receivers ORDER BY created_at").all();
  const message = "Yahan booking hai\nBooking type: " + role.toUpperCase() + "\nName: " + b.name + "\nMobile: " + b.phone + "\nRoute: " + b.origin + " → " + b.destination + (b.via ? " via " + b.via : "") + "\nDate & time: " + b.trip_date + " | " + b.trip_time + (b.vehicle_type ? "\nVehicle: " + b.vehicle_type : "") + (b.capacity_kg ? "\nCapacity: " + b.capacity_kg + " kg" : "") + (b.passenger_count ? "\nPassengers: " + b.passenger_count : "") + "\nBooking ID: " + reference;
  const links = (receivers.results || []).map(x => ({ id: x.id, label: x.label, url: "https://wa.me/" + digits(x.phone) + "?text=" + encodeURIComponent(message) }));
  return json({ ok: true, reference, whatsapp_links: links, message: "Booking saved. Share it with the admin on WhatsApp." }, 201);
}
async function adminApi(request, env, path, session) {
  const db = env.DB, method = request.method, d = await body(request);
  if (d.__invalid_body) return json({ok:false,error:"Request body is too large."},413);
  if (method !== "GET" && !await safeEqual(request.headers.get("x-csrf-token"), session.csrf)) return json({ ok: false, error: "Security token expired. Refresh the dashboard." }, 403);
  if (session.role === "viewer" && method !== "GET") return json({ ok: false, error: "Viewer accounts have read-only access." }, 403);
  const ownerOnlyPaths = ["/api/expiry-setting", "/api/receiver-add", "/api/receiver-delete", "/api/help-contact-add", "/api/help-contact-delete"];
  if (ownerOnlyPaths.includes(path) && session.role !== "owner") return json({ ok: false, error: "Owner permission required." }, 403);
  if ((path === "/api/report.csv" || path === "/api/report.xlsx") && session.role === "viewer") return json({ ok: false, error: "Owner or Admin permission required for exports." }, 403);
  const auditSecurity = (event, target = "", metadata = {}) => db.prepare("INSERT INTO security_audit(actor_id,event,target_id,metadata_json,created_at) VALUES(?,?,?,?,?)").bind(session.adminId,event,target,JSON.stringify(metadata),new Date().toISOString()).run();
  if (method === "POST" && path === "/api/telegram-test") {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, error: "Telegram is not configured on the server." }, 503);
    const sent = await sendTelegram("RouteADDA Telegram test successful. Your bot connection is working.", env);
    await activity(db, "", sent ? "telegram_test_sent" : "telegram_test_failed"); await auditSecurity(sent ? "telegram_test_sent" : "telegram_test_failed");
    if (!sent) return json({ ok: false, error: "Telegram rejected the test message. Check the server-side bot token and chat ID." }, 502);
    return json({ ok: true, message: "Test message sent to the configured Telegram chat." });
  }
  if (method === "POST" && path === "/api/admin-match-check") {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, error: "Telegram is not configured on the server." }, 503);
    const expired = await expireBookings(db);
    const result = await db.prepare("SELECT * FROM bookings WHERE active=1").all();
    const matches = findMatches(result.results || []);
    let notified = 0, skipped = 0, failed = 0;
    for (const m of matches) {
      const pair = [m.a.reference, m.b.reference].sort().join(":");
      const known = await db.prepare("SELECT pair FROM notifications WHERE pair=?").bind(pair).first();
      if (known) { skipped++; continue; }
      const sent = await sendTelegram("POSSIBLE DRIVER / CUSTOMER MATCH\n\n" + summary(m.a) + "\n\n" + summary(m.b) + "\n\nMatch: " + m.reason + "\nAdmin: review manually. No customer phone numbers included.", env);
      if (sent) {
        await db.prepare("INSERT OR IGNORE INTO notifications(pair,created_at) VALUES(?,?)").bind(pair, new Date().toISOString()).run();
        notified++;
      } else failed++;
    }
    await activity(db, "", "admin_match_check"); await auditSecurity("admin_match_check","",{notified,failed});
    return json({ ok: true, expired, total_possible_matches: matches.length, matched_pairs_notified: notified, already_notified: skipped, failed });
  }
  if (method === "GET" && path === "/api/activity-history") {
    const url = new URL(request.url);
    const periods = { "1h": 3600000, "6h": 6 * 3600000, "12h": 12 * 3600000, "1d": 86400000, "7d": 7 * 86400000 };
    const period = periods[url.searchParams.get("period")] ? url.searchParams.get("period") : "1d";
    const type = ["all", "whatsapp", "visitors"].includes(url.searchParams.get("type")) ? url.searchParams.get("type") : "all";
    const requestedPage = Number.parseInt(url.searchParams.get("page") || "0", 10);
    const page = Number.isFinite(requestedPage) ? Math.max(0, Math.min(100000, requestedPage)) : 0;
    const since = new Date(now() - periods[period]).toISOString();
    const conditions = ["created_at >= ?"];
    const values = [since];
    if (type === "whatsapp") conditions.push("event = 'whatsapp_link_opened'");
    if (type === "visitors") conditions.push("event <> 'whatsapp_link_opened'");
    const where = conditions.join(" AND ");
    const [count, rows] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS total FROM activity WHERE " + where).bind(...values).first(),
      db.prepare("SELECT id,reference,event,created_at FROM activity WHERE " + where + " ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?").bind(...values, page * 50).all()
    ]);
    const total = Number(count?.total) || 0;
    return json({ ok: true, period, type, page, total, page_size: 50, has_more: (page + 1) * 50 < total, activity: rows.results || [] });
  }
  if (method === "GET" && path === "/api/admin-data") {
    await expireBookings(db);
    const [bookings, receivers, help, notified, settings, availability] = await Promise.all([
      db.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all(), db.prepare("SELECT * FROM receivers ORDER BY created_at").all(),
      db.prepare("SELECT * FROM help_contacts ORDER BY created_at").all(), db.prepare("SELECT COUNT(*) AS n FROM notifications").first(),
      db.prepare("SELECT value FROM settings WHERE key='expiry_hours'").first(),
      db.prepare("SELECT da.*,b.reference,b.name,b.phone,b.origin,b.destination,b.trip_date,b.trip_time FROM driver_availability da JOIN bookings b ON b.id=da.booking_id ORDER BY da.created_at DESC").all()
    ]);
    const rows = bookings.results || [];
    return json({ ok: true, csrf: session.csrf, admin: { username: session.username, display_name: session.displayName, role: session.role }, bookings: rows, receivers: receivers.results || [], help_contacts: help.results || [], notified: notified?.n || 0, matches: findMatches(rows), expiry_hours: Number(settings?.value) || 12, driver_availability: availability.results || [] });
  }
  if (method === "POST" && path === "/api/booking-update") {
    const fields = ["name","phone","origin","destination","via","trip_date","trip_time","role","vehicle_type","capacity_kg","passenger_count"];
    const sets = [], values = []; for (const f of fields) if (d[f] !== undefined) { sets.push(f + "=?"); values.push(f === "phone" ? digits(d[f]) : clean(d[f], 500)); }
    if (!d.id || !sets.length) return json({ ok: false, error: "No booking changes supplied." }, 400);
    values.push(d.id); const r = await db.prepare("UPDATE bookings SET " + sets.join(",") + " WHERE id=?").bind(...values).run();
    if (!r.meta?.changes) return json({ ok: false, error: "Booking not found." }, 404);
    await activity(db, d.reference || "", "admin_edited"); await auditSecurity("booking_edited",d.reference||""); return json({ ok: true, booking: { updated: true } });
  }
  if (method === "POST" && path === "/api/booking-status") {
    const allowed = ["pending","approved","rejected","completed","cancelled","closed","expired"];
    if (d.status && !allowed.includes(d.status)) return json({ ok: false, error: "Invalid booking status." }, 400);
    const activeValue = typeof d.active === "boolean" ? (d.active ? 1 : 0) : undefined;
    const statusValue = d.status || null;
    if (!d.id) return json({ ok: false, error: "Booking ID is required." }, 400);
    if (statusValue && ["rejected","completed","cancelled","closed","expired"].includes(statusValue)) await db.prepare("UPDATE bookings SET status=?,active=0 WHERE id=?").bind(statusValue, d.id).run();
    else if (statusValue && activeValue !== undefined) await db.prepare("UPDATE bookings SET status=?,active=? WHERE id=?").bind(statusValue, activeValue, d.id).run();
    else if (statusValue) await db.prepare("UPDATE bookings SET status=? WHERE id=?").bind(statusValue, d.id).run();
    else if (activeValue !== undefined) await db.prepare("UPDATE bookings SET active=? WHERE id=?").bind(activeValue, d.id).run();
    else return json({ ok: false, error: "No status change supplied." }, 400);
    await auditSecurity("booking_status_changed",d.id||"",{status:statusValue||"",active:activeValue}); return json({ ok: true, booking: { updated: true } });
  }
  if (method === "POST" && path === "/api/booking-delete") {
    await db.prepare("DELETE FROM bookings WHERE id=?").bind(d.id).run(); await activity(db, d.reference || "", "admin_deleted"); await auditSecurity("booking_deleted",d.reference||""); return json({ ok: true });
  }
  if (method === "POST" && path === "/api/expiry-setting") {
    const hours = Number(d.hours); if (![6,12,24].includes(hours)) return json({ ok: false, error: "Choose 6, 12 or 24 hours." }, 400);
    await db.prepare("INSERT INTO settings(key,value) VALUES('expiry_hours',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(hours)).run(); await auditSecurity("expiry_setting_changed","",{hours}); return json({ ok: true, expiry_hours: hours });
  }
  if (method === "POST" && path === "/api/receiver-add") {
    const label = clean(d.label,50), phone = digits(d.phone); if (!label || phone.length < 10) return json({ ok: false, error: "Enter a label and valid number including country code." }, 400);
    const id = crypto.randomUUID(); await db.prepare("INSERT INTO receivers(id,label,phone,created_at) VALUES(?,?,?,?)").bind(id,label,phone,new Date().toISOString()).run(); await auditSecurity("whatsapp_receiver_added",id,{label}); return json({ ok: true, receiver: { id,label,phone } });
  }
  if (method === "POST" && path === "/api/receiver-delete") { await db.prepare("DELETE FROM receivers WHERE id=?").bind(d.id).run(); await auditSecurity("whatsapp_receiver_deleted",d.id||""); return json({ ok: true }); }
  if (method === "POST" && path === "/api/help-contact-add") {
    const phone = digits(d.phone); if (phone.length < 10) return json({ ok:false,error:"Enter a valid WhatsApp number including country code." },400);
    const existing = await db.prepare("SELECT label FROM help_contacts").all(); const labels = new Set((existing.results||[]).map(x=>x.label)); if (labels.size >= 5) return json({ ok:false,error:"You can configure up to 5 help contacts." },409);
    let number=1; while(labels.has("Contact Admin "+number)) number++; const id=crypto.randomUUID(), label="Contact Admin "+number; await db.prepare("INSERT INTO help_contacts(id,label,phone,created_at) VALUES(?,?,?,?)").bind(id,label,phone,new Date().toISOString()).run(); await auditSecurity("help_contact_added",id,{label}); return json({ ok:true,contact:{id,label,phone} });
  }
  if (method === "POST" && path === "/api/help-contact-delete") { await db.prepare("DELETE FROM help_contacts WHERE id=?").bind(d.id).run(); await auditSecurity("help_contact_deleted",d.id||""); return json({ok:true}); }
  if (method === "GET" && path === "/api/report.xlsx") {
    await auditSecurity("booking_export_xlsx"); const rows = await db.prepare("SELECT b.*, da.available_locations FROM bookings b LEFT JOIN driver_availability da ON da.booking_id = b.id").all();
    const keys = ["id","reference","role","name","phone","origin","destination","via","trip_date","trip_time","created_at","active","status","vehicle_type","capacity_kg","passenger_count","available_locations"];
    const labels = ["Booking ID","Reference","Role","Name","Mobile Number","Origin","Destination","Via","Travel Date","Travel Time","Submitted At","Active","Status","Vehicle","Capacity (kg)","Passengers","Additional Availability"];
    const escXml = value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
    const colName = n => { let s=""; for(n++;n;n=Math.floor((n-1)/26)) s=String.fromCharCode(65+(n-1)%26)+s; return s; };
    const makeSheet = (role) => {
      const list = (rows.results || []).filter(r => r.role === role).sort((a,b) => {
        const pa=String(a.phone||"").replace(/\D/g,""), pb=String(b.phone||"").replace(/\\D/g,"");
        return pa.localeCompare(pb,undefined,{numeric:true}) || String(a.trip_date||"").localeCompare(String(b.trip_date||"")) || String(a.trip_time||"").localeCompare(String(b.trip_time||""));
      });
      const all = [labels, ...list.map(r => keys.map(k => r[k]))];
      const rowXml = all.map((values,ri) => '<row r="'+(ri+1)+'">'+values.map((v,ci) => '<c r="'+colName(ci)+(ri+1)+'" t="inlineStr"><is><t xml:space="preserve">'+escXml(v)+'</t></is></c>').join("")+'</row>').join("");
      const widths = [38,14,12,22,20,18,18,30,14,12,25,10,14,14,14,12,32].map((w,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+w+'" customWidth="1"/>').join("");
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>'+widths+'</cols><sheetData>'+rowXml+'</sheetData><autoFilter ref="A1:Q'+all.length+'"/></worksheet>';
    };
    const files = [
      ["[Content_Types].xml",'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ["_rels/.rels",'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml",'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Drivers" sheetId="1" r:id="rId1"/><sheet name="Customers" sheetId="2" r:id="rId2"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels",'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'],
      ["xl/worksheets/sheet1.xml",makeSheet("driver")],
      ["xl/worksheets/sheet2.xml",makeSheet("customer")]
    ];
    const encoder = new TextEncoder();
    const crc32 = bytes => { let c=0xffffffff; for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);} return (c^0xffffffff)>>>0; };
    const chunks=[], central=[]; let offset=0;
    const put16=(v,n)=>v.setUint16(n,0,true), put32=(v,n,x)=>v.setUint32(n,x>>>0,true);
    for(const [name,content] of files){
      const nb=encoder.encode(name), data=encoder.encode(content), crc=crc32(data);
      const local=new Uint8Array(30+nb.length), lv=new DataView(local.buffer);
      put32(lv,0,0x04034b50); put16(lv,4,20); put16(lv,6,0x0800); put16(lv,8,0); put32(lv,14,crc); put32(lv,18,data.length); put32(lv,22,data.length); put16(lv,26,nb.length); local.set(nb,30);
      chunks.push(local,data);
      const dir=new Uint8Array(46+nb.length), dv=new DataView(dir.buffer);
      put32(dv,0,0x02014b50); put16(dv,4,20); put16(dv,6,20); put16(dv,8,0x0800); put16(dv,10,0); put32(dv,16,crc); put32(dv,20,data.length); put32(dv,24,data.length); put16(dv,28,nb.length); put32(dv,42,offset); dir.set(nb,46);
      central.push(dir); offset+=local.length+data.length;
    }
    const centralSize=central.reduce((n,b)=>n+b.length,0), end=new Uint8Array(22), ev=new DataView(end.buffer);
    put32(ev,0,0x06054b50); put16(ev,8,files.length); put16(ev,10,files.length); put32(ev,12,centralSize); put32(ev,16,offset);
    const output=new Uint8Array(offset+centralSize+end.length); let pos=0;
    for(const part of [...chunks,...central,end]){output.set(part,pos);pos+=part.length;}
    return new Response(output,{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":'attachment; filename="routeadda-bookings.xlsx"',"cache-control":"no-store"}});
  }
  if (method === "GET" && path === "/api/report.csv") {
    await auditSecurity("booking_export_csv"); const rows = await db.prepare("SELECT b.*, da.available_locations FROM bookings b LEFT JOIN driver_availability da ON da.booking_id=b.id ORDER BY b.trip_date,b.trip_time").all();
    const keys = ["id","reference","role","name","phone","origin","destination","via","trip_date","trip_time","created_at","active","status","vehicle_type","capacity_kg","passenger_count","available_locations"];
    const csv = [keys.join(","),...(rows.results||[]).map(r=>keys.map(k=>'"'+String(r[k]??"").replace(/"/g,'""')+'"').join(","))].join("\r\n");
    return new Response(csv,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="routeadda-bookings.csv"',"cache-control":"no-store"}});
  }
  return json({ ok: false, error: "Not found." }, 404);
}
export default {
 async fetch(request, env) {
  const url = new URL(request.url), path = url.pathname;
  const harden = response => {
   const headers = new Headers(response.headers);
   headers.set("X-Content-Type-Options","nosniff");
   headers.set("X-Frame-Options","DENY");
   headers.set("Referrer-Policy","no-referrer");
   headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");
   headers.set("Content-Security-Policy","default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
   if(path.startsWith("/api/") || path === String(env.ADMIN_PATH || "")) headers.set("Cache-Control","no-store");
   return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  };
  try {
   const adminPath = String(env.ADMIN_PATH || "");
   if (adminPath && adminPath.startsWith("/") && !adminPath.includes("?") && !adminPath.includes("#") && path === adminPath) {
    if(request.method !== "GET") return harden(new Response("Method not allowed.",{status:405}));
    const assetRequest = new Request(new URL("/admin.html",url).toString(),{method:"GET",headers:request.headers});
    return harden(await env.ASSETS.fetch(assetRequest));
   }
   if (path === "/admin.html" || path === "/control" || path.startsWith("/control/")) return harden(new Response("Not found.",{status:404}));
   if (!path.startsWith("/api/")) return harden(await env.ASSETS.fetch(request));
   if (path === "/api/public-config" && request.method === "GET") {
    if (!await rateLimit(env.DB,request,"public-config",90,60000)) return harden(json({ok:false,error:"Too many requests. Please try again shortly."},429));
    const [receivers,help] = await Promise.all([env.DB.prepare("SELECT id,label,phone FROM receivers ORDER BY created_at").all(),env.DB.prepare("SELECT id,label,phone FROM help_contacts ORDER BY created_at").all()]);
    return harden(json({ok:true,receivers:receivers.results||[],help_contacts:help.results||[]}));
   }
   if (path === "/api/bookings" && request.method === "POST") { if (!sameOriginRequest(request)) return harden(json({ok:false,error:"Request origin rejected."},403)); if (!await rateLimit(env.DB,request,"public-booking",10,15*60*1000)) return harden(json({ok:false,error:"Too many booking requests. Please wait and try again."},429)); return harden(await createBooking(request, env)); }
   if (path === "/api/booking-edit") return harden(json({ok:false,error:"Public booking edits are disabled. Please contact an administrator on WhatsApp."},403));
   if (path === "/api/whatsapp-click" && request.method === "POST") { if (!sameOriginRequest(request)) return harden(json({ok:false,error:"Request origin rejected."},403)); if (!await rateLimit(env.DB,request,"whatsapp-click",50,5*60*1000)) return harden(json({ok:false,error:"Too many requests."},429)); const d=await body(request); if(d.__invalid_body)return harden(json({ok:false,error:"Request body is too large."},413)); await activity(env.DB,clean(d.reference,20),"whatsapp_link_opened"); return harden(json({ok:true})); }
   const session = await authenticate(request,env);
   const securityResponse = await handleSecurity(request,env,path,session);
   if (securityResponse) return harden(securityResponse);
   if (!session) return harden(json({ok:false,error:"Please sign in again."},401));
   if (request.method !== "GET" && request.headers.get("origin") && new URL(request.headers.get("origin")).host !== url.host) return harden(json({ok:false,error:"Request origin rejected."},403));
   return harden(await adminApi(request,env,path,session));
  } catch (error) {
   console.error("RouteADDA Worker error",String(error?.message || "unknown"));
   return harden(json({ok:false,error:"Server error. Please try again."},500));
  }
 },
 async scheduled(controller, env, ctx) {
  ctx.waitUntil((async()=>{ const expired=await expireBookings(env.DB), r=await env.DB.prepare("SELECT * FROM bookings WHERE active=1").all(), matches=findMatches(r.results||[]);
   for(const m of matches){const pair=[m.a.reference,m.b.reference].sort().join(":");const known=await env.DB.prepare("SELECT pair FROM notifications WHERE pair=?").bind(pair).first();if(known)continue;const ok=await sendTelegram("POSSIBLE DRIVER / CUSTOMER MATCH\n\n"+summary(m.a)+"\n\n"+summary(m.b)+"\n\nMatch: "+m.reason+"\nAdmin: review manually. No customer phone numbers included.",env);if(ok)await env.DB.prepare("INSERT OR IGNORE INTO notifications(pair,created_at) VALUES(?,?)").bind(pair,new Date().toISOString()).run();}
  })());
 }
};
