-- Migration number: 0004 	 forge hardening

-- 1. Offline Cryptographic Audit Columns
ALTER TABLE exemplars ADD COLUMN signature TEXT;
ALTER TABLE exemplars ADD COLUMN canonical_payload TEXT;

-- 2. Invariant Deduplication Index (Preventing redundant statutory rows)
-- Keyed on the task as well as the violation: distinct lessons can share
-- violation_rule text (e.g. compliant reference actions on one tool).
CREATE UNIQUE INDEX IF NOT EXISTS idx_exemplars_task_invariant
ON exemplars(domain, tool_name, task_fingerprint, violation_rule);

-- 3. Search Miss Telemetry Table (Market demand radar)
CREATE TABLE IF NOT EXISTS domain_demand (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    tool_name TEXT,
    query_text TEXT,
    client_ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demand_domain ON domain_demand(domain);
