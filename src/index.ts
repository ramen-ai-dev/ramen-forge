/**
 * ramen-forge: Level 1 Community Memory Commons.
 *
 * Ingests normalised CorrectionExemplar records from ramen-foundry agents,
 * indexes them by domain, tool, and task fingerprint in D1, and serves them
 * back so agents can avoid known failure modes on their first attempt.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  DOMAIN_BUNDLES,
  GLOBAL_CALIBRATE_LIMIT_PER_HOUR,
  consumeLedgerRateLimit,
  consumeRateLimit,
  currentWindow,
  evaluateCalibration,
  globalCapacityReached,
  hashClientIp,
  reserveGlobalSlot,
  resolveEvaluateUrl,
  secondsUntilNextHour,
  type CalibrateOutcome,
} from "./calibrate";
import { sha256Hex } from "@ramen-ai/node-core";
import { renderConsole } from "./console";
import { INVALID_RECEIPT_CODE, INVALID_RECEIPT_MESSAGE, verifyExemplarReceipt } from "./receipt";
import { SKILL_MD } from "./skill";
import { findPriorBlock, recordCalibrationAttempt } from "./telemetry";
import type { CalibrateRequest, CorrectionExemplarInput, CorrectionExemplarRecord, Env, ExemplarRow } from "./types";
import {
  MAX_BODY_BYTES,
  MAX_CALIBRATE_BODY_BYTES,
  QUERY_PATTERNS,
  checkSearchTerm,
  normalizeAgentPubkey,
  parseStoredObject,
  toLikePattern,
  validateCalibrateRequest,
  validateExemplar,
} from "./validation";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10_000;
const COMMUNITY_TIER = "community";

/**
 * Insert a new lesson, or refresh the receipt of an existing one with the same
 * (domain, tool_name, task_fingerprint, violation_rule) invariant
 * (idx_exemplars_task_invariant, migration 0004).
 *
 * This is an UPSERT (ON CONFLICT ... DO UPDATE), not INSERT OR REPLACE.
 * REPLACE resolves a conflict by deleting the old row, which silently bypasses
 * the append-only trigger from migration 0003 and changes the row's id. The
 * upsert keeps the original row and id.
 *
 * The receipt columns (receipt_id, signature, canonical_payload) always refresh
 * to the incoming receipt. The content columns (arguments, steering text, anchor)
 * are a one-way enrichment, never a two-way sync: each one is written only while
 * the stored value is still an empty/placeholder stand-in, and once a column holds
 * real content it is permanently locked — no later submission, however it's
 * populated, can change it again. This still heals a thin or empty row (e.g. a
 * submission that initially omitted compliant_arguments) exactly once, while
 * closing the sabotage vector where a second authentic receipt for the same
 * invariant swaps in different (and possibly unsafe) parameters after the fact.
 *
 * A duplicate exemplar_id still raises UNIQUE on the primary key (409).
 */
const INSERT_EXEMPLAR_SQL =
  "INSERT INTO exemplars (id, domain, task_fingerprint, task_description, tool_name, violation_rule, " +
  "primary_statutory_anchor, steering_directive, failed_arguments_json, repaired_arguments_json, " +
  "receipt_id, tier, created_at, signature, canonical_payload, agent_pubkey) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ";

const UPSERT_SQL =
  INSERT_EXEMPLAR_SQL +
  // agent_pubkey is deliberately absent from DO UPDATE SET: it records the agent that
  // first contributed the lesson and never changes afterwards.
  "ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule) DO UPDATE SET " +
  "receipt_id = excluded.receipt_id, " +
  "signature = excluded.signature, " +
  "canonical_payload = excluded.canonical_payload, " +
  "repaired_arguments_json = CASE " +
  "WHEN (exemplars.repaired_arguments_json = '{}' OR exemplars.repaired_arguments_json IS NULL) " +
  "AND excluded.repaired_arguments_json != '{}' AND excluded.repaired_arguments_json IS NOT NULL " +
  "THEN excluded.repaired_arguments_json ELSE exemplars.repaired_arguments_json END, " +
  "failed_arguments_json = CASE " +
  "WHEN (exemplars.failed_arguments_json = '{}' OR exemplars.failed_arguments_json IS NULL) " +
  "AND excluded.failed_arguments_json != '{}' AND excluded.failed_arguments_json IS NOT NULL " +
  "THEN excluded.failed_arguments_json ELSE exemplars.failed_arguments_json END, " +
  "steering_directive = CASE " +
  "WHEN (exemplars.steering_directive = 'Compliant operational blueprint' OR exemplars.steering_directive = '' " +
  "OR exemplars.steering_directive IS NULL) " +
  "AND excluded.steering_directive != 'Compliant operational blueprint' AND excluded.steering_directive != '' " +
  "AND excluded.steering_directive IS NOT NULL " +
  "THEN excluded.steering_directive ELSE exemplars.steering_directive END, " +
  // The literal 'Policy unknown' placeholder is matched for forward compatibility, but the
  // server's actual generated default (see receiptMetadata()) is the longer
  // "Statutory Invariant (Policy unknown)" string, which must also be recognised as a
  // placeholder or this column could never be healed once a submission omits the anchor
  // and the receipt's policy id can't be resolved.
  "primary_statutory_anchor = CASE " +
  "WHEN (exemplars.primary_statutory_anchor = 'Policy unknown' " +
  "OR exemplars.primary_statutory_anchor = 'Statutory Invariant (Policy unknown)' " +
  "OR exemplars.primary_statutory_anchor = '' OR exemplars.primary_statutory_anchor IS NULL) " +
  "AND excluded.primary_statutory_anchor != 'Policy unknown' " +
  "AND excluded.primary_statutory_anchor != 'Statutory Invariant (Policy unknown)' " +
  "AND excluded.primary_statutory_anchor != '' AND excluded.primary_statutory_anchor IS NOT NULL " +
  "THEN excluded.primary_statutory_anchor ELSE exemplars.primary_statutory_anchor END " +
  "RETURNING id";

