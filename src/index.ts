/**
 * ramen-forge: Level 1 Community Memory Commons.
 *
 * Ingests normalised CorrectionExemplar records from ramen-foundry agents,
 * indexes them by domain, tool, and task fingerprint in D1, and serves them
 * back so agents can avoid known failure modes on their first attempt.
 */
import { Hono, type Context } from "hono";
import { renderConsole } from "./console";
import { SEED_BANK } from "./seed";
import type { CorrectionExemplarInput, CorrectionExemplarRecord, Env, ExemplarRow } from "./types";
import { MAX_BODY_BYTES, QUERY_PATTERNS, parseStoredObject, validateExemplar } from "./validation";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const COMMUNITY_TIER = "community";

const INSERT_SQL =
  "INSERT INTO exemplars (id, domain, task_fingerprint, task_description, tool_name, violation_rule, " +
  "primary_statutory_anchor, steering_directive, failed_arguments_json, repaired_arguments_json, " +
  "receipt_id, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

function bindExemplar(db: D1Database, sql: string, exemplar: CorrectionExemplarInput): D1PreparedStatement {
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
    );
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

async function readJsonBody(c: AppContext): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: c.json({ success: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413) };
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: c.json({ success: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: c.json({ success: false, error: "body must be valid JSON" }, 400) };
  }
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

app.post("/api/v1/exemplars", async (c) => {
  const denied = await authoriseWrite(c);
  if (denied) return denied;

  const parsed = await readJsonBody(c);
  if (!parsed.ok) return parsed.response;

  const result = await validateExemplar(parsed.body);
  if (!result.ok) {
    return c.json({ success: false, error: "exemplar rejected", details: result.errors }, 422);
  }

  try {
    await bindExemplar(c.env.DB, INSERT_SQL, result.value).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return c.json({ success: false, error: `exemplar_id already recorded: ${result.value.exemplar_id}` }, 409);
    }
    throw error;
  }
  return c.json({ success: true, exemplar_id: result.value.exemplar_id }, 201);
});

app.get("/api/v1/exemplars", async (c) => {
  const { domain, tool_name: toolName, task_fingerprint: taskFingerprint, limit: rawLimit } = c.req.query();
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

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_LIMIT) {
      errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }
  if (errors.length > 0) {
    return c.json({ success: false, error: "invalid query", details: errors }, 400);
  }

  const sql =
    "SELECT * FROM exemplars" +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC, rowid DESC LIMIT ?";
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params, limit)
    .all<ExemplarRow>();

  const exemplars = results.map(toRecord);
  return c.json({ success: true, count: exemplars.length, exemplars });
});

app.get("/api/v1/stats", async (c) => {
  const [totals, domains] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS total, COUNT(receipt_id) AS receipted, COUNT(DISTINCT domain) AS domains " +
        "FROM exemplars WHERE tier = ?",
    ).bind(COMMUNITY_TIER),
    c.env.DB.prepare(
      "SELECT domain, COUNT(*) AS exemplars FROM exemplars WHERE tier = ? GROUP BY domain ORDER BY exemplars DESC, domain",
    ).bind(COMMUNITY_TIER),
  ]);
  const row = totals?.results[0] ?? {};
  const total = Number(row.total ?? 0);
  const receipted = Number(row.receipted ?? 0);
  return c.json({
    success: true,
    total_community_exemplars: total,
    active_domains: Number(row.domains ?? 0),
    receipt_verified_exemplars: receipted,
    recovery_rate: total === 0 ? 0 : receipted / total,
    domains: (domains?.results ?? []).map((d) => ({ domain: String(d.domain), exemplars: Number(d.exemplars) })),
  });
});

app.post("/api/v1/seed", async (c) => {
  const denied = await authoriseWrite(c);
  if (denied) return denied;

  // Seeds go through the same validator as community contributions.
  const validated: CorrectionExemplarInput[] = [];
  for (const seed of SEED_BANK) {
    const result = await validateExemplar(seed);
    if (!result.ok) {
      throw new Error(`seed ${seed.exemplar_id} failed validation: ${result.errors.join("; ")}`);
    }
    validated.push(result.value);
  }

  const insertOrIgnore = INSERT_SQL.replace(/^INSERT INTO/, "INSERT OR IGNORE INTO");
  const results = await c.env.DB.batch(validated.map((exemplar) => bindExemplar(c.env.DB, insertOrIgnore, exemplar)));
  const inserted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);

  return c.json({
    success: true,
    inserted,
    skipped: validated.length - inserted,
    seed_bank_size: validated.length,
    exemplar_ids: validated.map((e) => e.exemplar_id),
  });
});

app.notFound((c) => c.json({ success: false, error: "not found" }, 404));

app.onError((error, c) => {
  console.error("ramen-forge unhandled error", error);
  return c.json({ success: false, error: "internal error" }, 500);
});

export default app;
