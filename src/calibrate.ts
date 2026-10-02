/**
 * Community calibration proxy: evaluates one tool call against the ramen-ai
 * policy bundle for its domain using the forge's Enterprise RAMEN_API_KEY.
 */
import { verifyReceipt, type EvaluationResponse, type RamenReceipt } from "@ramen-ai/node-core";
import type { CalibrateRequest } from "./types";

export const RAMEN_EVALUATE_URL = "https://api.ramenai.dev/api/v1/paas/evaluate";
export const CALIBRATE_LIMIT_PER_HOUR = 50;
const HOUR_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;

export const DOMAIN_BUNDLES: Readonly<Record<string, string>> = {
  fintech: "ramen__fintech_banking_invariance",
  industrial_iot: "ramen__industrial_iot_actuation_invariance",
  robotics: "ramen__industrial_iot_actuation_invariance",
  devsecops: "ramen__shield_core_it",
};

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window resets. */
  resetAt: number;
}

async function hashClientKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`calibrate:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fixed one-hour window counter in D1. The upsert is a single atomic
 * statement, so concurrent requests cannot both read a stale count. Rows from
 * earlier windows are purged in the same batch.
 */
export async function consumeRateLimit(db: D1Database, ip: string, now = Date.now()): Promise<RateLimitDecision> {
  const window = Math.floor(now / HOUR_MS);
  const clientKey = await hashClientKey(ip);
  const [, counted] = await db.batch<{ request_count: number }>([
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(window),
    db
      .prepare(
        "INSERT INTO rate_limits (client_key, window_start, request_count) VALUES (?, ?, 1) " +
          "ON CONFLICT (client_key, window_start) DO UPDATE SET request_count = request_count + 1 " +
          "RETURNING request_count",
      )
      .bind(clientKey, window),
  ]);
  const count = Number(counted?.results[0]?.request_count ?? Number.MAX_SAFE_INTEGER);
  return {
    allowed: count <= CALIBRATE_LIMIT_PER_HOUR,
    limit: CALIBRATE_LIMIT_PER_HOUR,
    remaining: Math.max(0, CALIBRATE_LIMIT_PER_HOUR - count),
    resetAt: ((window + 1) * HOUR_MS) / 1000,
  };
}

export type CalibrateOutcome =
  | {
      ok: true;
      body: {
        success: true;
        domain: string;
        bundle_id: string;
        allowed: boolean;
        verdict: "ALLOW" | "BLOCK";
        steering_directive: string | null;
        statutory_anchors: string[];
        violations: { rule_id: string; rule_name: string; reasoning: string | null; recovery_instruction: string | null }[];
        receipt: RamenReceipt | null;
        receipt_verified: boolean;
        receipt_reason: string | null;
        /** Exact string evaluated; the receipt's payload_hash is SHA-256 of this. */
        evaluated_input: string;
      };
    }
  | { ok: false; status: 502 | 504; error: string; upstream_status?: number };

/** Call ramen-ai, verify the V5 receipt locally, and shape the verdict for agents. */
export async function evaluateCalibration(
  apiKey: string,
  request: CalibrateRequest,
  bundleId: string,
): Promise<CalibrateOutcome> {
  const input = JSON.stringify({ tool: request.tool, arguments: request.arguments });

  let res: Response;
  try {
    res = await fetch(RAMEN_EVALUATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ bundle_ids: [bundleId], input }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("ramen-forge calibrate upstream fetch failed", error);
    return { ok: false, status: timedOut ? 504 : 502, error: timedOut ? "ramen-ai evaluation timed out" : "ramen-ai evaluation unreachable" };
  }

  if (!res.ok) {
    // Upstream error bodies may describe the enterprise account; log, don't relay.
    console.error("ramen-forge calibrate upstream error", res.status, (await res.text()).slice(0, 500));
    return { ok: false, status: 502, error: "ramen-ai evaluation failed", upstream_status: res.status };
  }

  let data: EvaluationResponse | undefined;
  try {
    data = ((await res.json()) as { data?: EvaluationResponse }).data;
  } catch {
    data = undefined;
  }
  if (!data || typeof data.allowed !== "boolean") {
    return { ok: false, status: 502, error: "ramen-ai returned an unexpected response shape" };
  }

  // Same steering assembly as @ramen-ai/node-core RamenClient.normalize().
  const steering: string[] = [];
  for (const v of data.total_violations ?? []) if (v.recovery_instruction) steering.push(v.recovery_instruction);
  for (const r of data.results ?? []) if (r.instruction) steering.push(r.instruction);

  const receipt = data.receipt ?? null;
  let receiptVerified = false;
  let receiptReason: string | null = "no receipt returned";
  if (receipt?.canonical_payload) {
    const verification = await verifyReceipt(receipt, input);
    receiptVerified = verification.valid;
    receiptReason = verification.reason ?? null;
  }

  return {
    ok: true,
    body: {
      success: true,
      domain: request.domain,
      bundle_id: bundleId,
      allowed: data.allowed,
      verdict: data.allowed ? "ALLOW" : "BLOCK",
      steering_directive: steering.length > 0 ? steering.join(" | ") : null,
      statutory_anchors: data.statutory_anchors ?? receipt?.statutory_anchors ?? [],
      violations: (data.total_violations ?? []).map((v) => ({
        rule_id: v.rule_id,
        rule_name: v.rule_name,
        reasoning: v.reasoning ?? null,
        recovery_instruction: v.recovery_instruction ?? null,
      })),
      receipt,
      receipt_verified: receiptVerified,
      receipt_reason: receiptReason,
      evaluated_input: input,
    },
  };
}
