const SHEETS = {
  bookings: "Bookings",
  receivers: "Receivers",
  notifications: "Notifications"
};

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function spreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) throw new Error("Set SPREADSHEET_ID in Apps Script project properties.");
  return SpreadsheetApp.openById(id);
}
function setup() {
  const ss = spreadsheet();
  const headers = {
    Bookings: ["id","reference","role","name","phone","origin","destination","via","trip_date","trip_time","created_at","active","status"],
    Receivers: ["id","label","phone","created_at"],
    Notifications: ["pair","created_at"]
  };
  Object.entries(headers).forEach(([name, row]) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(row);
  });
  return "Sheets initialized";
}
function readRows(name) {
  const sh = spreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const keys = values.shift().map(String);
  return values.map(row => Object.fromEntries(keys.map((k, i) => [k, row[i] instanceof Date ? Utilities.formatDate(row[i], "GMT", "yyyy-MM-dd'T'HH:mm:ss'Z'") : row[i]])));
}
function findRow(name, key, value) {
  const sh = spreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return null;
  const data = sh.getDataRange().getValues();
  const idx = data[0].indexOf(key);
  for (let i = 1; i < data.length; i++) if (String(data[i][idx]) === String(value)) return { sheet: sh, row: i + 1, headers: data[0] };
  return null;
}
function doGet() { return json({ ok: true, service: "Booking Bot Sheets API" }); }
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || "{}");
    const expected = PropertiesService.getScriptProperties().getProperty("SHEETS_API_SECRET") || "";
    if (!expected || !req.secret || req.secret !== expected) return json({ ok: false, error: "Unauthorized" });
    const d = req.data || {};
    const ss = spreadsheet();
    const bookings = ss.getSheetByName(SHEETS.bookings);
    const receivers = ss.getSheetByName(SHEETS.receivers);
    const notifications = ss.getSheetByName(SHEETS.notifications);
    let result;
    switch (req.action) {
      case "public_config":
      case "list_receivers":
        result = { receivers: readRows(SHEETS.receivers) }; break;
      case "create_booking": {
        const reference = Utilities.getUuid().replace(/-/g, "").slice(0, 8).toUpperCase();
        const id = Utilities.getUuid();
        const row = [id, reference, d.role, d.name, d.phone, d.origin, d.destination, d.via || "", d.trip_date, d.trip_time, new Date().toISOString(), true, "pending"];
        bookings.appendRow(row);
        result = { id, reference }; break;
      }
      case "list_bookings":
        result = readRows(SHEETS.bookings).reverse(); break;
      case "add_receiver": {
        const id = Utilities.getUuid();
        receivers.appendRow([id, d.label, d.phone, new Date().toISOString()]);
        result = { id, label: d.label, phone: d.phone }; break;
      }
      case "delete_receiver": {
        const found = findRow(SHEETS.receivers, "id", d.id);
        if (found) found.sheet.deleteRow(found.row);
        result = { deleted: !!found }; break;
      }
      case "set_booking_status": {
        const found = findRow(SHEETS.bookings, "id", d.id);
        if (!found) throw new Error("Booking not found");
        const statusCol = found.headers.indexOf("status") + 1;
        const activeCol = found.headers.indexOf("active") + 1;
        if (d.status) found.sheet.getRange(found.row, statusCol).setValue(d.status);
        if (typeof d.active === "boolean") found.sheet.getRange(found.row, activeCol).setValue(d.active);
        result = { updated: true }; break;
      }
      case "update_booking": {
        const found = findRow(SHEETS.bookings, "id", d.id);
        if (!found) throw new Error("Booking not found");
        const allowed = ["name","phone","origin","destination","via","trip_date","trip_time","role"];
        allowed.forEach(k => { if (d[k] !== undefined) found.sheet.getRange(found.row, found.headers.indexOf(k) + 1).setValue(d[k]); });
        result = { updated: true }; break;
      }
      case "delete_booking": {
        const found = findRow(SHEETS.bookings, "id", d.id);
        if (found) found.sheet.deleteRow(found.row);
        result = { deleted: !!found }; break;
      }
      case "notification_exists":
        result = { exists: readRows(SHEETS.notifications).some(x => x.pair === d.pair) }; break;
      case "record_notification":
        notifications.appendRow([d.pair, new Date().toISOString()]);
        result = { saved: true }; break;
      case "count_notifications":
        result = { count: Math.max(0, notifications.getLastRow() - 1) }; break;
      default: throw new Error("Unknown action");
    }
    return json({ ok: true, data: result });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) });
  }
}