/**
 * Turn 1 (BLOCK) insert. Deliberately DO NOTHING on conflict instead of UPSERT_SQL's
 * receipt refresh: if the invariant already exists (for example a pair that was
 * completed with its ALLOW receipt), a later BLOCK must not overwrite that receipt.
 */
const ORPHANED_BLOCK_SQL =
  INSERT_EXEMPLAR_SQL + "ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule) DO NOTHING";

/**
 * Orphan definitions, shared by the bounty query and the public-read filter.
 *
 * Orphaned block: a BLOCK was recorded (failed_arguments present) but no compliant
 * parameters have been attached yet. These rows hold raw failure parameters, which
 * act as an adversarial dictionary, so every public read excludes them.
 *
 * Orphaned allow: a compliant blueprint whose steering directive is still the generic
 * placeholder or empty, because no BLOCK context was ever paired with it.
 */
const ORPHANED_BLOCK_WHERE = "(repaired_arguments_json = '{}' AND failed_arguments_json != '{}')";
const ORPHANED_ALLOW_WHERE =
  "(repaired_arguments_json != '{}' AND (steering_directive = 'Compliant operational blueprint' OR steering_directive = ''))";
const PUBLIC_ROWS_WHERE = `NOT ${ORPHANED_BLOCK_WHERE}`;

const GENERIC_ALLOW_STEERING = "Compliant operational blueprint";

type AppVariables = { agentPubkey: string | null };
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Public API: any origin may read. Writes still require a bearer token, which
// browsers never attach automatically, so a wildcard origin adds no CSRF risk.
app.use(
  "/api/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept", "X-Agent-Pubkey"],
    exposeHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
    maxAge: 86400,
  }),
);

/**
 * Optional agent identity. X-Agent-Pubkey carries an Ed25519 public key (32 bytes as hex,
 * base64 or base64url) and is normalised to lowercase hex. It is an UNVERIFIED label:
 * no proof of key possession is checked, so it is used for telemetry and for pairing a
 * Turn 2 ALLOW with that agent's Turn 1 BLOCK, never for authorization. Absent is fine;
 * present-but-malformed is rejected so a client bug cannot silently produce unpaired lessons.
 */
app.use("/api/v1/*", async (c, next) => {
  const raw = c.req.header("x-agent-pubkey");
  if (raw === undefined || raw.trim() === "") {
    c.set("agentPubkey", null);
    return next();
  }
  const agentPubkey = normalizeAgentPubkey(raw);
  if (!agentPubkey) {
    return c.json(
      { success: false, error: "X-Agent-Pubkey must be a 32-byte Ed25519 public key encoded as 64 hex characters or base64/base64url" },
      400,
    );
  }
  c.set("agentPubkey", agentPubkey);
  return next();
});

interface VerifiedReceiptFields {
  signature: string;
  canonicalPayload: string;
}

function bindExemplar(
  db: D1Database,
  exemplar: CorrectionExemplarInput,
  receipt: VerifiedReceiptFields,
  agentPubkey: string | null = null,
  sql: string = UPSERT_SQL,
): D1PreparedStatement {
  return db
    .prepare(sql)
    .bind(
      exemplar.exemplar_id,
      exemplar.domain,
      exemplar.task_fingerprint,
      exemplar.task_description,
      exemplar.tool_name,
      exemplar.violation_reason,
      exemplar.primary_statutory_anchor,
      exemplar.steering_directive,
      JSON.stringify(exemplar.failed_arguments),
      JSON.stringify(exemplar.repaired_arguments),
      exemplar.receipt_id,
      COMMUNITY_TIER,
      exemplar.created_at,
      receipt.signature,
      receipt.canonicalPayload,
      agentPubkey,
    );
}

/**
 * Same bar as MISSING_COMPLIANT_ARGUMENTS on the manual ingestion path: an
 * allowed verdict with an empty candidate dictionary has nothing to apply and
 * is not auto-ingested. Shared by the response flag and the background job so
 * `auto_ingested` in the response always matches whether the write is attempted.
 */
function isAutoIngestEligible(request: CalibrateRequest, outcome: CalibrationBody): boolean {
  return outcome.allowed && outcome.receipt !== null && outcome.receipt_verified && Object.keys(request.arguments).length > 0;
}

/** A verified BLOCK with candidate arguments is kept as an orphaned block (private, see ORPHANED_BLOCK_WHERE). */
function isBlockIngestEligible(request: CalibrateRequest, outcome: CalibrationBody): boolean {
  return !outcome.allowed && outcome.receipt !== null && outcome.receipt_verified && Object.keys(request.arguments).length > 0;
}

type CalibrationBody = Extract<CalibrateOutcome, { ok: true }>["body"];

// Control characters other than tab, newline and carriage return, same set validation.ts rejects.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip control characters and clamp length so upstream text always clears validateExemplar. */
function cleanText(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARS_RE, " ").trim().slice(0, maxLength);
}

/**
 * Task label shared by Turn 1 and Turn 2. The caller's task_description when given,
 * otherwise the same tool-derived default on both turns, so the fingerprint
 * (SHA-256 of this text) is stable across a BLOCK and the ALLOW that follows it.
 */
function calibrationTaskDescription(request: CalibrateRequest): string {
  return request.task_description?.trim() || `Compliant operational blueprint for ${request.tool}`;
}

