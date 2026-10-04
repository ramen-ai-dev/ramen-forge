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
} from "./calibrate";
import { renderConsole } from "./console";
import { INVALID_RECEIPT_CODE, INVALID_RECEIPT_MESSAGE, verifyExemplarReceipt } from "./receipt";
import { SKILL_MD } from "./skill";
import type { CorrectionExemplarInput, CorrectionExemplarRecord, Env, ExemplarRow } from "./types";
import {
  MAX_BODY_BYTES,
  MAX_CALIBRATE_BODY_BYTES,
  QUERY_PATTERNS,
  checkSearchTerm,
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
 * Insert a new lesson, or enrich an existing one with the same
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
 * only overwrite the stored value when the incoming one is more informative than
 * both an empty placeholder and the server's own generic default, otherwise the
 * existing value is kept. This lets a later, richer resubmission for the same
 * invariant heal a thin or empty row (e.g. a submission that initially omitted
 * compliant_arguments) without letting a later thin resubmission regress a row
 * that already has good content.
 *
 * A duplicate exemplar_id still raises UNIQUE on the primary key (409).
 */
const UPSERT_SQL =
  "INSERT INTO exemplars (id, domain, task_fingerprint, task_description, tool_name, violation_rule, " +
  "primary_statutory_anchor, steering_directive, failed_arguments_json, repaired_arguments_json, " +
  "receipt_id, tier, created_at, signature, canonical_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule) DO UPDATE SET " +
  "receipt_id = excluded.receipt_id, " +
  "signature = excluded.signature, " +
  "canonical_payload = excluded.canonical_payload, " +
  "repaired_arguments_json = CASE " +
  "WHEN excluded.repaired_arguments_json IS NOT NULL AND excluded.repaired_arguments_json != '{}' " +
  "THEN excluded.repaired_arguments_json ELSE exemplars.repaired_arguments_json END, " +
  "failed_arguments_json = CASE " +
  "WHEN excluded.failed_arguments_json IS NOT NULL AND excluded.failed_arguments_json != '{}' " +
  "THEN excluded.failed_arguments_json ELSE exemplars.failed_arguments_json END, " +
  "steering_directive = CASE " +
  "WHEN excluded.steering_directive IS NOT NULL AND excluded.steering_directive != '' " +
  "AND excluded.steering_directive != 'Compliant operational blueprint' " +
  "THEN excluded.steering_directive ELSE exemplars.steering_directive END, " +
  "primary_statutory_anchor = CASE " +
  "WHEN excluded.primary_statutory_anchor IS NOT NULL AND excluded.primary_statutory_anchor != '' " +
  "AND excluded.primary_statutory_anchor != 'Policy unknown' " +
  "AND excluded.primary_statutory_anchor NOT LIKE 'Statutory Invariant (Policy unknown)' " +
  "THEN excluded.primary_statutory_anchor ELSE exemplars.primary_statutory_anchor END " +
  "RETURNING id";

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// Public API: any origin may read. Writes still require a bearer token, which
// browsers never attach automatically, so a wildcard origin adds no CSRF risk.
app.use(
  "/api/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept"],
    exposeHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
    maxAge: 86400,
  }),
);

interface VerifiedReceiptFields {
  signature: string;
  canonicalPayload: string;
}

function bindExemplar(db: D1Database, exemplar: CorrectionExemplarInput, receipt: VerifiedReceiptFields): D1PreparedStatement {
  return db
    .prepare(UPSERT_SQL)
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
    );
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
  const { failed_arguments_json: failedJson, repaired_arguments_json: repairedJson, ...rest } = row;
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
  const receipt = await verifyExemplarReceipt(isPlainObject(body) ? body.receipt : undefined, { allowBlocked: true });
  if (!receipt.ok) {
    return c.json(
      { success: false, error: { code: INVALID_RECEIPT_CODE, message: INVALID_RECEIPT_MESSAGE }, details: [receipt.reason] },
      422,
    );
  }

  const metadata = receiptMetadata(receipt);
  const request = isPlainObject(body) ? body : {};
  const signedVerdict = receipt.verdict;

  // Allowed blueprints (verdict=1) exist to be copied: an empty compliant_arguments
  // dictionary stores a lesson with nothing to apply. Require it populated up front,
  // before the generic validator (which treats {} as a structurally valid object).
  if (signedVerdict === 1) {
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
  const where: string[] = [];
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

  const sql =
    "SELECT * FROM exemplars" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?";
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

const MAX_FEEDBACK_BODY_BYTES = 1024;

app.get("/api/v1/exemplars/:id", async (c) => {
  const id = c.req.param("id");
  if (!QUERY_PATTERNS.UUID_RE.test(id)) {
    // A non-UUID can never match a stored id; answer as not found rather than hit D1.
    return c.json({ success: false, error: "Exemplar not found" }, 404);
  }
  const row = await c.env.DB.prepare("SELECT * FROM exemplars WHERE id = ?1").bind(id).first<ExemplarRow>();
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
      "FROM exemplars GROUP BY domain ORDER BY domain",
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
        "COUNT(DISTINCT primary_statutory_anchor) AS anchor_count FROM exemplars WHERE tier = ?",
    ).bind(COMMUNITY_TIER),
    c.env.DB.prepare(
      "SELECT domain, COUNT(*) AS exemplars FROM exemplars WHERE tier = ? GROUP BY domain ORDER BY exemplars DESC, domain",
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

  const outcome = await evaluateCalibration(apiKey, request.value, bundleId, evaluateUrl);
  if (!outcome.ok) {
    return c.json(
      { success: false, error: outcome.error, ...(outcome.upstream_status ? { upstream_status: outcome.upstream_status } : {}) },
      outcome.status,
    );
  }
  return c.json(outcome.body);
});

app.notFound((c) => c.json({ success: false, error: "not found" }, 404));

app.onError((error, c) => {
  console.error("ramen-forge unhandled error", error);
  return c.json({ success: false, error: "internal error" }, 500);
});

export { app };
export default app;
