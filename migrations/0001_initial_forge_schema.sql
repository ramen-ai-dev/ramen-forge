-- Migration number: 0001 	 initial ramen-forge schema
-- Normalised CorrectionExemplar records for the Level 1 Community Memory Commons.

CREATE TABLE IF NOT EXISTS exemplars (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    task_fingerprint TEXT NOT NULL,
    task_description TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    violation_rule TEXT NOT NULL,
    primary_statutory_anchor TEXT NOT NULL,
    steering_directive TEXT NOT NULL,
    failed_arguments_json TEXT NOT NULL,
    repaired_arguments_json TEXT NOT NULL,
    receipt_id TEXT,
    tier TEXT NOT NULL DEFAULT 'community',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exemplars_domain_tool ON exemplars(domain, tool_name);
CREATE INDEX IF NOT EXISTS idx_exemplars_fingerprint ON exemplars(task_fingerprint);
CREATE INDEX IF NOT EXISTS idx_exemplars_tier ON exemplars(tier);
