import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ExemplarRow } from "../src/types";
import { sha256Hex } from "@ramen-ai/node-core";

const makeRow = (overrides: Partial<ExemplarRow> = {}): ExemplarRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  domain: "fintech",
  task_fingerprint: "a".repeat(64),
  task_description: "dispatch a wire",
  tool_name: "dispatch_wire",
  violation_rule: "beneficiary verification",
  primary_statutory_anchor: "statutory-anchor",
  steering_directive: "verify the beneficiary before dispatch",
  failed_arguments_json: "{}",
  repaired_arguments_json: JSON.stringify({ beneficiary_verified: true }),
  receipt_id: "22222222-2222-4222-8222-222222222222",
  tier: "community",
  created_at: "2026-10-01T00:00:00.000Z",
  signature: null,
  canonical_payload: null,
  times_applied: 0,
  successful_applications: 0,
  ...overrides,
});

/**
 * Keeps `undefined` apart from "set to empty" so the enrichment CASE WHEN
 * semantics (prefer incoming when it's not a placeholder, else keep stored)
 * can be mirrored in the mock exactly as the real UPSERT_SQL expresses them.
 */
function enrichedExemplarUpsert(rows: ExemplarRow[], binds: unknown[]): { id: string } {
  const [
    exemplarId,
    domain,
    taskFingerprint,
    taskDescription,
    toolName,
    violationRule,
    primaryStatutoryAnchor,
    steeringDirective,
    failedArgumentsJson,
    repairedArgumentsJson,
    receiptId,
    tier,
    createdAt,
    signature,
    canonicalPayload,
  ] = binds as string[];

  const existing = rows.find(
    (row) => row.domain === domain && row.tool_name === toolName && row.task_fingerprint === taskFingerprint && row.violation_rule === violationRule,
  );

  if (!existing) {
    rows.push({
      id: exemplarId,
      domain,
      task_fingerprint: taskFingerprint,
      task_description: taskDescription,
      tool_name: toolName,
      violation_rule: violationRule,
      primary_statutory_anchor: primaryStatutoryAnchor,
      steering_directive: steeringDirective,
      failed_arguments_json: failedArgumentsJson,
      repaired_arguments_json: repairedArgumentsJson,
      receipt_id: receiptId,
      tier: tier as "community" | "enterprise",
      created_at: createdAt,
      signature,
      canonical_payload: canonicalPayload,
      times_applied: 0,
      successful_applications: 0,
    });
    return { id: exemplarId };
  }

  // Mirrors UPSERT_SQL's CASE WHEN (exemplars.<col> is still a placeholder) AND
  // (excluded.<col> is real) THEN excluded.<col> ELSE exemplars.<col> END. The gate is on the
  // EXISTING column, not the incoming one: once a column holds real content, it is locked
  // and no incoming value - however populated - can change it again.
  existing.receipt_id = receiptId;
  existing.signature = signature;
  existing.canonical_payload = canonicalPayload;
  const repairedIsPlaceholder = existing.repaired_arguments_json === "{}" || existing.repaired_arguments_json == null;
  if (repairedIsPlaceholder && repairedArgumentsJson != null && repairedArgumentsJson !== "{}") {
    existing.repaired_arguments_json = repairedArgumentsJson;
  }
  const failedIsPlaceholder = existing.failed_arguments_json === "{}" || existing.failed_arguments_json == null;
  if (failedIsPlaceholder && failedArgumentsJson != null && failedArgumentsJson !== "{}") {
    existing.failed_arguments_json = failedArgumentsJson;
  }
  const steeringIsPlaceholder =
    existing.steering_directive === "Compliant operational blueprint" || existing.steering_directive === "" || existing.steering_directive == null;
  if (steeringIsPlaceholder && steeringDirective != null && steeringDirective !== "" && steeringDirective !== "Compliant operational blueprint") {
    existing.steering_directive = steeringDirective;
  }
  const anchorIsPlaceholder =
    existing.primary_statutory_anchor === "Policy unknown" ||
    existing.primary_statutory_anchor === "Statutory Invariant (Policy unknown)" ||
    existing.primary_statutory_anchor === "" ||
    existing.primary_statutory_anchor == null;
  if (
    anchorIsPlaceholder &&
    primaryStatutoryAnchor != null &&
    primaryStatutoryAnchor !== "" &&
    primaryStatutoryAnchor !== "Policy unknown" &&
    primaryStatutoryAnchor !== "Statutory Invariant (Policy unknown)"
  ) {
    existing.primary_statutory_anchor = primaryStatutoryAnchor;
  }
  return { id: existing.id };
}

