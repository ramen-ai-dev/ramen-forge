/** Worker bindings declared in wrangler.toml and via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  /** Bearer token required by write endpoints. Unset means writes are disabled. */
  FORGE_WRITE_TOKEN?: string;
  /** Enterprise ramen-ai API key used by the community calibration proxy. */
  RAMEN_API_KEY?: string;
  /** Base URL of the ramen-ai gateway for /calibrate and authoritative receipt ledger pulls (default https://api.ramenai.dev). */
  RAMEN_GATEWAY_URL?: string;
}

/** Validated body of POST /api/v1/calibrate. */
export interface CalibrateRequest {
  domain: string;
  tool: string;
  arguments: JsonObject;
  /** Optional: feeds the auto-ingested lesson's task_description on an ALLOW verdict. */
  task_description?: string;
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
  /** Preferred response name for the validated compliant parameter shape. */
  compliant_arguments: JsonObject;
  /** Legacy response alias retained for backward compatibility. */
  repaired_arguments: JsonObject;
  tier: MemoryTier;
  /** Ed25519 signature (base64url) over canonical_payload, for offline verification. */
  signature: string | null;
  /** Exact Schema V5 string signed by ramen-ai. */
  canonical_payload: string | null;
  /** Storage-name aliases of exemplar_id / violation_reason, so list and by-id reads share field names. */
  id: string;
  violation_rule: string;
  /** Community-reported outcomes (POST /api/v1/exemplars/:id/feedback). */
  times_applied: number;
  successful_applications: number;
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
  signature: string | null;
  canonical_payload: string | null;
  times_applied: number;
  successful_applications: number;
}
