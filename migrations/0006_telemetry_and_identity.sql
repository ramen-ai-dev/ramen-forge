-- Migration number: 0006 	 agent identity + calibration telemetry split

-- 1. Append-only telemetry log: one row per evaluated POST /api/v1/calibrate attempt.
--    This is the raw record (every attempt, every verdict, duplicates included). It is
--    never served by any public endpoint; the deduplicated `exemplars` table is the
--    canonical commons that these events are merged into.
--    agent_pubkey is an unverified label (X-Agent-Pubkey header, normalised to 64 hex
--    characters), used for adoption telemetry and Turn 1 / Turn 2 pairing only.
--    verdict is 0 (BLOCK), 1 (ALLOW) or NULL when the upstream evaluation failed.
CREATE TABLE IF NOT EXISTS calibration_attempts (
    id TEXT PRIMARY KEY,
    agent_pubkey TEXT,
    domain TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    task_fingerprint TEXT NOT NULL,
    task_description TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    evaluated_input TEXT,
    verdict INTEGER CHECK (verdict IN (0, 1)),
    violation_rule TEXT,
    steering_directive TEXT,
    primary_statutory_anchor TEXT,
    receipt_id TEXT,
    receipt_json TEXT,
    receipt_verified INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    client_ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Pairing lookup: (agent_pubkey, domain, tool_name, task_fingerprint) + latest BLOCK.
CREATE INDEX IF NOT EXISTS idx_calibration_attempts_pairing
ON calibration_attempts(agent_pubkey, domain, tool_name, task_fingerprint, verdict, created_at);

CREATE INDEX IF NOT EXISTS idx_calibration_attempts_domain_tool
ON calibration_attempts(domain, tool_name);

-- Append-only, same stance as the exemplars table (migration 0003).
CREATE TRIGGER IF NOT EXISTS prevent_calibration_attempt_deletion
BEFORE DELETE ON calibration_attempts
BEGIN
    SELECT RAISE(FAIL, 'Deletions from the calibration_attempts table are permanently prohibited.');
END;

CREATE TRIGGER IF NOT EXISTS prevent_calibration_attempt_update
BEFORE UPDATE ON calibration_attempts
BEGIN
    SELECT RAISE(FAIL, 'Updates to the calibration_attempts table are permanently prohibited.');
END;

-- 2. The agent that first contributed the canonical lesson (nullable, unverified label).
--    Written on first insert only; never part of the upsert's DO UPDATE SET.
ALTER TABLE exemplars ADD COLUMN agent_pubkey TEXT;
