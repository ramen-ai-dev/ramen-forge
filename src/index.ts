/**
 * ramen-forge: Level 1 Community Memory Commons.
 *
 * Ingests normalised CorrectionExemplar records from ramen-foundry agents,
 * indexes them by domain, tool, and task fingerprint in D1, and serves them
 * back so agents can avoid known failure modes on their first attempt.
 */
import { Hono, type Context } from "hono";
import { verifyReceipt, type RamenReceipt } from "@ramen-ai/node-core";
import { cors } from "hono/cors";
import {
  DOMAIN_BUNDLES,
  GLOBAL_CALIBRATE_LIMIT_PER_HOUR,
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
import type { CorrectionExemplarInput, CorrectionExemplarRecord, Env, ExemplarRow, JsonObject } from "./types";
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
 * Insert a new lesson, or refresh the receipt of an existing one with the same
 * (domain, tool_name, task_fingerprint, violation_rule) invariant
 * (idx_exemplars_task_invariant, migration 0004).
 *
 * This is an UPSERT (ON CONFLICT ... DO UPDATE), not INSERT OR REPLACE.
 * REPLACE resolves a conflict by deleting the old row, which silently bypasses
 * the append-only trigger from migration 0003 and changes the row's id. The
 * upsert keeps the original row and id and only swaps the receipt columns.
 * A duplicate exemplar_id still raises UNIQUE on the primary key (409).
 */
const UPSERT_SQL =
  "INSERT INTO exemplars (id, domain, task_fingerprint, task_description, tool_name, violation_rule, " +
  "primary_statutory_anchor, steering_directive, failed_arguments_json, repaired_arguments_json, " +
  "receipt_id, tier, created_at, signature, canonical_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule) DO UPDATE SET " +
  "receipt_id = excluded.receipt_id, signature = excluded.signature, canonical_payload = excluded.canonical_payload " +
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
    repaired_arguments: parseStoredObject(row.repaired_arguments_json),
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
  return {
    ...rest,
    failed_arguments: parseStoredObject(failedJson),
    repaired_arguments: parseStoredObject(repairedJson),
  };
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * Bearer-token guard for write endpoints. Fails closed when no token is
 * configured. Both sides are hashed first so the comparison is fixed-length
 * and constant-time.
 */
async function authoriseWrite(c: AppContext): Promise<Response | null> {
  const expected = c.env.FORGE_WRITE_TOKEN;
  if (!expected) {
    return c.json({ success: false, error: "write endpoints disabled: FORGE_WRITE_TOKEN is not configured" }, 503);
  }
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const supplied = match?.[1] ?? "";
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  if (!supplied || !crypto.subtle.timingSafeEqual(a, b)) {
    c.header("WWW-Authenticate", 'Bearer realm="ramen-forge"');
    return c.json({ success: false, error: "unauthorised" }, 401);
  }
  return null;
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

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function evaluationText(record: Record<string, unknown>, keys: string[]): string | null {
  const direct = firstText(record, keys);
  if (direct) return direct;
  for (const key of ["total_violations", "violations", "results"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isPlainObject(entry)) {
        const nested = firstText(entry, keys);
        if (nested) return nested;
        const violations = entry.violations;
        if (Array.isArray(violations)) {
          for (const violation of violations) {
            if (isPlainObject(violation)) {
              const violationText = firstText(violation, keys);
              if (violationText) return violationText;
            }
          }
        }
      }
    }
  }
  return null;
}

function statutoryAnchor(record: Record<string, unknown>, receipt: Record<string, unknown>): string {
  const direct = firstText(record, ["primary_statutory_anchor"]);
  if (direct) return direct;
  for (const value of [record.statutory_anchors, receipt.statutory_anchors]) {
    if (Array.isArray(value)) {
      const anchor = value.find((item): item is string => typeof item === "string" && item.trim() !== "");
      if (anchor) return anchor.trim();
    }
  }
  return "ramen ai statutory policy invariant";
}

function receiptCandidate(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.receipt)) return value.receipt;
  if (isPlainObject(value.ledger_receipt)) return value.ledger_receipt;
  const receipt: Record<string, unknown> = {};
  for (const key of ["id", "schema_version", "kid", "signature", "canonical_payload", "verdict", "statutory_anchors", "attestation"]) {
    if (key in value) receipt[key] = value[key];
  }
  return Object.keys(receipt).length > 0 ? receipt : null;
}