function createDb(rows: ExemplarRow[]) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          binds = values;
          queries.push({ sql, binds });
          return statement;
        },
        async all<T>() {
          if (sql.includes("GROUP BY domain")) {
            return {
              results: [
                { domain: "fintech", lesson_count: 2, tools_csv: "dispatch_wire,issue_credit" },
                { domain: "robotics", lesson_count: 1, tools_csv: "dispatch_manipulation" },
              ] as T[],
            };
          }
          let selected = [...rows];
          if (sql.includes("LIKE ?")) {
            const pattern = String(binds.find((value) => typeof value === "string" && value.startsWith("%")) ?? "");
            const query = pattern.slice(1, -1).toLowerCase();
            selected = selected.filter((row) =>
              [row.task_description, row.violation_rule, row.steering_directive].some((value) => value.toLowerCase().includes(query)),
            );
          }
          const limit = Number(binds.at(-2) ?? 10);
          const offset = Number(binds.at(-1) ?? 0);
          return { results: selected.slice(offset, offset + limit) as T[] };
        },
        async first<T>() {
          // calibrate's global-ceiling check and slot reservation both go through
          // .first(), not .batch(). Keep them non-blocking in the mock so the
          // calibrate handler reaches evaluateCalibration() during tests.
          if (sql.includes("global_count")) return { global_count: 0 } as T;
          if (sql.includes("RETURNING request_count")) return { request_count: 1 } as T;
          return null as T | null;
        },
        async run() {
          // autoIngestCompliantBlueprint writes with a single .run(), not a .batch();
          // mirror the real UPSERT_SQL's enrichment/lock semantics so assertions on
          // `rows` after a calibrate call see the same effect a real upsert would have.
          if (sql.includes("ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule)")) {
            enrichedExemplarUpsert(rows, binds);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      const lastQuery = queries.at(-1)?.sql ?? "";
      if (lastQuery.includes("RETURNING request_count")) {
        return [{ results: [] }, { results: [{ request_count: 1 }] }];
      }
      if (lastQuery.includes("RETURNING id")) {
        // Mirrors the handler's batch: [0] is the pre-upsert existence SELECT on the same
        // invariant, [1] is the upsert itself. Check existence before mutating `rows`.
        const upsertBinds = queries.at(-1)?.binds ?? [];
        const [, domain, taskFingerprint, , toolName, violationRule] = upsertBinds as string[];
        const existedBefore = rows.some(
          (row) => row.domain === domain && row.tool_name === toolName && row.task_fingerprint === taskFingerprint && row.violation_rule === violationRule,
        );
        const upserted = enrichedExemplarUpsert(rows, upsertBinds);
        return [{ results: existedBefore ? [{ id: upserted.id }] : [] }, { results: [upserted] }];
      }
      return [{ results: [] }, { results: [] }];
    },
  };
  return { db: db as unknown as D1Database, queries };
}

function envWith(rows: ExemplarRow[] = [makeRow()]): Env {
  return {
    DB: createDb(rows).db,
    FORGE_WRITE_TOKEN: "test-write-token",
    RAMEN_API_KEY: "test-api-key",
    RAMEN_GATEWAY_URL: "https://gateway.example.test",
  };
}

const receiptId = "33333333-3333-4333-8333-333333333333";

