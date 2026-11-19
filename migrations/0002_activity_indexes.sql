CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_event_created_at ON activity(event, created_at DESC);