function evaluatedInput(value: Record<string, unknown>): string | null {
  for (const key of ["evaluated_input", "evaluatedInput", "input"]) {
    if (typeof value[key] === "string" && value[key].trim() !== "") return value[key] as string;
  }
  return null;
}

function parseEvaluatedCall(input: string): { tool: string; arguments: JsonObject } | null {
  try {
    const parsed = JSON.parse(input);
    if (!isPlainObject(parsed) || typeof parsed.tool !== "string" || !isPlainObject(parsed.arguments)) return null;
    return { tool: parsed.tool, arguments: parsed.arguments as JsonObject };
  } catch {
    return null;
  }
}

function resolveLedgerReceiptUrl(gatewayUrl: string | undefined, receiptId: string): string {
  const raw = gatewayUrl?.trim() || "https://api.ramenai.dev";
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("RAMEN_GATEWAY_URL must be a plain https origin");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v1/receipts/${encodeURIComponent(receiptId)}`;
}

const LEDGER_RECEIPT_ERROR = {
  code: INVALID_RECEIPT_CODE,
  message: "Receipt ID could not be found or verified on the authoritative ramen ai ledger.",
} as const;

async function pullLedgerExemplar(
  c: AppContext,
  request: Record<string, unknown>,
): Promise<{ ok: true; body: Record<string, unknown>; receipt: Awaited<ReturnType<typeof verifyExemplarReceipt>> } | { ok: false }> {
  const receiptId = request.receipt_id;
  const domain = request.domain;
  const unknownKeys = Object.keys(request).filter((key) => !["receipt_id", "domain", "task_description"].includes(key));
  if (unknownKeys.length > 0) return { ok: false };
  if (typeof receiptId !== "string" || !QUERY_PATTERNS.UUID_RE.test(receiptId)) return { ok: false };
  if (typeof domain !== "string" || !QUERY_PATTERNS.DOMAIN_RE.test(domain)) return { ok: false };
  if ("task_description" in request && typeof request.task_description !== "string") return { ok: false };

  let url: string;
  try {
    url = resolveLedgerReceiptUrl(c.env.RAMEN_GATEWAY_URL, receiptId);
  } catch (error) {
    console.error("ramen-forge invalid ledger gateway URL", error);
    return { ok: false };
  }
  if (!c.env.RAMEN_API_KEY) {
    console.error("ramen-forge ledger pull unavailable: RAMEN_API_KEY is not configured");
    return { ok: false };
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${c.env.RAMEN_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error("ramen-forge ledger pull failed", error);
    return { ok: false };
  }
  if (!upstream.ok) {
    console.error("ramen-forge ledger pull upstream status", upstream.status);
    return { ok: false };
  }

  let upstreamBody: unknown;
  try {
    upstreamBody = await upstream.json();
  } catch (error) {
    console.error("ramen-forge ledger pull returned invalid JSON", error);
    return { ok: false };
  }
  if (!isPlainObject(upstreamBody)) return { ok: false };
  const envelope = isPlainObject(upstreamBody.data) ? { ...upstreamBody, ...upstreamBody.data } : upstreamBody;
  const authoritativeReceipt = receiptCandidate(envelope);
  const input = evaluatedInput(envelope);
  if (!authoritativeReceipt || !input) return { ok: false };

  const receipt = await verifyExemplarReceipt(authoritativeReceipt, { allowBlocked: true });
  if (!receipt.ok) {
    console.error("ramen-forge ledger receipt verification failed", receipt.reason);
    return { ok: false };
  }
  if (receipt.receiptId !== receiptId.toLowerCase()) {
    console.error("ramen-forge ledger receipt id mismatch");
    return { ok: false };
  }
  const authoritativeDomain = firstText(envelope, ["domain"]);
  if (authoritativeDomain && authoritativeDomain !== domain) {
    console.error("ramen-forge ledger domain mismatch");
    return { ok: false };
  }
  const payloadBinding = await verifyReceipt(authoritativeReceipt as unknown as RamenReceipt, input);
  if (!payloadBinding.valid) {
    console.error("ramen-forge ledger payload binding failed", payloadBinding.reason);
    return { ok: false };
  }

  const evaluated = parseEvaluatedCall(input);
  if (!evaluated || !QUERY_PATTERNS.TOOL_NAME_RE.test(evaluated.tool)) return { ok: false };
  const allowed = receipt.verdict === 1;
  const receiptRecord = authoritativeReceipt;
  const taskDescription =
    typeof request.task_description === "string" && request.task_description.trim() !== ""
      ? request.task_description
      : `Authoritative ledger ${allowed ? "compliant reference" : "blocked policy"} for ${evaluated.tool}`;
  const violationReason = allowed
    ? "No violation: compliant reference action"
    : evaluationText(envelope, ["violation_reason", "reasoning", "reason"]) ?? "Policy invariant breach";
  const steeringDirective = allowed
    ? evaluationText(envelope, ["steering_directive", "recovery_instruction", "instruction"]) ?? "Compliant operational blueprint"
    : evaluationText(envelope, ["steering_directive", "recovery_instruction", "instruction"]) ?? "Policy recovery instruction unavailable";
  const createdAt = firstText(envelope, ["executed_at", "created_at"]) ?? new Date().toISOString();

  return {
    ok: true,
    receipt,
    body: {
      exemplar_id: receipt.receiptId,
      domain,
      task_description: taskDescription,
      tool_name: evaluated.tool,
      failed_arguments: allowed ? {} : evaluated.arguments,
      violation_reason: violationReason,
      primary_statutory_anchor: statutoryAnchor(envelope, receiptRecord),
      steering_directive: steeringDirective,
      repaired_arguments: allowed ? evaluated.arguments : {},
      receipt_id: receipt.receiptId,
      created_at: createdAt,
    },
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
  const denied = await authoriseWrite(c);
  if (denied) return denied;

  const parsed = await readJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  let exemplarBody: unknown = body;
  let receipt: Awaited<ReturnType<typeof verifyExemplarReceipt>>;
  const isLedgerRequest =
    isPlainObject(body) &&
    typeof body.receipt_id === "string" &&
    body.receipt === undefined &&
    !("tool_name" in body) &&
    !("exemplar_id" in body);

  if (isLedgerRequest) {
    const pulled = await pullLedgerExemplar(c, body as Record<string, unknown>);
    if (!pulled.ok) return c.json({ success: false, error: LEDGER_RECEIPT_ERROR }, 422);
    exemplarBody = pulled.body;
    receipt = pulled.receipt;
  } else {
    // Receipt first: nothing is validated or stored without an authentic ALLOW receipt.
    receipt = await verifyExemplarReceipt(
      isPlainObject(body) ? body.receipt : undefined,
    );
    if (!receipt.ok) {
      return c.json(
        { success: false, error: { code: INVALID_RECEIPT_CODE, message: INVALID_RECEIPT_MESSAGE }, details: [receipt.reason] },
        422,
      );
    }
  }

  if (!receipt.ok) return c.json({ success: false, error: LEDGER_RECEIPT_ERROR }, 422);
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
    return c.json({ success: true, exemplar_id: storedId, refreshed: true }, 200);
  }
  return c.json({ success: true, exemplar_id: storedId }, 201);
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

export default app;