function receiptFixture(verdict: 0 | 1 = 1) {
  const canonicalPayload = JSON.stringify({
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id: receiptId,
    verdict,
    policy_id: "industrial_iot_actuation_invariance",
  });
  return {
    id: receiptId,
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    canonical_payload: canonicalPayload,
    signature: btoa("\u0000".repeat(64)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skill and calibration wire contract", () => {
  it("serves the literal ALLOW wire enum in skill.md", async () => {
    const response = await app.request("/skill.md");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"verdict": "ALLOW"');
    expect(text).toContain('"allowed": true');
    expect(text).toContain('verdict === "BLOCK"');
  });
});

describe("self-contained exemplar ingestion", () => {
  it("verifies and stores a complete receipt without upstream network access", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          compliant_arguments: { robot_id: "ROBOHARM-ARM-01", commanded_velocity_mps: 0.05 },
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      exemplar_id: receiptId,
      verdict: 1,
    });
    expect(response.headers.get("RateLimit-Limit")).toBe("30");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an allowed (verdict=1) submission with empty compliant_arguments as MISSING_COMPLIANT_ARGUMENTS", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          compliant_arguments: {},
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("MISSING_COMPLIANT_ARGUMENTS");
    expect(body.error.message).toBe(
      "Exemplar rejected: Allowed blueprints (verdict=1) must provide a populated compliant_arguments dictionary.",
    );
  });

  it("rejects an allowed (verdict=1) submission that omits compliant_arguments entirely", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("MISSING_COMPLIANT_ARGUMENTS");
  });

  it("rejects a signed blocked (verdict=0) receipt as COMPLIANT_BLUEPRINTS_ONLY", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Blocked crucible action",
          receipt: receiptFixture(0),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("COMPLIANT_BLUEPRINTS_ONLY");
    expect(body.error.message).toBe(
      "Exemplar rejected: Community commons accepts strictly verified compliant blueprints (verdict=1). Blocked failure patterns are retained by the internal policy engine.",
    );
  });

  it("rejects an invalid signature as INVALID_CRYPTOGRAPHIC_RECEIPT", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(false);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_CRYPTOGRAPHIC_RECEIPT");
  });

  it("rejects a missing receipt without bearer authentication", async () => {
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", task_description: "Missing receipt" }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_CRYPTOGRAPHIC_RECEIPT");
  });
});