/** Violation rule stored for a BLOCK: the evaluated rule names, else a policy-derived default. */
function blockViolationRule(outcome: CalibrationBody): string {
  const names = outcome.violations
    .map((violation) => cleanText(violation.rule_name || violation.rule_id || "", 200))
    .filter((name) => name !== "");
  if (names.length > 0) return cleanText([...new Set(names)].join(" | "), 1000);
  return `Statutory invariant violation (Policy ${outcome.policy_ids[0] ?? "unknown"})`;
}

/**
 * Turn 2 (ALLOW): commit a verified compliant blueprint to the community commons, so an
 * agent that resolves a novel case through POST /api/v1/calibrate never has to make a
 * separate manual call to POST /api/v1/exemplars.
 *
 * If this agent's earlier BLOCK for the same task exists in the telemetry log, matched on
 * (agent_pubkey, domain, tool_name, task_fingerprint), the two halves are merged into one
 * row: the BLOCK supplies failed_arguments, violation_rule and steering_directive, the
 * ALLOW supplies repaired_arguments and its own verified receipt. Reusing the BLOCK's
 * violation_rule makes the upsert land on the orphaned-block row Turn 1 created, so the
 * pair completes in place (same id, no second row, no new index needed).
 *
 * Routed through the same `validateExemplar` and immutability-locked UPSERT_SQL the manual
 * endpoint uses: calibrate's `arguments` is attacker-controlled input flowing into public
 * memory with no review step, so it must clear the same bar, and a populated column can
 * never be overwritten by a later submission.
 *
 * Never throws: a failure here must not turn a successful calibration into an error.
 */
async function ingestAllowedCalibration(
  db: D1Database,
  request: CalibrateRequest,
  outcome: CalibrationBody,
  agentPubkey: string | null,
  taskDescription: string,
  taskFingerprint: string,
): Promise<void> {
  const receipt = outcome.receipt;
  if (!isAutoIngestEligible(request, outcome) || !receipt) return;

  try {
    const prior = await findPriorBlock(db, agentPubkey, request.domain, request.tool, taskFingerprint);
    const policyId = outcome.policy_ids[0] ?? "general";
    const primaryStatutoryAnchor =
      outcome.statutory_anchors[0] || prior?.primary_statutory_anchor || `Statutory Invariant (Policy ${policyId})`;

    // Lowercased once up front so exemplar_id, receipt_id, and the verifiedReceiptId
    // argument all agree, same as receipt.ts's own receiptId normalisation.
    const receiptId = receipt.id.toLowerCase();
    const result = await validateExemplar(
      {
        exemplar_id: receiptId,
        domain: request.domain,
        task_description: taskDescription,
        tool_name: request.tool,
        failed_arguments: prior ? parseStoredObject(prior.arguments_json) : {},
        violation_reason: prior?.violation_rule ?? "No violation: compliant reference action",
        primary_statutory_anchor: primaryStatutoryAnchor,
        steering_directive: prior?.steering_directive || outcome.steering_directive || GENERIC_ALLOW_STEERING,
        compliant_arguments: request.arguments,
        receipt_id: receiptId,
        created_at: new Date().toISOString(),
      },
      receiptId,
    );
    if (!result.ok) {
      console.error("ramen-forge auto-ingestion skipped: exemplar failed validation", result.errors);
      return;
    }

    await bindExemplar(
      db,
      result.value,
      { signature: receipt.signature, canonicalPayload: receipt.canonical_payload },
      agentPubkey,
    ).run();
    console.log(
      `ramen-forge auto-ingested ${prior ? "paired" : "compliant"} blueprint ${result.value.exemplar_id} into community memory (${request.domain}/${request.tool})`,
    );
  } catch (error) {
    console.error("ramen-forge auto-ingestion failed", error);
  }
}

/**
 * Turn 1 (BLOCK): record the failure pattern as an orphaned block: failed_arguments,
 * violation_rule and steering_directive, with compliant_arguments left empty until an
 * ALLOW completes the pair. Private by construction: public reads exclude these rows
 * (PUBLIC_ROWS_WHERE) and only the admin-gated bounty endpoint serves them.
 *
 * Never throws.
 */
async function ingestOrphanedBlock(
  db: D1Database,
  request: CalibrateRequest,
  outcome: CalibrationBody,
  agentPubkey: string | null,
  taskDescription: string,
  violationRule: string,
): Promise<void> {
  const receipt = outcome.receipt;
  if (!isBlockIngestEligible(request, outcome) || !receipt) return;

  try {
    const policyId = outcome.policy_ids[0] ?? "general";
    const receiptId = receipt.id.toLowerCase();
    const result = await validateExemplar(
      {
        exemplar_id: receiptId,
        domain: request.domain,
        task_description: taskDescription,
        tool_name: request.tool,
        failed_arguments: request.arguments,
        violation_reason: violationRule,
        primary_statutory_anchor: cleanText(outcome.statutory_anchors[0] || `Statutory Invariant (Policy ${policyId})`, 256),
        steering_directive: cleanText(outcome.steering_directive ?? "", 2000) || "Statutory invariant violation",
        compliant_arguments: {},
        receipt_id: receiptId,
        created_at: new Date().toISOString(),
      },
      receiptId,
    );
    if (!result.ok) {
      console.error("ramen-forge orphaned-block ingestion skipped: exemplar failed validation", result.errors);
      return;
    }

    await bindExemplar(
      db,
      result.value,
      { signature: receipt.signature, canonicalPayload: receipt.canonical_payload },
      agentPubkey,
      ORPHANED_BLOCK_SQL,
    ).run();
  } catch (error) {
    console.error("ramen-forge orphaned-block ingestion failed", error);
  }
}

/**
 * Inline (waitUntil) handling of one evaluated calibration: always append the raw attempt
 * to the telemetry log, then merge it into the canonical exemplars table. The telemetry
 * write is independent of the merge, so a merge failure never loses the attempt record.
 * `outcome` is null when the upstream evaluation failed (verdict NULL in the log).
 *
 * Never throws.
 */
