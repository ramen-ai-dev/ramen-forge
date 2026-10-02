/** Worker bindings declared in wrangler.toml and via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  /** Bearer token required by write endpoints. Unset means writes are disabled. */
  FORGE_WRITE_TOKEN?: string;
  /** Enterprise ramen-ai API key used by the community calibration proxy. */
  RAMEN_API_KEY?: string;
}

/** Validated body of POST /api/v1/calibrate. */
export interface CalibrateRequest {
  domain: string;
  tool: string;
  arguments: JsonObject;
}

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** Memory tier. Level 0 is local-only and never reaches ramen-forge. */
export type MemoryTier = "community" | "enterprise";

/**
 * Normalised CorrectionExemplar as accepted on the wire.
 *
 * Field names mirror `ramen_foundry.core.memory.CorrectionExemplar.to_dict()`
 * so foundry agents can post and rehydrate records without translation, plus
 * the two forge-specific fields `domain` and `task_description`.
 */
export interface CorrectionExemplarInput {
  exemplar_id: string;
  domain: string;
  task_description: string;
  task_fingerprint: string;
  tool_name: string;
  failed_arguments: JsonObject;
  violation_reason: string;
  primary_statutory_anchor: string;
  steering_directive: string;
  repaired_arguments: JsonObject;
  receipt_id: string | null;
  created_at: string;
}

/** Exemplar as served back to agents. */
export interface CorrectionExemplarRecord extends CorrectionExemplarInput {
  tier: MemoryTier;
}

/** Row shape of the `exemplars` D1 table. */
export interface ExemplarRow {
  id: string;
  domain: string;
  task_fingerprint: string;
  task_description: string;
  tool_name: string;
  violation_rule: string;
  primary_statutory_anchor: string;
  steering_directive: string;
  failed_arguments_json: string;
  repaired_arguments_json: string;
  receipt_id: string | null;
  tier: MemoryTier;
  created_at: string;
}