describe("enrichment upsert and immutability lock", () => {
  it("enriches an existing thin row's repaired_arguments_json on resubmission instead of leaving it empty", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "Supervised handling of molten-metal crucible in certified workcell";
    const taskFingerprint = await sha256Hex(taskDescription);

    // Seed the thin row exactly as it exists in production: receipt verified,
    // but both argument columns are still the empty-placeholder "{}".
    const thinRow = makeRow({
      id: receiptId,
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "Statutory Invariant (Policy unknown)",
      steering_directive: "Compliant operational blueprint",
      failed_arguments_json: "{}",
      repaired_arguments_json: "{}",
      receipt_id: receiptId,
    });
    const { db, queries } = createDb([thinRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const richArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
      commanded_force_nm: 10,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool_name: "dispatch_manipulation",
          task_description: taskDescription,
          primary_statutory_anchor: "ISO 10218-1:2025",
          steering_directive: "Ensure certified safety envelope and human-supervised control.",
          compliant_arguments: richArguments,
          receipt: receiptFixture(1),
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, exemplar_id: receiptId, verdict: 1, refreshed: true });

    // The in-memory row the mock upsert enriched must now carry the rich arguments
    // and specific lesson text, in place, with the original row id preserved.
    const enriched = db as unknown as { prepare: unknown };
    expect(thinRow.id).toBe(receiptId);
    expect(JSON.parse(thinRow.repaired_arguments_json)).toEqual(richArguments);
    expect(thinRow.primary_statutory_anchor).toBe("ISO 10218-1:2025");
    expect(thinRow.steering_directive).toBe("Ensure certified safety envelope and human-supervised control.");
    void enriched;
    void queries;
  });

  it("permanently locks repaired_arguments_json once populated, rejecting a later swap attempt", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "Supervised handling of molten-metal crucible in certified workcell";
    const taskFingerprint = await sha256Hex(taskDescription);
    const originalArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
      commanded_force_nm: 10,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    // This row's repaired_arguments_json is already populated with safe, verified
    // parameters -- the state the immutability lock exists to protect.
    const richRow = makeRow({
      id: receiptId,
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "ISO 10218-1:2025",
      steering_directive: "Ensure certified safety envelope and human-supervised control.",
      failed_arguments_json: "{}",
      repaired_arguments_json: JSON.stringify(originalArguments),
      receipt_id: receiptId,
    });
    const { db } = createDb([richRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    // A second authentic receipt for the same invariant, carrying a different
    // (here: malicious) parameter dictionary -- the sabotage vector the lock closes.
    const tamperedArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 5.0,
      commanded_force_nm: 500,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool_name: "dispatch_manipulation",
          task_description: taskDescription,
          primary_statutory_anchor: "ISO 10218-1:2025",
          steering_directive: "Ensure certified safety envelope and human-supervised control.",
          compliant_arguments: tamperedArguments,
          receipt: receiptFixture(1),
        }),
      },
      env,
    );

    // The resubmission itself is still accepted (receipt proof refreshes), but the
    // stored arguments must not change: the lock makes the column write a no-op.
    expect(response.status).toBe(201);
    expect(JSON.parse(richRow.repaired_arguments_json)).toEqual(originalArguments);
    expect(JSON.parse(richRow.repaired_arguments_json)).not.toEqual(tamperedArguments);
  });

  it("does not regress already-specific steering text when a later resubmission omits it", async () => {
    // receiptFixture with no policy_id in the canonical payload resolves receiptMetadata's
    // policyId to "unknown", so an omitted steering_directive / primary_statutory_anchor on
    // this resubmission land on the exact server placeholder strings the upsert guards against.
    const unknownPolicyReceipt = () => {
      const canonicalPayload = JSON.stringify({ schema_version: "5.0", kid: "ramen_pk_v1", id: receiptId, verdict: 1 });
      return { id: receiptId, schema_version: "5.0", kid: "ramen_pk_v1", canonical_payload: canonicalPayload, signature: btoa("\u0000".repeat(64)) };
    };
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "dispatch a wire";
    const taskFingerprint = await sha256Hex(taskDescription);

    const richRow = makeRow({
      id: receiptId,
      domain: "fintech",
      tool_name: "dispatch_wire",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "UCC Article 4A, Section 4A-202",
      steering_directive: "Verify beneficiary sanctions clearance before release.",
      failed_arguments_json: "{}",
      repaired_arguments_json: JSON.stringify({ beneficiary_verified: true, amount_usd: 100 }),
      receipt_id: receiptId,
    });
    const { db } = createDb([richRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    // Still satisfies MISSING_COMPLIANT_ARGUMENTS (non-empty), but omits the
    // specific steering_directive / primary_statutory_anchor this invariant already has.
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "fintech",
          tool_name: "dispatch_wire",
          task_description: taskDescription,
          compliant_arguments: { beneficiary_verified: true },
          receipt: unknownPolicyReceipt(),
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    // The specific anchor and directive already on file are not overwritten by the
    // thinner resubmission's generic server-derived placeholders.
    expect(richRow.primary_statutory_anchor).toBe("UCC Article 4A, Section 4A-202");
    expect(richRow.steering_directive).toBe("Verify beneficiary sanctions clearance before release.");
  });
});