async function processCalibration(
  db: D1Database,
  request: CalibrateRequest,
  outcome: CalibrationBody | null,
  failure: string | null,
  agentPubkey: string | null,
  ip: string,
): Promise<void> {
  try {
    const taskDescription = calibrationTaskDescription(request);
    const taskFingerprint = await sha256Hex(taskDescription);
    const violationRule = outcome && !outcome.allowed ? blockViolationRule(outcome) : null;

    try {
      await recordCalibrationAttempt(db, {
        agentPubkey,
        domain: request.domain,
        toolName: request.tool,
        taskFingerprint,
        taskDescription,
        argumentsJson: JSON.stringify(request.arguments),
        evaluatedInput: outcome?.evaluated_input ?? null,
        verdict: outcome ? (outcome.allowed ? 1 : 0) : null,
        violationRule,
        steeringDirective: outcome ? outcome.steering_directive : null,
        primaryStatutoryAnchor: outcome ? (outcome.statutory_anchors[0] ?? null) : null,
        receiptId: outcome?.receipt_id ?? null,
        receiptJson: outcome?.receipt ? JSON.stringify(outcome.receipt) : null,
        receiptVerified: outcome?.receipt_verified ?? false,
        error: failure,
        clientIpHash: await hashClientIp("telemetry", ip),
      });
    } catch (error) {
      console.error("ramen-forge calibration telemetry write failed", error);
    }

    if (!outcome) return;
    if (outcome.allowed) {
      await ingestAllowedCalibration(db, request, outcome, agentPubkey, taskDescription, taskFingerprint);
    } else if (violationRule) {
      await ingestOrphanedBlock(db, request, outcome, agentPubkey, taskDescription, violationRule);
    }
  } catch (error) {
    console.error("ramen-forge calibration processing failed", error);
  }
}

/** Schedule work after the response via waitUntil; await it inline when there is no ExecutionContext (unit tests). */
async function runInBackground(c: AppContext, task: Promise<void>): Promise<void> {
  // c.executionCtx throws (not just returns undefined) when the Worker was invoked
  // without a FetchEvent/ExecutionContext, e.g. in unit tests calling app.request() directly.
  try {
    const executionContext = c.executionCtx;
    if (typeof executionContext.waitUntil === "function") {
      executionContext.waitUntil(task);
      return;
    }
  } catch {
    // fall through to the inline await
  }
  await task;
}

/** Constant-time string comparison: compares SHA-256 digests so length does not leak either. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/** Bearer check against FORGE_ADMIN_TOKEN. An unset token fails closed: nothing is authorized. */
async function isAdminAuthorized(c: AppContext): Promise<boolean> {
  const expected = c.env.FORGE_ADMIN_TOKEN;
  if (!expected) {
    console.error("ramen-forge bounties unavailable: FORGE_ADMIN_TOKEN is not configured");
    return false;
  }
  const match = /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim());
  if (!match?.[1]) return false;
  return constantTimeEqual(match[1], expected);
}

/**
 * Record a domain query that found nothing. One row per client, domain, tool,
 * and query per UTC hour (deterministic id + INSERT OR IGNORE), so repeated
 * polling does not grow the table. Errors are logged, never surfaced.
 */
