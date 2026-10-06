/**
 * Append-only calibration telemetry (table `calibration_attempts`, migration 0006).
 *
 * Every evaluated POST /api/v1/calibrate attempt is logged here verbatim: agent
 * label, candidate arguments, exact evaluated input, verdict and receipt. It is
 * the raw event stream. The deduplicated `exemplars` table is the canonical
 * commons that these events are merged into, and this table is never served by
 * any public endpoint.
 */

export const CALIBRATION_ATTEMPT_COLUMNS = [
  "id",
  "agent_pubkey",
  "domain",
  "tool_name",
  "task_fingerprint",
  "task_description",
  "arguments_json",
  "evaluated_input",
  "verdict",
  "violation_rule",
  "steering_directive",
  "primary_statutory_anchor",
  "receipt_id",
  "receipt_json",
  "receipt_verified",
  "error",
  "client_ip_hash",
  "created_at",
] as const;

const TELEMETRY_INSERT_SQL =
  `INSERT INTO calibration_attempts (${CALIBRATION_ATTEMPT_COLUMNS.join(", ")}) ` +
  `VALUES (${CALIBRATION_ATTEMPT_COLUMNS.map(() => "?").join(", ")})`;

export interface CalibrationAttempt {
  agentPubkey: string | null;
  domain: string;
  toolName: string;
  taskFingerprint: string;
  taskDescription: string;
  argumentsJson: string;
  evaluatedInput: string | null;
  /** 0 = BLOCK, 1 = ALLOW, null = the upstream evaluation failed. */
  verdict: 0 | 1 | null;
  violationRule: string | null;
  steeringDirective: string | null;
  primaryStatutoryAnchor: string | null;
  receiptId: string | null;
  receiptJson: string | null;
  receiptVerified: boolean;
  error: string | null;
  clientIpHash: string;
}

/** Append one attempt to the telemetry log. Throws on D1 failure; callers log and continue. */
export async function recordCalibrationAttempt(db: D1Database, attempt: CalibrationAttempt): Promise<void> {
  await db
    .prepare(TELEMETRY_INSERT_SQL)
    .bind(
      crypto.randomUUID(),
      attempt.agentPubkey,
      attempt.domain,
      attempt.toolName,
      attempt.taskFingerprint,
      attempt.taskDescription,
      attempt.argumentsJson,
      attempt.evaluatedInput,
      attempt.verdict,
      attempt.violationRule,
      attempt.steeringDirective,
      attempt.primaryStatutoryAnchor,
      attempt.receiptId,
      attempt.receiptJson,
      attempt.receiptVerified ? 1 : 0,
      attempt.error,
      attempt.clientIpHash,
      new Date().toISOString(),
    )
    .run();
}

/** The failure half of a pair, as recorded on Turn 1. */
export interface PriorBlock {
  arguments_json: string;
  violation_rule: string;
  steering_directive: string;
  primary_statutory_anchor: string | null;
}

/**
 * Find the most recent verified BLOCK from the same agent for the same task:
 * composite key (agent_pubkey, domain, tool_name, task_fingerprint). An attempt
 * without an agent label is never paired.
 */
export async function findPriorBlock(
  db: D1Database,
  agentPubkey: string | null,
  domain: string,
  toolName: string,
  taskFingerprint: string,
): Promise<PriorBlock | null> {
  if (!agentPubkey) return null;
  return db
    .prepare(
      "SELECT arguments_json, violation_rule, steering_directive, primary_statutory_anchor FROM calibration_attempts " +
        "WHERE agent_pubkey = ? AND domain = ? AND tool_name = ? AND task_fingerprint = ? " +
        "AND verdict = 0 AND receipt_verified = 1 AND violation_rule IS NOT NULL AND steering_directive IS NOT NULL " +
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(agentPubkey, domain, toolName, taskFingerprint)
    .first<PriorBlock>();
}
