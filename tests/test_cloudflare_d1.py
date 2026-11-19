import sqlite3
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone


class CloudflareD1SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(Path("migrations/0001_initial.sql").read_text())
        self.now = datetime.now(timezone.utc).isoformat()

    def add_booking(self, phone, role="driver", status="pending", active=1, ref=None):
        ref = ref or f"REF{self.db.execute('SELECT COUNT(*) FROM bookings').fetchone()[0]}"
        self.db.execute(
            """INSERT INTO bookings
            (id,reference,role,name,phone,origin,destination,via,trip_date,trip_time,
             created_at,active,status,vehicle_type,capacity_kg,passenger_count)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ref, ref, role, "Test User", phone, "Jaora", "Indore", "", "2099-01-01",
             "10:00", self.now, active, status, "", "", "")
        )
        self.db.commit()
        return ref

    def test_five_driver_requests_and_five_customer_requests_are_separate(self):
        phone = "919876543210"
        for n in range(5):
            self.add_booking(phone, "driver", ref=f"D{n}")
        self.add_booking(phone, "customer", ref="C0")
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM bookings WHERE phone=? AND role='driver' AND active=1",
            (phone,)
        ).fetchone()[0], 5)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM bookings WHERE phone=? AND role='customer' AND active=1",
            (phone,)
        ).fetchone()[0], 1)

    def test_completed_booking_frees_a_slot_but_record_remains(self):
        phone = "919876543210"
        for n in range(5):
            self.add_booking(phone, "driver", status="pending", ref=f"D{n}")
        self.db.execute("UPDATE bookings SET status='completed',active=0 WHERE reference='D0'")
        active_count = self.db.execute(
            """SELECT COUNT(*) FROM bookings WHERE phone=? AND role='driver' AND active=1
            AND status NOT IN ('completed','cancelled','closed','expired','rejected')
            AND (trip_date || 'T' || trip_time || ':00') > ?""",
            (phone, datetime.now(timezone.utc).isoformat())
        ).fetchone()[0]
        self.assertEqual(active_count, 4)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM bookings WHERE reference='D0'").fetchone()[0], 1)

    def test_expiry_marks_record_instead_of_deleting(self):
        ref = self.add_booking("919876543210", ref="EXP1")
        old = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
        self.db.execute("UPDATE bookings SET created_at=? WHERE reference=?", (old, ref))
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat()
        self.db.execute(
            """UPDATE bookings SET active=0,status='expired' WHERE active=1
            AND status NOT IN ('completed','cancelled','closed','expired','rejected')
            AND created_at < ?""", (cutoff,)
        )
        row = self.db.execute("SELECT active,status FROM bookings WHERE reference=?", (ref,)).fetchone()
        self.assertEqual(row, (0, "expired"))

    def test_driver_availability_is_stored_separately(self):
        ref = self.add_booking("919876543210", ref="DRV1")
        self.db.execute(
            "INSERT INTO driver_availability(booking_id,available_locations,created_at) VALUES(?,?,?)",
            (ref, "Jaora, Ratlam", self.now)
        )
        self.assertEqual(self.db.execute(
            "SELECT available_locations FROM driver_availability WHERE booking_id=?", (ref,)
        ).fetchone()[0], "Jaora, Ratlam")

    def test_notification_pair_is_unique(self):
        self.db.execute("INSERT INTO notifications(pair,created_at) VALUES('A:B',?)", (self.now,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO notifications(pair,created_at) VALUES('A:B',?)", (self.now,))


if __name__ == "__main__":
    unittest.main()