async function logDemand(db: D1Database, ip: string, domain: string, toolName: string | null, query: string | null): Promise<void> {
  try {
    const ipHash = await hashClientIp("demand", ip);
    const id = await hashClientIp("demand-row", `${ipHash}|${domain}|${toolName ?? ""}|${query ?? ""}|${currentWindow()}`);
    await db
      .prepare(
        "INSERT OR IGNORE INTO domain_demand (id, domain, tool_name, query_text, client_ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, domain, toolName, query, ipHash, new Date().toISOString())
      .run();
  } catch (error) {
    console.error("ramen-forge demand logging failed", error);
  }
}

const MAX_RELATED_EXEMPLARS = 3;

/**
 * On a BLOCK verdict, look up existing compliant blueprints for the same
 * (domain, tool_name) so the agent can adjust its candidate arguments using
 * concrete precedent instead of guessing — without making a second,
 * separate GET /api/v1/exemplars call itself. Orphaned blocks (raw failure
 * parameters with no compliant counterpart yet) are private and excluded.
 *
 * Read-only and best-effort: a lookup failure must not turn a successful
 * calibration into an error response, so failures are logged and an empty
 * list is returned.
 */
async function fetchRelatedExemplars(
  db: D1Database,
  domain: string,
  toolName: string,
  limit: number = MAX_RELATED_EXEMPLARS,
): Promise<CorrectionExemplarRecord[]> {
  try {
    const { results } = await db
      .prepare(`SELECT * FROM exemplars WHERE domain = ? AND tool_name = ? AND ${PUBLIC_ROWS_WHERE} ORDER BY created_at DESC LIMIT ?`)
      .bind(domain, toolName, limit)
      .all<ExemplarRow>();
    return results.map(toRecord);
  } catch (error) {
    console.error("ramen-forge related exemplar lookup failed", error);
    return [];
  }
}

/** Map a D1 row back to foundry's CorrectionExemplar.to_dict() field names. */
function toRecord(row: ExemplarRow): CorrectionExemplarRecord {
  const compliantArguments = parseStoredObject(row.repaired_arguments_json);
  return {
    exemplar_id: row.id,
    domain: row.domain,
    task_description: row.task_description,
    task_fingerprint: row.task_fingerprint,
    tool_name: row.tool_name,
    failed_arguments: parseStoredObject(row.failed_arguments_json),
    violation_reason: row.violation_rule,
    primary_statutory_anchor: row.primary_statutory_anchor,
    steering_directive: row.steering_directive,
    compliant_arguments: compliantArguments,
    repaired_arguments: compliantArguments,
    receipt_id: row.receipt_id,
    created_at: row.created_at,
    tier: row.tier,
    signature: row.signature ?? null,
    canonical_payload: row.canonical_payload ?? null,
    id: row.id,
    violation_rule: row.violation_rule,
    times_applied: row.times_applied ?? 0,
    successful_applications: row.successful_applications ?? 0,
  };
}

/** Row as stored, with the two JSON-text columns replaced by parsed objects. */
function toLookupRecord(row: ExemplarRow): Record<string, unknown> {
  // agent_pubkey is private telemetry and is never served on public reads.
  const { failed_arguments_json: failedJson, repaired_arguments_json: repairedJson, agent_pubkey: _agentPubkey, ...rest } = row;
  const compliantArguments = parseStoredObject(repairedJson);
  return {
    ...rest,
    failed_arguments: parseStoredObject(failedJson),
    compliant_arguments: compliantArguments,
    repaired_arguments: compliantArguments,
  };
}

async function readJsonBody(
  c: AppContext,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) {
    return { ok: false, response: c.json({ success: false, error: `body exceeds ${maxBytes} bytes` }, 413) };
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, response: c.json({ success: false, error: `body exceeds ${maxBytes} bytes` }, 413) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: c.json({ success: false, error: "body must be valid JSON" }, 400) };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-blank string in a signed-payload array field, or null. */
function firstPolicyId(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((item): item is string => typeof item === "string" && item.trim() !== "");
  return first ? first.trim() : null;
}

function receiptMetadata(receipt: Awaited<ReturnType<typeof verifyExemplarReceipt>>): {
  policyId: string;
  violationReason: string;
  primaryStatutoryAnchor: string;
  steeringDirective: string;
} {
  const signedPayload = receipt.ok ? receipt.signedPayload : {};
  // Schema V5 signs a plural `policy_ids` array; `policy_id` (singular) is kept as a fallback
  // for older or non-standard payloads. Without this, multi-policy receipts (the common case)
  // always fell through to the literal "unknown".
  const policyId =
    firstPolicyId(signedPayload.policy_ids) ??
    (typeof signedPayload.policy_id === "string" && signedPayload.policy_id.trim() !== "" ? signedPayload.policy_id : "unknown");
  const allowed = receipt.ok && receipt.verdict === 1;
  return {
    policyId,
    violationReason: allowed ? "No violation: compliant reference action" : `Statutory invariant violation (Policy ${policyId})`,
    primaryStatutoryAnchor: `Statutory Invariant (Policy ${policyId})`,
    steeringDirective: allowed ? "Compliant operational blueprint" : "Statutory invariant violation",
  };
}

app.get("/", (c) => {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' https://cdn.tailwindcss.com`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(renderConsole(nonce));
});

app.get("/skill.md", (c) => {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(SKILL_MD);
});

app.post("/api/v1/exemplars", async (c) => {
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rate = await consumeLedgerRateLimit(c.env.DB, ip);
  c.header("RateLimit-Limit", String(rate.limit));
  c.header("RateLimit-Remaining", String(rate.remaining));
  c.header("RateLimit-Reset", String(Math.max(0, Math.ceil(rate.resetAt - Date.now() / 1000))));
  if (!rate.allowed) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetAt - Date.now() / 1000))));
    return c.json({ success: false, error: `rate limit exceeded: ${rate.limit} submissions per hour per client` }, 429);
  }

  const body = parsed.body;
  // allowBlocked stays true here only so a BLOCK receipt can be verified far enough
  // to read its verdict; the COMPLIANT_BLUEPRINTS_ONLY gate right below is what
  // actually keeps verdict=0 receipts out of the public commons.
  const receipt = await verifyExemplarReceipt(isPlainObject(body) ? body.receipt : undefined, { allowBlocked: true });
  if (!receipt.ok) {
    return c.json(
      { success: false, error: { code: INVALID_RECEIPT_CODE, message: INVALID_RECEIPT_MESSAGE }, details: [receipt.reason] },
      422,
    );
  }

  const signedVerdict = receipt.verdict;

  // Community commons stores strictly verified compliant blueprints. Blocked failure
  // patterns stay in the internal policy engine's own logs and are never ingested here,
  // so a verdict=0 receipt is rejected before any content fields are even read.
  if (signedVerdict !== 1) {
    return c.json(
      {
        success: false,
        error: {
          code: "COMPLIANT_BLUEPRINTS_ONLY",
          message:
            "Exemplar rejected: Community commons accepts strictly verified compliant blueprints (verdict=1). Blocked failure patterns are retained by the internal policy engine.",
        },
      },
      422,
    );
  }

  const metadata = receiptMetadata(receipt);
  const request = isPlainObject(body) ? body : {};

  // Allowed blueprints exist to be copied: an empty compliant_arguments dictionary
  // stores a lesson with nothing to apply. Require it populated up front, before the
  // generic validator (which treats {} as a structurally valid object).
  const submittedArguments = request.compliant_arguments ?? request.repaired_arguments;
  const populated = isPlainObject(submittedArguments) && Object.keys(submittedArguments).length > 0;
  if (!populated) {
    return c.json(
      {
        success: false,
        error: {
          code: "MISSING_COMPLIANT_ARGUMENTS",
          message: "Exemplar rejected: Allowed blueprints (verdict=1) must provide a populated compliant_arguments dictionary.",
        },
      },
      422,
    );
  }

  const exemplarBody = {
    exemplar_id: receipt.receiptId,
    domain: request.domain,
    task_description: request.task_description,
    tool_name: request.tool_name || "general",
    failed_arguments: request.failed_arguments || {},
    violation_reason: metadata.violationReason,
    primary_statutory_anchor: request.primary_statutory_anchor || metadata.primaryStatutoryAnchor,
    steering_directive: request.steering_directive || metadata.steeringDirective,
    compliant_arguments: request.compliant_arguments || request.repaired_arguments || {},
    receipt_id: receipt.receiptId,
    created_at: new Date().toISOString(),
  };

  const result = await validateExemplar(exemplarBody, receipt.receiptId);
  if (!result.ok) {
    return c.json({ success: false, error: "exemplar rejected", details: result.errors }, 422);
  }

  // One batch = one transaction, so "did the invariant already exist?" and the
  // upsert see the same state.
  const value = result.value;
  let storedId: string;
  let refreshed: boolean;
  try {
    const [existing, upserted] = await c.env.DB.batch<{ id: string }>([
      c.env.DB.prepare(
        "SELECT id FROM exemplars WHERE domain = ? AND tool_name = ? AND task_fingerprint = ? AND violation_rule = ?",
      ).bind(value.domain, value.tool_name, value.task_fingerprint, value.violation_reason),
      bindExemplar(c.env.DB, value, receipt),
    ]);
    const row = upserted?.results[0];
    if (!row) throw new Error("upsert returned no row");
    storedId = row.id;
    refreshed = (existing?.results.length ?? 0) > 0;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return c.json({ success: false, error: `exemplar_id already recorded: ${value.exemplar_id}` }, 409);
    }
    throw error;
  }

  if (refreshed) {
    // Same invariant already stored: its receipt was refreshed, the lesson text kept.
    return c.json({ success: true, exemplar_id: storedId, verdict: signedVerdict, refreshed: true }, 201);
  }
  return c.json({ success: true, exemplar_id: storedId, verdict: signedVerdict }, 201);
});

