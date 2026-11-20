-- Security foundation: individual admin identities, server-side sessions, throttling and audit.
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','viewer')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  mfa_secret_enc TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT '',
  ip_masked TEXT NOT NULL DEFAULT 'hidden',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  mfa_pending INTEGER NOT NULL DEFAULT 0 CHECK(mfa_pending IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS security_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  session_version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO security_state(id,session_version) VALUES(1,1);
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT
);
CREATE TABLE IF NOT EXISTS security_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  event TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_audit_created ON security_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_actor ON security_audit(actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_admin ON admin_recovery_codes(admin_id, used_at);
