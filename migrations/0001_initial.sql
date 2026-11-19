CREATE TABLE IF NOT EXISTS bookings (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('driver','customer')),
 name TEXT NOT NULL, phone TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL, via TEXT DEFAULT '',
 trip_date TEXT NOT NULL, trip_time TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending', vehicle_type TEXT DEFAULT '', capacity_kg TEXT DEFAULT '', passenger_count TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bookings_phone_role_active ON bookings(phone,role,active,status);
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_date,trip_time);
CREATE TABLE IF NOT EXISTS driver_availability (
 booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE, available_locations TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receivers (id TEXT PRIMARY KEY,label TEXT NOT NULL,phone TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS help_contacts (id TEXT PRIMARY KEY,label TEXT NOT NULL,phone TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (pair TEXT PRIMARY KEY,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT,reference TEXT NOT NULL DEFAULT '',event TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO settings(key,value) VALUES('expiry_hours','12');