describe("automatic ingestion on successful calibration", () => {
  const calibrateReceiptId = "44444444-4444-4444-8444-444444444444";

  /** Builds an upstream /calibrate response whose receipt.payload_hash matches `input`. */
  async function upstreamEvaluateResponse(input: string, verdict: 0 | 1, extra: Record<string, unknown> = {}) {
    const payloadHash = await sha256Hex(input);
    const canonicalPayload = JSON.stringify({
      schema_version: "5.0",
      kid: "ramen_pk_v1",
      id: calibrateReceiptId,
      verdict,
      payload_hash: payloadHash,
      policy_ids: ["industrial_iot_actuation_invariance"],
    });
    return {
      data: {
        allowed: verdict === 1,
        policy_ids: ["industrial_iot_actuation_invariance"],
        policies_evaluated: 1,
        policies_passed: verdict === 1 ? 1 : 0,
        policies_failed: verdict === 1 ? 0 : 1,
        policies_errored: 0,
        total_violations: [],
        results: [],
        execution_time_ms: 1,
        executed_at: new Date().toISOString(),
        statutory_anchors: ["ISO 10218-1:2025"],
        receipt: {
          id: calibrateReceiptId,
          schema_version: "5.0",
          kid: "ramen_pk_v1",
          signature: btoa("\u0000".repeat(64)),
          canonical_payload: canonicalPayload,
        },
        ...extra,
      },
    };
  }

  function stubUpstreamFetch(responseBody: unknown) {
    return vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  }

  it("auto-ingests the compliant blueprint into D1 with populated arguments and signature on an ALLOW verdict", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
    };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 1));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool: "dispatch_manipulation",
          arguments: candidateArguments,
          task_description: "Supervised handling of identified molten-metal crucible",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.allowed).toBe(true);
    expect(body.auto_ingested).toBe(true);

    // The background write is awaited inline in tests (no real ExecutionContext),
    // so the row is already committed by the time the response is checked.
    expect(rows).toHaveLength(1);
    const stored = rows[0];
    expect(stored.domain).toBe("industrial_iot");
    expect(stored.tool_name).toBe("dispatch_manipulation");
    expect(JSON.parse(stored.repaired_arguments_json)).toEqual(candidateArguments);
    expect(stored.signature).toBe(btoa("\u0000".repeat(64)));
    expect(stored.receipt_id).toBe(calibrateReceiptId.toLowerCase());
    expect(stored.violation_rule).toBe("No violation: compliant reference action");
  });

  it("does not auto-ingest and reports auto_ingested: false on a BLOCK verdict", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { force_sensor: "degraded", stop: "unavailable" };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 0));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowed).toBe(false);
    expect(body.auto_ingested).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("does not auto-ingest an ALLOW verdict with an empty candidate arguments object", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: {} });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 1));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: {} }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowed).toBe(true);
    expect(body.auto_ingested).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("query and domain endpoints", () => {
  const rows = [
    makeRow({ id: "11111111-1111-4111-8111-111111111111", task_description: "alpha wire" }),
    makeRow({ id: "22222222-2222-4222-8222-222222222222", task_description: "beta wire" }),
    makeRow({ id: "33333333-3333-4333-8333-333333333333", task_description: "gamma wire" }),
  ];

  it("supports pagination and keyword search", async () => {
    const page = await app.request("/api/v1/exemplars?limit=1&offset=1", {}, envWith(rows));
    expect(page.status).toBe(200);
    expect((await page.json()).count).toBe(1);

    const search = await app.request("/api/v1/exemplars?q=beta&limit=10", {}, envWith(rows));
    expect(search.status).toBe(200);
    const body = await search.json();
    expect(body.count).toBe(1);
    expect(body.exemplars[0].compliant_arguments).toEqual({ beneficiary_verified: true });
  });

  it("returns active domain counts and distinct tools", async () => {
    const response = await app.request("/api/v1/domains", {}, envWith(rows));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      domains: [
        { domain: "fintech", lesson_count: 2, tools: ["dispatch_wire", "issue_credit"] },
        { domain: "robotics", lesson_count: 1, tools: ["dispatch_manipulation"] },
      ],
    });
  });
});