app.get("/api/v1/exemplars", async (c) => {
  // Every filter is optional and combined with AND. task_fingerprint gives an
  // exact-task match; q gives a keyword match that works across phrasings.
  const {
    domain,
    tool_name: toolName,
    task_fingerprint: taskFingerprint,
    q,
    limit: rawLimit,
    offset: rawOffset,
  } = c.req.query();
  let demandQuery: string | null = null;
  const errors: string[] = [];
  // Orphaned blocks hold raw failure parameters and are served only by the admin-gated bounty endpoint.
  const where: string[] = [PUBLIC_ROWS_WHERE];
  const params: (string | number)[] = [];

  if (domain !== undefined) {
    if (!QUERY_PATTERNS.DOMAIN_RE.test(domain)) errors.push("domain is not a valid slug");
    where.push("domain = ?");
    params.push(domain);
  }
  if (toolName !== undefined) {
    if (!QUERY_PATTERNS.TOOL_NAME_RE.test(toolName)) errors.push("tool_name is not valid");
    where.push("tool_name = ?");
    params.push(toolName);
  }
  if (taskFingerprint !== undefined) {
    if (!QUERY_PATTERNS.SHA256_HEX_RE.test(taskFingerprint)) {
      errors.push("task_fingerprint must be a lowercase SHA-256 hex digest");
    }
    where.push("task_fingerprint = ?");
    params.push(taskFingerprint);
  }
  if (q !== undefined) {
    const search = checkSearchTerm(q);
    if (!search.ok) {
      errors.push(search.error);
    } else {
      // SQLite LIKE is case-insensitive for ASCII. Wildcards in q are escaped.
      const normalizedQuery = search.term.trim();
      const searchTerm = toLikePattern(normalizedQuery);
      demandQuery = normalizedQuery;
      where.push(
        "(task_description LIKE ? ESCAPE '\\' OR violation_rule LIKE ? ESCAPE '\\' OR steering_directive LIKE ? ESCAPE '\\')",
      );
      params.push(searchTerm, searchTerm, searchTerm);
    }
  }

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_LIMIT) {
      errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }
  let offset = 0;
  if (rawOffset !== undefined) {
    offset = Number(rawOffset);
    if (!/^\d+$/.test(rawOffset) || offset > MAX_OFFSET) {
      errors.push(`offset must be an integer between 0 and ${MAX_OFFSET}`);
    }
  }
  if (errors.length > 0) {
    return c.json({ success: false, error: "invalid query", details: errors }, 400);
  }

  const sql = `SELECT * FROM exemplars WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  let results: ExemplarRow[];
  try {
    const response = await c.env.DB.prepare(sql)
      .bind(...params, limit, offset)
      .all<ExemplarRow>();
    results = response.results;
  } catch (error) {
    console.error("ramen-forge exemplar search failed", error);
    return c.json({ success: true, count: 0, limit, offset, exemplars: [] });
  }

  // A first-page miss on a domain is unmet demand. Paging past the end is not.
  if (results.length === 0 && domain !== undefined && offset === 0) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    try {
      const executionContext = c.executionCtx;
      if (executionContext && typeof executionContext.waitUntil === "function") {
        executionContext.waitUntil(logDemand(c.env.DB, ip, domain, toolName ?? null, demandQuery));
      } else {
        void logDemand(c.env.DB, ip, domain, toolName ?? null, demandQuery);
      }
    } catch (error) {
      console.error("ramen-forge demand scheduling failed", error);
    }
  }

  let exemplars: CorrectionExemplarRecord[];
  try {
    exemplars = results.map(toRecord);
  } catch (error) {
    console.error("ramen-forge exemplar conversion failed", error);
    return c.json({ success: true, count: 0, limit, offset, exemplars: [] });
  }
  return c.json({ success: true, count: exemplars.length, limit, offset, exemplars });
});

type BountyKind = "orphaned_block" | "orphaned_allow";
const BOUNTY_KINDS: readonly BountyKind[] = ["orphaned_block", "orphaned_allow"];

/** Shape of one bounty: an incomplete exemplar plus what is missing from it. */
function toBountyRecord(row: ExemplarRow): Record<string, unknown> {
  const isOrphanedBlock = row.repaired_arguments_json === "{}" && row.failed_arguments_json !== "{}";
  const kind: BountyKind = isOrphanedBlock ? "orphaned_block" : "orphaned_allow";
  return {
    id: row.id,
    kind,
    missing: isOrphanedBlock ? ["compliant_arguments", "allow_receipt"] : ["steering_directive"],
    domain: row.domain,
    tool_name: row.tool_name,
    task_description: row.task_description,
    task_fingerprint: row.task_fingerprint,
    failed_arguments: parseStoredObject(row.failed_arguments_json),
    compliant_arguments: parseStoredObject(row.repaired_arguments_json),
    violation_rule: row.violation_rule,
    steering_directive: row.steering_directive,
    primary_statutory_anchor: row.primary_statutory_anchor,
    receipt_id: row.receipt_id,
    agent_pubkey: row.agent_pubkey ?? null,
    created_at: row.created_at,
  };
}

/**
 * Private: incomplete exemplars for internal worker agents to resolve. Requires
 * Authorization: Bearer <FORGE_ADMIN_TOKEN>. Orphaned blocks carry raw failure
 * parameters (an adversarial dictionary), so this is never public and is never cached.
 */
app.get("/api/v1/exemplars/bounties", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!(await isAdminAuthorized(c))) {
    c.header("WWW-Authenticate", 'Bearer realm="ramen-forge-bounties"');
    return c.json({ success: false, error: "unauthorized" }, 401);
  }

  const { domain, tool_name: toolName, kind, limit: rawLimit, offset: rawOffset } = c.req.query();
  const errors: string[] = [];
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (kind === undefined) {
    where.push(`(${ORPHANED_BLOCK_WHERE} OR ${ORPHANED_ALLOW_WHERE})`);
  } else if (kind === "orphaned_block") {
    where.push(ORPHANED_BLOCK_WHERE);
  } else if (kind === "orphaned_allow") {
    where.push(ORPHANED_ALLOW_WHERE);
  } else {
    errors.push(`kind must be one of: ${BOUNTY_KINDS.join(", ")}`);
  }
  if (domain !== undefined) {
    if (!QUERY_PATTERNS.DOMAIN_RE.test(domain)) errors.push("domain is not a valid slug");
    where.push("domain = ?");
    params.push(domain);
  }
  if (toolName !== undefined) {
    if (!QUERY_PATTERNS.TOOL_NAME_RE.test(toolName)) errors.push("tool_name is not valid");
    where.push("tool_name = ?");
    params.push(toolName);
  }
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_LIMIT) {
      errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }
  let offset = 0;
  if (rawOffset !== undefined) {
    offset = Number(rawOffset);
    if (!/^\d+$/.test(rawOffset) || offset > MAX_OFFSET) {
      errors.push(`offset must be an integer between 0 and ${MAX_OFFSET}`);
    }
  }
  if (errors.length > 0) {
    return c.json({ success: false, error: "invalid query", details: errors }, 400);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM exemplars WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<ExemplarRow>();
  const bounties = results.map(toBountyRecord);
  return c.json({ success: true, count: bounties.length, limit, offset, bounties });
});

const MAX_FEEDBACK_BODY_BYTES = 1024;

app.get("/api/v1/exemplars/:id", async (c) => {
  const id = c.req.param("id");
  if (!QUERY_PATTERNS.UUID_RE.test(id)) {
    // A non-UUID can never match a stored id; answer as not found rather than hit D1.
    return c.json({ success: false, error: "Exemplar not found" }, 404);
  }
  const row = await c.env.DB.prepare(`SELECT * FROM exemplars WHERE id = ?1 AND ${PUBLIC_ROWS_WHERE}`)
    .bind(id)
    .first<ExemplarRow>();
  if (!row) return c.json({ success: false, error: "Exemplar not found" }, 404);
  return c.json({ success: true, exemplar: toLookupRecord(row) });
});

app.post("/api/v1/exemplars/:id/feedback", async (c) => {
  const id = c.req.param("id");
  if (!QUERY_PATTERNS.UUID_RE.test(id)) {
    return c.json({ success: false, error: "Exemplar not found" }, 404);
  }
  const parsed = await readJsonBody(c, MAX_FEEDBACK_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const outcome =
    typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).success : undefined;
  if (typeof outcome !== "boolean") {
    return c.json({ success: false, error: 'body must be JSON of the form {"success": true|false}' }, 400);
  }

  // Bind 1/0 rather than a boolean: D1 binds numbers, and SQLite has no boolean type.
  const result = await c.env.DB.prepare(
    "UPDATE exemplars SET times_applied = times_applied + 1, " +
      "successful_applications = successful_applications + (CASE WHEN ?1 THEN 1 ELSE 0 END) WHERE id = ?2",
  )
    .bind(outcome ? 1 : 0, id)
    .run();
  if (result.meta.changes === 0) return c.json({ success: false, error: "Exemplar not found" }, 404);
  return c.json({ success: true, id, recorded: true });
});

app.get("/api/v1/domains", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT domain, COUNT(*) AS lesson_count, GROUP_CONCAT(DISTINCT tool_name) AS tools_csv " +
      `FROM exemplars WHERE ${PUBLIC_ROWS_WHERE} GROUP BY domain ORDER BY domain`,
  ).all<{ domain: string; lesson_count: number; tools_csv: string | null }>();
  const domains = results.map((r) => ({
    domain: r.domain,
    lesson_count: Number(r.lesson_count),
    tools: r.tools_csv ? r.tools_csv.split(",").sort() : [],
  }));
  return c.json({ success: true, domains });
});

app.get("/api/v1/stats", async (c) => {
  const [totals, domains] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT domain) AS domains, " +
        `COUNT(DISTINCT primary_statutory_anchor) AS anchor_count FROM exemplars WHERE tier = ? AND ${PUBLIC_ROWS_WHERE}`,
    ).bind(COMMUNITY_TIER),
    c.env.DB.prepare(
      `SELECT domain, COUNT(*) AS exemplars FROM exemplars WHERE tier = ? AND ${PUBLIC_ROWS_WHERE} GROUP BY domain ORDER BY exemplars DESC, domain`,
    ).bind(COMMUNITY_TIER),
  ]);
  const row = totals?.results[0] ?? {};
  return c.json({
    success: true,
    total_community_exemplars: Number(row.total ?? 0),
    active_domains: Number(row.domains ?? 0),
    statutory_anchors_count: Number(row.anchor_count ?? 0),
    domains: (domains?.results ?? []).map((d) => ({ domain: String(d.domain), exemplars: Number(d.exemplars) })),
  });
});

function communityCapacityReached(c: AppContext): Response {
  c.header("Retry-After", String(secondsUntilNextHour()));
  return c.json(
    {
      success: false,
      error: {
        code: "COMMUNITY_CAPACITY_REACHED",
        message:
          `Global community calibration capacity reached for this hour (${GLOBAL_CALIBRATE_LIMIT_PER_HOUR}/${GLOBAL_CALIBRATE_LIMIT_PER_HOUR}). ` +
          "Please retry at the top of the hour or deploy ramen foundry with your own API key.",
      },
    },
    503,
  );
}

app.post("/api/v1/calibrate", async (c) => {
  const apiKey = c.env.RAMEN_API_KEY;
  if (!apiKey) {
    return c.json({ success: false, error: "calibration disabled: RAMEN_API_KEY is not configured" }, 503);
  }
  let evaluateUrl: string;
  try {
    evaluateUrl = resolveEvaluateUrl(c.env.RAMEN_GATEWAY_URL);
  } catch (error) {
    console.error("ramen-forge invalid RAMEN_GATEWAY_URL", error);
    return c.json({ success: false, error: "calibration disabled: RAMEN_GATEWAY_URL is misconfigured" }, 503);
  }

  // Global ceiling first: fail fast without charging the caller's per-IP quota.
  if (await globalCapacityReached(c.env.DB)) return communityCapacityReached(c);

  // Count every attempt, valid or not, so malformed floods are throttled too.
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rate = await consumeRateLimit(c.env.DB, ip);
  c.header("RateLimit-Limit", String(rate.limit));
  c.header("RateLimit-Remaining", String(rate.remaining));
  c.header("RateLimit-Reset", String(Math.max(0, Math.ceil(rate.resetAt - Date.now() / 1000))));
  if (!rate.allowed) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetAt - Date.now() / 1000))));
    return c.json({ success: false, error: `rate limit exceeded: ${rate.limit} calibrations per hour per client` }, 429);
  }

  const parsed = await readJsonBody(c, MAX_CALIBRATE_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const request = validateCalibrateRequest(parsed.body);
  if (!request.ok) {
    return c.json({ success: false, error: "calibration request rejected", details: request.errors }, 422);
  }
  const bundleId = DOMAIN_BUNDLES[request.value.domain];
  if (!bundleId) {
    return c.json(
      {
        success: false,
        error: "calibration request rejected",
        details: [`unsupported domain; expected one of: ${Object.keys(DOMAIN_BUNDLES).join(", ")}`],
      },
      422,
    );
  }

  // Atomic reservation closes the race between the pre-check and the upstream call.
  if (!(await reserveGlobalSlot(c.env.DB))) return communityCapacityReached(c);

  const agentPubkey = c.get("agentPubkey");
  const outcome = await evaluateCalibration(apiKey, request.value, bundleId, evaluateUrl);
  if (!outcome.ok) {
    // Upstream failures are still telemetry (verdict NULL), so adoption counts stay complete.
    await runInBackground(c, processCalibration(c.env.DB, request.value, null, outcome.error, agentPubkey, ip));
    return c.json(
      { success: false, error: outcome.error, ...(outcome.upstream_status ? { upstream_status: outcome.upstream_status } : {}) },
      outcome.status,
    );
  }

  // Every evaluated attempt is appended to the calibration_attempts telemetry log, then
  // merged into the canonical exemplars table: a verified ALLOW is committed to the
  // commons (completing this agent's earlier BLOCK into one paired row when there is
  // one), and a verified BLOCK is kept as a private orphaned block. `auto_ingested`
  // reports only the public commons write, so it stays false for a BLOCK.
  const willAutoIngest = isAutoIngestEligible(request.value, outcome.body);
  await runInBackground(c, processCalibration(c.env.DB, request.value, outcome.body, null, agentPubkey, ip));

  // On BLOCK, hand the agent concrete compliant precedent for this exact (domain, tool_name)
  // inline in the same response, rather than requiring it to make a second
  // GET /api/v1/exemplars round trip just to find the parameter shape it should retry with.
  const relatedExemplars = outcome.body.allowed
    ? []
    : await fetchRelatedExemplars(c.env.DB, request.value.domain, request.value.tool);

  return c.json({ ...outcome.body, auto_ingested: willAutoIngest, related_exemplars: relatedExemplars });
});

app.notFound((c) => c.json({ success: false, error: "not found" }, 404));

app.onError((error, c) => {
  console.error("ramen-forge unhandled error", error);
  return c.json({ success: false, error: "internal error" }, 500);
});

export { app };
export default app;
