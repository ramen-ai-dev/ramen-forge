-- Migration number: 0002 	 hourly rate-limit counters for POST /api/v1/calibrate
-- client_key is SHA-256 of the client IP (raw IPs are never stored).
-- window_start is the hour bucket (unix ms / 3,600,000). Old rows are purged on write.

CREATE TABLE IF NOT EXISTS rate_limits (
    client_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
